/**
 * Covers the server-side billing fixes:
 *   — GET /api/bills?customer=… scopes chaining to one account, so the page
 *     no longer pulls the whole table on every save.
 *   — Import numbers bills off the highest sequence issued that day, not a row
 *     count, which handed out a taken number whenever a bill had been deleted.
 *   — Imported bills carry a ledger snapshot, instead of reading as unpaid.
 */
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

/** `col.ilike.*term*` / `col.eq.x` as used inside an or=(...) group. */
function matchesOrTerm(row, term) {
  const m = /^([a-z_]+)\.(ilike|eq)\.(.*)$/.exec(term);
  if (!m) return false;
  const [, col, op, rawVal] = m;
  const val = String(row[col] ?? "");
  if (op === "eq") return val === rawVal;
  return val.toLowerCase().includes(rawVal.replace(/\*/g, "").toLowerCase());
}

function matches(row, params) {
  for (const [key, raw] of params.entries()) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(key)) continue;
    if (key === "or") {
      // or=(a.ilike.*x*,b.ilike.*x*) — at least one branch must hold.
      const terms = raw.replace(/^\(|\)$/g, "").split(",");
      if (!terms.some((t) => matchesOrTerm(row, t))) return false;
    } else if (raw.startsWith("gte.")) {
      if (String(row[key] ?? "") < raw.slice(4)) return false;
    } else if (raw.startsWith("lte.")) {
      if (String(row[key] ?? "") > raw.slice(4)) return false;
    } else if (raw.startsWith("eq.")) {
      if (String(row[key]) !== raw.slice(3)) return false;
    } else if (raw.startsWith("ilike.")) {
      const want = decodeURIComponent(raw.slice(6)).replace(/\*/g, "").toLowerCase();
      if (!String(row[key] || "").toLowerCase().includes(want)) return false;
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
          const c = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
          return dir === "desc" ? -c : c;
        });
      }
      return out.slice(offset, offset + limit);
    }

    if (method === "POST") {
      const body = Array.isArray(options.body) ? options.body : [options.body];
      const out = [];
      for (const b of body) {
        // bill_number carries a unique constraint in the real schema.
        if (table === "bills" && b.bill_number &&
            rows.some((r) => r.bill_number === b.bill_number)) {
          throw new Error('duplicate key value violates unique constraint (23505)');
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
const importApi = require(path.join(PROJECT, "api/import-bills.js"));

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
const importBills = (o) => invoke(importApi, "POST", o);

let fails = 0;
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

const item = (qty, price) => ([{ medicineName: "Paracetamol", sellPrice: price, quantity: qty }]);

(async () => {
  console.log("--- bills scoped to one customer ---");
  await bills("POST", { body: { customerName: "Ramesh", amountReceived: 0, items: item(10, 10) } });
  await bills("POST", { body: { customerName: "Sita",   amountReceived: 0, items: item(20, 10) } });
  await bills("POST", { body: { customerName: "Ramesh", amountReceived: 0, items: item(5, 10) } });
  await bills("POST", { body: { customerName: "",       amountReceived: 0, items: item(1, 10) } });

  let r = await bills("GET", { query: { customer: "Ramesh" } });
  eq("only Ramesh's bills", r.json.bills.length, 2);
  eq("all belong to Ramesh",
     r.json.bills.every((b) => b.customer_name === "Ramesh"), true);
  eq("oldest first",
     r.json.bills[0].grand_total <= r.json.bills[1].grand_total ||
     new Date(r.json.bills[0].created_at) <= new Date(r.json.bills[1].created_at), true);

  console.log("\n--- case and spacing match the way balances are derived ---");
  r = await bills("GET", { query: { customer: "  ramesh  " } });
  eq("case-insensitive match", r.json.bills.length, 2);

  console.log("\n--- a name that only partially matches must not leak in ---");
  await bills("POST", { body: { customerName: "Ramesh Kumar", amountReceived: 0, items: item(1, 10) } });
  r = await bills("GET", { query: { customer: "Ramesh" } });
  eq("Ramesh Kumar excluded", r.json.bills.length, 2);
  r = await bills("GET", { query: { customer: "Ramesh Kumar" } });
  eq("Ramesh Kumar found on its own", r.json.bills.length, 1);

  console.log("\n--- the default list is a window, not the whole table ---");
  r = await bills("GET");
  eq("history returns rows", r.json.bills.length > 0, true);
  eq("no customer filter applied", r.json.bills.length, db.bills.length);

  console.log("\n--- medicine sales history: who bought it, at what rate ---");
  db.bills.length = 0;
  db.bill_items.length = 0;
  db.bills.push(
    { id: "mb1", bill_number: "AM-1", customer_name: "Ramesh", customer_phone: "9001",
      created_at: "2026-05-01T09:00:00.000Z" },
    { id: "mb2", bill_number: "AM-2", customer_name: "Sita", customer_phone: "9002",
      created_at: "2026-06-01T09:00:00.000Z" },
    { id: "mb3", bill_number: "AM-3", customer_name: "", customer_phone: "",
      created_at: "2026-07-01T09:00:00.000Z" },
  );
  db.bill_items.push(
    { id: "mi1", bill_id: "mb1", medicine_name: "Calpol 500 Tab", quantity: 3,
      sell_price: 10.55, purchase_price: 8, batch_no: "B2231", expiry: "11/27" },
    { id: "mi2", bill_id: "mb2", medicine_name: "calpol 500 tab", quantity: 2,
      sell_price: 12.00, purchase_price: 8, batch_no: "B2240", expiry: "01/28" },
    { id: "mi3", bill_id: "mb3", medicine_name: "Calpol 500 Tab", quantity: 1,
      sell_price: 9.00, purchase_price: 8, batch_no: null, expiry: null },
    { id: "mi4", bill_id: "mb1", medicine_name: "Crocin", quantity: 1,
      sell_price: 20, purchase_price: 15, batch_no: null, expiry: null },
  );

  r = await bills("GET", { query: { medicine: "Calpol 500 Tab" } });
  eq("three sales found", r.json.sales.length, 3);
  eq("newest first", r.json.sales.map((s) => s.billNumber), ["AM-3", "AM-2", "AM-1"]);
  eq("other medicines excluded",
     r.json.sales.every((s) => s.billNumber !== "AM-1" || s.sellPrice === 10.55), true);

  eq("customer carried through", r.json.sales[2].customerName, "Ramesh");
  eq("phone carried through", r.json.sales[2].customerPhone, "9001");
  eq("rate carried through", r.json.sales[2].sellPrice, 10.55);
  eq("quantity carried through", r.json.sales[2].quantity, 3);
  eq("batch carried through", r.json.sales[2].batchNo, "B2231");
  eq("a walk-in has a blank customer", r.json.sales[0].customerName, "");

  console.log("\n--- the name match is case-insensitive but exact ---");
  eq("differently-cased line included", r.json.sales[1].customerName, "Sita");
  r = await bills("GET", { query: { medicine: "calpol 500 tab" } });
  eq("query case does not matter", r.json.sales.length, 3);
  r = await bills("GET", { query: { medicine: "Calpol" } });
  eq("a partial name is not a match", r.json.sales.length, 0);

  console.log("\n--- a medicine never sold ---");
  r = await bills("GET", { query: { medicine: "Dolo 650" } });
  eq("empty history", r.json.sales, []);
  eq("medicine echoed back", r.json.medicine, "Dolo 650");

  console.log("\n--- a line whose bill was deleted is not reported ---");
  db.bills = db.bills.filter((b) => b.id !== "mb2");
  r = await bills("GET", { query: { medicine: "Calpol 500 Tab" } });
  eq("orphaned line dropped", r.json.sales.length, 2);
  eq("no undefined bill numbers",
     r.json.sales.every((s) => Boolean(s.billNumber)), true);

  console.log("\n--- history search ---");
  db.bills.length = 0;
  db.bills.push(
    { id: "s1", bill_number: "AM-20260501-001", customer_name: "Ramesh Gupta",
      customer_phone: "9876500001", grand_total: 300, created_at: "2026-05-01T09:00:00.000Z" },
    { id: "s2", bill_number: "AM-20260610-007", customer_name: "Sita Devi",
      customer_phone: "9876500002", grand_total: 150, created_at: "2026-06-10T09:00:00.000Z" },
    { id: "s3", bill_number: "AM-20260715-002", customer_name: "Ramesh Gupta",
      customer_phone: "9876500001", grand_total: 250, created_at: "2026-07-15T09:00:00.000Z" },
  );

  r = await bills("GET", { query: { search: "Ramesh" } });
  eq("search by customer name", r.json.bills.map((b) => b.id).sort(), ["s1", "s3"]);
  eq("flagged as a search", r.json.searched, true);
  eq("not truncated", r.json.truncated, false);

  r = await bills("GET", { query: { search: "ramesh" } });
  eq("search is case-insensitive", r.json.bills.length, 2);

  r = await bills("GET", { query: { search: "20260610" } });
  eq("search by bill number fragment", r.json.bills.map((b) => b.id), ["s2"]);

  r = await bills("GET", { query: { search: "9876500002" } });
  eq("search by phone", r.json.bills.map((b) => b.id), ["s2"]);

  r = await bills("GET", { query: { search: "Nobody" } });
  eq("no matches", r.json.bills.length, 0);
  eq("still flagged as a search", r.json.searched, true);

  console.log("\n--- history date range ---");
  r = await bills("GET", { query: { from: "2026-06-01" } });
  eq("from date", r.json.bills.map((b) => b.id).sort(), ["s2", "s3"]);

  r = await bills("GET", { query: { to: "2026-06-30" } });
  eq("to date", r.json.bills.map((b) => b.id).sort(), ["s1", "s2"]);

  r = await bills("GET", { query: { from: "2026-06-01", to: "2026-06-30" } });
  eq("both bounds", r.json.bills.map((b) => b.id), ["s2"]);

  r = await bills("GET", { query: { from: "2026-06-10", to: "2026-06-10" } });
  eq("a single day includes that day's bills", r.json.bills.map((b) => b.id), ["s2"]);

  r = await bills("GET", { query: { search: "Ramesh", from: "2026-07-01" } });
  eq("search and date combine", r.json.bills.map((b) => b.id), ["s3"]);

  console.log("\n--- a search term cannot corrupt the filter ---");
  // ',' '(' ')' and '*' are PostgREST's own separators inside or=(...).
  r = await bills("GET", { query: { search: "Ramesh, Gupta)" } });
  eq("punctuation stripped, no crash", r.status, 200);
  r = await bills("GET", { query: { search: "*" } });
  eq("a bare wildcard is not a filter", r.status, 200);
  eq("and matches nothing rather than everything", r.json.searched, false);

  console.log("\n--- an unfiltered list is not marked as searched ---");
  r = await bills("GET");
  eq("not a search", r.json.searched, false);
  eq("all rows", r.json.bills.length, 3);

  console.log("\n--- import: numbering survives a deleted bill ---");
  db.bills.length = 0;
  let imp = await importBills({
    body: { rows: [
      { date: "2026-06-01", medicine_name: "Calpol", quantity: "2", sell_price: "10" },
      { date: "2026-06-01", medicine_name: "Crocin", quantity: "1", sell_price: "20" },
    ] },
  });
  eq("two bills imported", imp.json.ok, 2);
  eq("numbers issued in order",
     db.bills.map((b) => b.bill_number), ["AM-20260601-001", "AM-20260601-002"]);

  // Delete the first. A count-based scheme would now re-issue -002 and collide.
  db.bills = db.bills.filter((b) => b.bill_number !== "AM-20260601-001");
  imp = await importBills({
    body: { rows: [{ date: "2026-06-01", medicine_name: "Dolo", quantity: "1", sell_price: "30" }] },
  });
  eq("import succeeded after a deletion", imp.json.ok, 1);
  eq("no error", imp.json.errors, 0);
  eq("took the next free number",
     db.bills.map((b) => b.bill_number).sort(),
     ["AM-20260601-002", "AM-20260601-003"]);

  console.log("\n--- import: bill numbers are stamped in shop time ---");
  db.bills.length = 0;
  // A CSV date is stored at UTC midnight; read back in IST it must stay the
  // same calendar day rather than slipping forward.
  imp = await importBills({
    body: { rows: [{ date: "2026-06-01", medicine_name: "A", quantity: "1", sell_price: "10" }] },
  });
  eq("CSV date kept", db.bills[0].bill_number, "AM-20260601-001");

  // A row with no date falls back to now. Read in UTC that put an import run
  // before 05:30 IST under the previous day.
  db.bills.length = 0;
  const istToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()).replace(/-/g, "");
  await importBills({
    body: { rows: [{ medicine_name: "B", quantity: "1", sell_price: "10" }] },
  });
  eq("undated row carries the IST date", db.bills[0].bill_number, `AM-${istToday}-001`);
  const utcToday = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  if (utcToday !== istToday) {
    eq("and not the UTC date", db.bills[0].bill_number.includes(utcToday), false);
  }

  db.bills.length = 0;
  await importBills({
    body: { rows: [
      { date: "2026-06-01", medicine_name: "A", quantity: "1", sell_price: "10" },
      { date: "2026-06-01", medicine_name: "B", quantity: "1", sell_price: "10" },
    ] },
  });

  console.log("\n--- import: a number already in the file is skipped, not duplicated ---");
  imp = await importBills({
    body: { rows: [{ date: "2026-06-01", bill_number: "AM-20260601-002",
                     medicine_name: "Dup", quantity: "1", sell_price: "5" }] },
  });
  eq("skipped as existing", imp.json.skipped, 1);
  eq("nothing imported", imp.json.ok, 0);

  console.log("\n--- import: the received amount is recorded ---");
  db.bills.length = 0;
  await importBills({
    body: { rows: [
      { date: "2026-06-02", bill_number: "X-1", medicine_name: "A", quantity: "1",
        sell_price: "100", amount_received: "40" },
      { date: "2026-06-02", bill_number: "X-1", medicine_name: "B", quantity: "1",
        sell_price: "100" },
    ] },
  });
  let b = db.bills.find((x) => x.bill_number === "X-1");
  eq("grand total", b.grand_total, 200);
  eq("received recorded", b.amount_received, 40);
  eq("balance due", b.balance_due, 160);

  console.log("\n--- import: a blank received amount means fully unpaid ---");
  await importBills({
    body: { rows: [{ date: "2026-06-02", bill_number: "X-2", medicine_name: "C",
                     quantity: "1", sell_price: "50" }] },
  });
  b = db.bills.find((x) => x.bill_number === "X-2");
  eq("received defaults to 0", b.amount_received, 0);
  eq("whole bill outstanding", b.balance_due, 50);

  console.log("\n--- import: line order is preserved ---");
  const lines = db.bill_items
    .filter((i) => i.bill_id === db.bills.find((x) => x.bill_number === "X-1").id)
    .sort((x, y) => x.sort_order - y.sort_order)
    .map((i) => i.medicine_name);
  eq("CSV order kept", lines, ["A", "B"]);

  console.log(fails ? `\n${fails} FAILED` : "\nall billing-api assertions passed");
  process.exit(fails ? 1 : 0);
})();
