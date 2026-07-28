/** Exercises the repo's api/bills.js + api/customers.js against a fake Supabase. */
const path = require("path");
const Module = require("module");

const PROJECT = path.resolve(__dirname, "..");
const real = require(path.join(PROJECT, "lib/supabase-server.js"));

const db = { bills: [], bill_items: [], payments: [], customers: [], medicines: [] };
let seq = 0;
const uid = (p) => `${p}-${++seq}`;

function parseQuery(pathStr) {
  const [table, qs] = pathStr.split("?");
  return { table, params: new URLSearchParams(qs || "") };
}

function matches(row, params) {
  for (const [key, raw] of params.entries()) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(key)) continue;
    if (raw.startsWith("eq.")) {
      if (String(row[key]) !== raw.slice(3)) return false;
    } else if (raw.startsWith("like.")) {
      if (!String(row[key] || "").startsWith(raw.slice(5).replace(/\*/g, ""))) return false;
    } else if (raw.startsWith("in.(")) {
      if (!raw.slice(4, -1).split(",").map(decodeURIComponent).includes(String(row[key]))) return false;
    } else if (raw === "not.is.null") {
      if (row[key] === null || row[key] === undefined) return false;
    }
  }
  return true;
}

const fake = {
  ...real,
  getServerConfig: () => ({
    enabled: true, projectUrl: "https://fake", anonKey: "a", serviceRoleKey: "s",
    tableName: "medicines", roleTable: "user_roles", adminEmails: ["admin@test"],
  }),
  requireAuthContext: async () => ({ user: { id: "u1", email: "admin@test", role: "admin" } }),
  callSupabaseRest: async (config, pathStr, options = {}) => {
    const { table, params } = parseQuery(pathStr);
    const rows = db[table];
    if (!rows) throw new Error("unknown table " + table);
    const method = options.method || "GET";

    if (method === "GET") {
      let out = rows.filter((r) => matches(r, params));
      const offset = parseInt(params.get("offset") || "0", 10);
      const limit = parseInt(params.get("limit") || "100000", 10);
      const order = params.get("order") || "";
      if (order) {
        const [col, dir] = order.split(".");
        out = out.slice().sort((a, b) => {
          const av = a[col], bv = b[col];
          const c = String(av ?? "").localeCompare(String(bv ?? ""));
          return dir === "desc" ? -c : c;
        });
      }
      return out.slice(offset, offset + limit);
    }

    if (method === "POST") {
      const body = Array.isArray(options.body) ? options.body : [options.body];
      const conflict = params.get("on_conflict");
      const merge = /merge-duplicates/.test(options.prefer || "");
      const out = [];
      for (const b of body) {
        if (conflict && merge) {
          const existing = rows.find((r) => String(r[conflict]) === String(b[conflict]));
          if (existing) { Object.assign(existing, b); out.push(existing); continue; }
        }
        const row = { id: uid(table), created_at: new Date().toISOString(), ...b };
        rows.push(row); out.push(row);
      }
      return out;
    }

    if (method === "PATCH") {
      const t = rows.filter((r) => matches(r, params));
      t.forEach((r) => Object.assign(r, options.body));
      return t;
    }

    if (method === "DELETE") {
      const removed = rows.filter((r) => matches(r, params));
      db[table] = rows.filter((r) => !matches(r, params));
      return removed;
    }
    throw new Error("unhandled " + method);
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (/supabase-server$/.test(request)) return fake;
  return origLoad.apply(this, arguments);
};

const billsApi = require(path.join(PROJECT, "api/bills.js"));
const customersApi = require(path.join(PROJECT, "api/customers.js"));

function invoke(fn, method, { query = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = { method, query, body, headers: {} };
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(t) { resolve({ status: this.statusCode, json: JSON.parse(t || "{}") }); },
    };
    fn(req, res);
  });
}
const bills = (m, o) => invoke(billsApi, m, o);
const custs = (m, o) => invoke(customersApi, m, o);

let fails = 0;
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

const item = (qty, price) => ([{ medicineName: "Paracetamol", sellPrice: price, quantity: qty }]);

(async () => {
  console.log("--- bill 1: Ramesh ₹300, pays ₹100 ---");
  let r = await bills("POST", {
    body: { customerName: "Ramesh", customerPhone: "98765", previousBalance: 0,
            amountReceived: 100, items: item(30, 10) },
  });
  eq("grand_total", r.json.bill.grand_total, 300);
  eq("previous_balance stored", r.json.bill.previous_balance, 0);
  eq("amount_received stored", r.json.bill.amount_received, 100);
  eq("balance_due stored", r.json.bill.balance_due, 200);

  console.log("\n--- customer list derives the balance ---");
  r = await custs("GET");
  let ramesh = r.json.customers.find((c) => c.name === "Ramesh");
  eq("derived balance", ramesh.balance, 200);
  eq("bill counted", ramesh.billCount, 1);
  eq("implicit entry flagged", ramesh.unsaved, true);

  console.log("\n--- saving the customer keeps the derived balance ---");
  await custs("POST", { body: { name: "Ramesh", phone: "98765" } });
  r = await custs("GET");
  ramesh = r.json.customers.find((c) => c.name === "Ramesh");
  eq("still 200 after saving", ramesh.balance, 200);
  eq("no longer implicit", ramesh.unsaved, undefined);

  console.log("\n--- bill 2 carries 200 forward, pays nothing ---");
  r = await bills("POST", {
    body: { customerName: "Ramesh", customerPhone: "98765", previousBalance: 200,
            amountReceived: 0, items: item(15, 10) },
  });
  eq("balance_due = 200 + 150", r.json.bill.balance_due, 350);
  r = await custs("GET");
  eq("derived balance 350", r.json.customers.find((c) => c.name === "Ramesh").balance, 350);

  console.log("\n--- a standalone payment of 150 ---");
  db.payments.push({ id: uid("pay"), customer_name: "Ramesh", amount: 150,
                     created_at: new Date().toISOString() });
  r = await custs("GET");
  eq("payment subtracted once, not twice",
     r.json.customers.find((c) => c.name === "Ramesh").balance, 200);

  console.log("\n--- opening balance is the anchor ---");
  await custs("POST", { body: { name: "Sita", phone: "777", openingBalance: 500 } });
  r = await custs("GET");
  eq("opening only", r.json.customers.find((c) => c.name === "Sita").balance, 500);

  await bills("POST", {
    body: { customerName: "Sita", customerPhone: "777", previousBalance: 500,
            amountReceived: 200, items: item(10, 10) },
  });
  r = await custs("GET");
  eq("500 + 100 - 200", r.json.customers.find((c) => c.name === "Sita").balance, 400);

  console.log("\n--- a plain phone edit must not wipe the opening balance ---");
  await custs("POST", { body: { name: "Sita", phone: "888" } });
  r = await custs("GET");
  let sita = r.json.customers.find((c) => c.name === "Sita");
  eq("opening balance survives", sita.openingBalance, 500);
  eq("phone updated", sita.phone, "888");
  eq("balance unchanged", sita.balance, 400);

  console.log("\n--- name matching is case/space insensitive ---");
  await bills("POST", {
    body: { customerName: "  sita  ", previousBalance: 400, amountReceived: 0,
            items: item(5, 10) },
  });
  r = await custs("GET");
  const sitas = r.json.customers.filter((c) => c.name.toLowerCase().trim() === "sita");
  eq("still one Sita", sitas.length, 1);
  eq("balance 400 + 50", sitas[0].balance, 450);

  console.log("\n--- bulk ledger repair rewrites snapshots ---");
  const rBills = db.bills.filter((b) => b.customer_name === "Ramesh");
  r = await bills("PUT", {
    body: { ledgerUpdates: [
      { id: rBills[0].id, previousBalance: 0,  amountReceived: 100, grandTotal: 300 },
      { id: rBills[1].id, previousBalance: 200, amountReceived: 50, grandTotal: 150 },
    ] },
  });
  eq("two bills updated", r.json.updated, 2);
  eq("second bill received rewritten", rBills[1].amount_received, 50);
  eq("second bill balance_due recomputed", rBills[1].balance_due, 300);
  r = await custs("GET");
  eq("repair flows into the derived balance",
     r.json.customers.find((c) => c.name === "Ramesh").balance, 150);

  console.log("\n--- editing a bill updates its stored ledger ---");
  await bills("PUT", {
    body: { id: rBills[0].id, customerName: "Ramesh", previousBalance: 0,
            amountReceived: 300, items: item(30, 10) },
  });
  eq("received updated to 300", rBills[0].amount_received, 300);
  r = await custs("GET");
  eq("balance drops by the extra 200",
     r.json.customers.find((c) => c.name === "Ramesh").balance, -50);

  console.log("\n--- deleting a bill removes it from the balance ---");
  await bills("DELETE", { query: { id: rBills[1].id } });
  r = await custs("GET");
  eq("only bill 1 left: 300 - 300 - 150 payment",
     r.json.customers.find((c) => c.name === "Ramesh").balance, -150);

  console.log("\n--- bulk import of legacy localStorage balances ---");
  r = await custs("PUT", {
    body: { customers: [
      { name: "Old Customer", phone: "111", openingBalance: 1200 },
      { name: "old customer", phone: "111", openingBalance: 999 }, // dupe, ignored
    ] },
  });
  eq("deduped on import", r.json.imported, 1);
  r = await custs("GET");
  eq("imported opening balance",
     r.json.customers.find((c) => c.name === "Old Customer").balance, 1200);

  console.log("\n--- a new customer's opening balance is not lost ---");
  // Mirrors the billing page: customer created with an opening balance at the
  // same moment as their first bill.
  await custs("POST", { body: { name: "Newcomer", phone: "555", openingBalance: 800 } });
  await bills("POST", { body: { customerName: "Newcomer", customerPhone: "555",
    previousBalance: 800, amountReceived: 100, items: item(20, 10) } });
  r = await custs("GET");
  const nc = r.json.customers.find((c) => c.name === "Newcomer");
  eq("opening balance stored", nc.openingBalance, 800);
  eq("balance = 800 + 200 - 100", nc.balance, 900);

  console.log("\n--- re-saving a bill must not add it a second time ---");
  // The billing page used to advance the customer's balance after each save
  // and feed that back into the still-open bill, so the bill's own amount was
  // counted twice — on screen, and again on the next save.
  await custs("POST", { body: { name: "Vijay", phone: "222", openingBalance: 0 } });
  r = await bills("POST", { body: { customerName: "Vijay", previousBalance: 0,
    amountReceived: 0, items: item(10, 10) } });
  const vBill = r.json.bill.id;
  r = await custs("GET");
  eq("after the first save", r.json.customers.find((c) => c.name === "Vijay").balance, 100);

  // Re-save with no changes: previousBalance is still this bill's own prev (0).
  await bills("PUT", { body: { id: vBill, customerName: "Vijay",
    previousBalance: 0, amountReceived: 0, items: item(10, 10) } });
  r = await custs("GET");
  eq("re-save leaves it at 100", r.json.customers.find((c) => c.name === "Vijay").balance, 100);
  eq("bill's previous_balance not inflated",
     db.bills.find((b) => b.id === vBill).previous_balance, 0);

  // Adding a medicine on an edit adds only that medicine.
  await bills("PUT", { body: { id: vBill, customerName: "Vijay",
    previousBalance: 0, amountReceived: 0,
    items: [{ medicineName: "Paracetamol", sellPrice: 10, quantity: 10 },
            { medicineName: "Crocin", sellPrice: 10, quantity: 5 }] } });
  r = await custs("GET");
  eq("edit adds 50, not 150", r.json.customers.find((c) => c.name === "Vijay").balance, 150);

  console.log("\n--- validation ---");
  eq("rejects nameless customer", (await custs("POST", { body: { name: "" } })).status, 400);
  eq("rejects empty import", (await custs("PUT", { body: { customers: [] } })).status, 400);

  console.log(`\n${fails === 0 ? "ALL TESTS PASSED" : fails + " TEST(S) FAILED"}`);
  process.exit(fails ? 1 : 0);
})();
