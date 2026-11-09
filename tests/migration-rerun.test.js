const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createFixture} = require('./helpers/financial-fixture');
function check(label, actual, expected) { assert.deepEqual(actual, expected, label); console.log('PASS ' + label); }
(async () => {
  const f = await createFixture();
  try {
    await f.createCustomer('Alice', 200);
    await f.createBill('Alice', [{medicineName:'Test',quantity:1,sellPrice:100}], {amountReceived:20});
    const original = await f.customer('Alice');
    const renamed = await f.request('customers','POST',{body:{id:original.id,originalName:'Alice',name:'Alice Renamed',phone:'',operationId:f.operationId()}});
    check('rename succeeds before migration rerun', renamed.status, 200);
    const before = (await f.pg.query('SELECT count(*)::int AS n FROM public.customers')).rows[0].n;
    const file = fs.readdirSync(path.join(__dirname,'../supabase/migrations')).find(x=>x.endsWith('_atomic_billing_ledger.sql'));
    const sql = fs.readFileSync(path.join(__dirname,'../supabase/migrations',file),'utf8');
    await f.pg.exec(sql);
    const current = await f.customer('Alice Renamed');
    check('rerun preserves stable renamed identity', current.id, original.id);
    check('rerun does not resurrect historical name as a duplicate profile', (await f.pg.query('SELECT count(*)::int AS n FROM public.customers')).rows[0].n, before);
    check('rerun preserves opening and account money', [Number(current.openingBalance),Number(current.balance)], [200,280]);
    check('historical issued name stays unchanged', (await f.pg.query('SELECT customer_name FROM public.bills')).rows[0].customer_name, 'Alice');
    await f.pg.exec("INSERT INTO public.bills(bill_number,customer_name,created_by,subtotal,grand_total) VALUES('INVALID-ORPHAN','Alice','fixture',100,100)");
    await assert.rejects(f.pg.exec(sql), /invoice\/item discrepancies/);
    await f.pg.exec('ROLLBACK');
    check('failed preflight leaves existing anchor intact', Number((await f.customer('Alice Renamed')).openingBalance), 200);
  } finally { await f.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
