"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert/strict");
const {createFixture}=require("./helpers/financial-fixture"),{check}=require("./helpers/check");
(async()=>{
 const f=await createFixture();
 try{
  const c=(await f.createCustomer("Original",200)).json.customer;
  const b=await f.createBill("Original",[{medicineName:"Test",quantity:1,sellPrice:100}]);
  await f.request("customers","POST",{body:{id:c.id,name:"Renamed",originalName:"Original",phone:"",operationId:f.operationId()}});
  const dir=path.join(__dirname,"../supabase/migrations"),name=fs.readdirSync(dir).find(n=>n.endsWith("_atomic_billing_ledger.sql")),sql=fs.readFileSync(path.join(dir,name),"utf8");
  await f.pg.exec(sql);
  check("reapplying migration does not recreate a renamed historical profile",(await f.pg.query("SELECT count(*)::int n FROM customers")).rows[0].n,1);
  check("reapplying migration preserves stable historical name alias",(await f.customer("Original")).id,c.id);
  check("reapplying migration preserves opening and account debt",[(await f.customer("Renamed")).openingBalance,(await f.customer("Renamed")).balance],[200,300]);
  await f.pg.query("DELETE FROM bill_items WHERE bill_id=$1",[b.json.bill.id]);
  await assert.rejects(f.pg.exec(sql),/discrepancies need reconciliation/);console.log("PASS migration refuses existing orphan charges rather than guessing a repair");
  await f.pg.exec("ROLLBACK");
  check("failed preflight leaves original charge unchanged",(await f.customer("Renamed")).balance,300);
 }finally{await f.close();}
})().catch(e=>{console.error("FAIL",e);process.exitCode=1;});
