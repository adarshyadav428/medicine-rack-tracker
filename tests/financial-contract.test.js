"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createFixture } = require("./helpers/financial-fixture");

function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  console.log("PASS " + label);
}

(async () => {
  // The shared setup applies the source prerequisites and staged migration to
  // ephemeral PostgreSQL. These checks call the actual RPCs directly, rather
  // than reproducing their arithmetic or mocking transaction behavior.
  const fixture = await createFixture();
  const pg = fixture.pg;
  const actor = "contract-admin@example.test";
  const rpc = async (action, data, by = actor) => (await pg.query(
    "SELECT public.billing_mutate($1,$2::jsonb,$3) AS result", [action, JSON.stringify(data), by]
  )).rows[0].result;
  const read = async request => (await pg.query(
    "SELECT public.billing_read($1::jsonb) AS result", [JSON.stringify(request)]
  )).rows[0].result;
  const item = (price, extra = {}) => [{ medicineName: "Contract medicine", quantity: 1, sellPrice: price, ...extra }];
  try {
    await pg.exec("SET ROLE service_role");
    const account = (await rpc("customer_save", { operationId: randomUUID(), name: "Ramesh", openingBalance: 200 })).customer;
    const customerId = account.id;
    const balance = async () => (await read({ kind: "customers", customerId })).customers[0].balance;
    check("SQL preserves the initial customer anchor", await balance(), 200);

    const firstRequest = { operationId: randomUUID(), customerId, customerName: "Ramesh", previousBalance: 200, expectedBalance: 200, items: item(1000), amountReceived: 300 };
    const first = await rpc("bill_create", firstRequest);
    check("SQL bill receipt leaves 900 due", await balance(), 900);
    const receiptRequest = { operationId: randomUUID(), customerId, customerName: "Ramesh", amount: 200 };
    const receipt = await rpc("payment_create", receiptRequest);
    check("SQL standalone receipt consolidates to 700", await balance(), 700);
    const second = await rpc("bill_create", { operationId: randomUUID(), customerId, customerName: "Ramesh", previousBalance: 700, expectedBalance: 700, items: item(400), amountReceived: 100 });
    check("SQL next bill carries the consolidated 700", second.bill.previous_balance, 700);
    check("SQL complete normative sequence ends at 1000", await balance(), 1000);

    const replay = await rpc("payment_create", receiptRequest);
    check("receipt replay returns the original receipt", replay.payment.id, receipt.payment.id);
    check("receipt replay after later activity does not deduct twice", await balance(), 1000);
    check("only one standalone receipt exists", (await pg.query("SELECT count(*)::int AS n FROM public.payments WHERE customer_id=$1", [customerId])).rows[0].n, 1);
    await assert.rejects(rpc("payment_create", { ...receiptRequest, amount: 201 }), /BILLING_OPERATION_REUSED/);
    console.log("PASS changed-payload operation reuse is rejected");
    await assert.rejects(rpc("payment_create", receiptRequest, "another-admin@example.test"), /BILLING_OPERATION_REUSED/);
    console.log("PASS another actor cannot reuse the same financial operation ID");

    const before = (await pg.query("SELECT to_jsonb(b) AS bill FROM public.bills b WHERE id=$1", [first.bill.id])).rows[0].bill;
    const invalidEdit = { ...firstRequest, operationId: randomUUID(), id: first.bill.id, expectedUpdatedAt: first.bill.updated_at, expectedVersion: first.bill.version, items: item(900, { mrp: 1000000000 }) };
    await assert.rejects(rpc("bill_update", invalidEdit), /BILLING_INVALID/);
    const after = (await pg.query("SELECT to_jsonb(b) AS bill FROM public.bills b WHERE id=$1", [first.bill.id])).rows[0].bill;
    check("invalid replacement item rolls back the complete bill header", after, before);
    check("invalid replacement leaves original line items intact", (await pg.query("SELECT line_total::text AS total FROM public.bill_items WHERE bill_id=$1", [first.bill.id])).rows.map(row => row.total), ["1000.00"]);
    check("failed replacement does not alter the account debt", await balance(), 1000);
    check("failed mutations do not enter the committed operation log", (await pg.query("SELECT count(*)::int AS n FROM public.billing_operations WHERE operation_id=$1", [invalidEdit.operationId])).rows[0].n, 0);

    const editRequest = { ...firstRequest, operationId: randomUUID(), id: first.bill.id, expectedUpdatedAt: first.bill.updated_at, expectedVersion: first.bill.version, notes: "Only notes changed" };
    const edited = await rpc("bill_update", editRequest);
    const editReplay = await rpc("bill_update", editRequest);
    check("update replay precedes its now-stale version precondition", editReplay.bill.updated_at, edited.bill.updated_at);
    check("notes-only update/replay preserves account debt", await balance(), 1000);

    const newAccountBill = await rpc("bill_create", { operationId: randomUUID(), customerName: "New opening account", initialOpeningBalance: 200, previousBalance: 200, expectedBalance: 200, items: item(100), amountReceived: 0 });
    check("new customer anchor and bill commit together", newAccountBill.customer.balance, 300);
    check("new customer opening remains an authoritative anchor", newAccountBill.customer.openingBalance, 200);
    await assert.rejects(rpc("bill_create", { operationId: randomUUID(), customerName: "Failed new account", initialOpeningBalance: 200, previousBalance: 200, expectedBalance: 200, items: item(100, { mrp: 1000000000 }), amountReceived: 0 }), /BILLING_INVALID/);
    check("failed first bill does not leave a customer/anchor behind", (await pg.query("SELECT count(*)::int AS n FROM public.customers WHERE name='Failed new account'")).rows[0].n, 0);
    check("failed first bill does not leave a name alias behind", (await pg.query("SELECT count(*)::int AS n FROM public.billing_customer_aliases WHERE name_key='failed new account'")).rows[0].n, 0);

    const archived = await rpc("customer_archive", { operationId: randomUUID(), id: customerId });
    check("archiving a profile preserves its opening anchor and debt", [archived.customer.openingBalance, archived.customer.balance], [200, 1000]);
    check("archived account remains inspectable with its actual balance", (await read({ kind: "customers", customerId, includeArchived: true })).customers[0].balance, 1000);
    await assert.rejects(rpc("payment_create", { ...receiptRequest, operationId: randomUUID() }), /BILLING_ARCHIVED/);
    console.log("PASS archived account requires explicit restoration before more receipts");

    await pg.exec("RESET ROLE");
    for (const role of ["anon", "authenticated"]) {
      await pg.exec("SET ROLE " + role);
      await assert.rejects(read({ kind: "customers" }), error => error.code === "42501");
      console.log("PASS " + role + " cannot execute financial read RPC");
      await assert.rejects(rpc("customer_save", { operationId: randomUUID(), name: "Unauthorized" }), error => error.code === "42501");
      console.log("PASS " + role + " cannot execute financial mutation RPC");
      await pg.exec("RESET ROLE");
    }
    check("service_role retains RPC execution", (await pg.query("SELECT has_function_privilege('service_role','public.billing_mutate(text,jsonb,text)','EXECUTE') AS allowed")).rows[0].allowed, true);
    check("browser role cannot directly insert financial rows", (await pg.query("SELECT has_table_privilege('authenticated','public.bills','INSERT') AS allowed")).rows[0].allowed, false);
  } finally {
    await pg.exec("RESET ROLE");
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
