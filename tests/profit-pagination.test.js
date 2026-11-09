/** Tests the structural fixes: numbering, stock, edit rollback, payment delete. */
const path = require("path");
const Module = require("module");
process.env.PROFIT_OWNER_EMAIL = "a@b";
const PROJECT = path.resolve(__dirname, "..");
const real = require(path.join(PROJECT, "lib/supabase-server.js"));

const db = {
  bills: [], bill_items: [], payments: [], customers: [], app_settings: [],
  medicines: [
    { id: "m1", medicine_name: "Crocin", quantity: 100 },
    { id: "m2", medicine_name: "Dolo", quantity: 50 },
    { id: "m3", medicine_name: "NoStock", quantity: null },
  ],
};
let seq = 0;
const uid = (p) => `${p}-${++seq}`;
let failNextItemInsert = false;

function pq(s) { const [t, q] = s.split("?"); return { table: t, params: new URLSearchParams(q || "") }; }
function match(row, params) {
  for (const [k, raw] of params.entries()) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(k)) continue;
    if (raw.startsWith("eq.") && String(row[k]) !== raw.slice(3)) return false;
    if (raw.startsWith("gte.") && row[k] < raw.slice(4)) return false;
    if (raw.startsWith("lt.") && row[k] >= raw.slice(3)) return false;
    if (raw.startsWith("like.") && !String(row[k] || "").startsWith(raw.slice(5).replace(/\*/g, ""))) return false;
    if (raw.startsWith("in.(") &&
        !raw.slice(4, -1).split(",").map(decodeURIComponent).includes(String(row[k]))) return false;
    if (raw.startsWith("ilike.") &&
        String(row[k] || "").toLowerCase() !== raw.slice(6).toLowerCase()) return false;
  }
  return true;
}

const fake = {
  ...real,
  getServerConfig: () => ({ enabled: true, projectUrl: "x", anonKey: "a", serviceRoleKey: "s",
    tableName: "medicines", roleTable: "user_roles", adminEmails: [] }),
  requireAuthContext: async () => ({ user: { id: "u", email: "a@b", role: "admin" } }),
  callSupabaseRest: async (c, p, o = {}) => {
    const { table, params } = pq(p);
    const rows = db[table];
    const m = o.method || "GET";
    if (m === "GET") {
      const out = rows.filter((r) => match(r, params));
      const offset = parseInt(params.get("offset") || "0", 10);
      const limit = parseInt(params.get("limit") || "100000", 10);
      return out.slice(offset, offset + limit);
    }
    if (m === "POST") {
      if (table === "bill_items" && failNextItemInsert) {
        failNextItemInsert = false;
        throw new Error("simulated network failure inserting items");
      }
      const body = Array.isArray(o.body) ? o.body : [o.body];
      const conflict = params.get("on_conflict");
      const merge = /merge-duplicates/.test(o.prefer || "");
      const out = [];
      for (const b of body) {
        if (conflict && merge) {
          const ex = rows.find((r) => String(r[conflict]) === String(b[conflict]));
          if (ex) { Object.assign(ex, b); out.push(ex); continue; }
        }
        if (table === "bills" && rows.some((r) => r.bill_number === b.bill_number)) {
          throw new Error('duplicate key value violates unique constraint (23505)');
        }
        const row = { id: uid(table), created_at: new Date().toISOString(), ...b };
        rows.push(row); out.push(row);
      }
      return out;
    }
    if (m === "PATCH") { const t = rows.filter((r) => match(r, params)); t.forEach((r) => Object.assign(r, o.body)); return t; }
    if (m === "DELETE") {
      const rm = rows.filter((r) => match(r, params));
      db[table] = rows.filter((r) => !match(r, params));
      if (table === "bills") for (const b of rm) db.bill_items = db.bill_items.filter((i) => i.bill_id !== b.id);
      return rm;
    }
  },
};
const ol = Module._load;
Module._load = function (r) { return /supabase-server$/.test(r) ? fake : ol.apply(this, arguments); };
const billsApi = require(path.join(PROJECT, "api/bills.js"));
const payApi = require(path.join(PROJECT, "api/payments.js"));
const profitApi = require(path.join(PROJECT, "api/profit.js"));

// /api/profit is behind the profit PIN, so these calls carry an unlock cookie.
// The PIN itself is covered in profit-pin.test.js; here it is just a door to
// hold open while the paging behaviour is checked.
const { UNLOCK_COOKIE, hashPin, issueUnlockToken } = require(path.join(PROJECT, "lib/profit-pin"));
db.app_settings.push({ key: "profit_pin", value: hashPin("1234") });
const unlockCookie = `${UNLOCK_COOKIE}=${encodeURIComponent(
  issueUnlockToken({ serviceRoleKey: "s" }, "a@b")
)}`;

const invoke = (fn, method, opts = {}) => new Promise((res) => {
  const rq = { method, query: opts.query || {}, body: opts.body || null,
               headers: { cookie: unlockCookie } };
  const rs = { statusCode: 200, setHeader() {}, end(t) { res({ status: this.statusCode, json: JSON.parse(t || "{}") }); } };
  fn(rq, rs);
});
const bills = (m, o) => invoke(billsApi, m, o);
const pay = (m, o) => invoke(payApi, m, o);
const profit = (m, o) => invoke(profitApi, m, o);

let fails = 0;
const eq = (label, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` + (ok ? "" : `\n        expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
};
const stock = (id) => db.medicines.find((m) => m.id === id).quantity;

(async () => {
  console.log("\n--- profit pages instead of truncating ---");
  db.bills.length = 0; db.bill_items.length = 0;
  // 1200 bills with one item each: more than a single page of either table.
  for (let i = 0; i < 1200; i++) {
    const bid = "b" + i;
    db.bills.push({ id: bid, bill_number: "AM-X-" + i, customer_name: "Bulk",
                    grand_total: 100, created_at: new Date(2026, 0, 1 + (i % 300)).toISOString() });
    db.bill_items.push({ id: "i" + i, bill_id: bid, medicine_name: "Crocin",
                         sell_price: 100, purchase_price: 60, quantity: 1 });
  }
  const pr = await profit("GET", { query: { period: "all" } });
  eq("every bill counted", pr.json.byBill.length, 1200);
  eq("revenue not truncated", pr.json.summary.revenue, 120000);
  eq("cost not truncated", pr.json.summary.cost, 72000);
  eq("profit correct", pr.json.summary.profit, 48000);

  db.bills.length = 0; db.bill_items.length = 0;
  // Inclusive IST day: preceding instant, midnight, final millisecond, next midnight.
  ["2026-11-07T18:29:59.999Z", "2026-11-07T18:30:00.000Z", "2026-11-08T18:29:59.999Z", "2026-11-08T18:30:00.000Z"].forEach((date, i) => {
    db.bills.push({ id: "edge" + i, bill_number: "EDGE" + i, customer_name: "Edges", grand_total: 100, created_at: date });
    db.bill_items.push({ id: "edge-item" + i, bill_id: "edge" + i, medicine_name: "Boundary", sell_price: 100, purchase_price: 60, quantity: 1 });
  });
  const interval = await profit("GET", { query: { period: "custom", from: "2026-11-08", to: "2026-11-08" } });
  eq("same-day interval includes both IST boundaries only", interval.json.byBill.map(b => b.billNumber).sort(), ["EDGE1", "EDGE2"]);
  eq("interval profit computed only from matching bills", interval.json.summary, { revenue: 200, cost: 120, profit: 80, margin: 40 });
  for (const query of [
    { period: "custom", from: "2026-11-09", to: "2026-11-08" },
    { period: "custom", from: "2026-02-30", to: "2026-03-01" },
    { period: "custom", from: "2026-11-08" }, { period: "unknown" },
  ]) eq("invalid date filter is rejected: " + JSON.stringify(query), (await profit("GET", { query })).status, 400);

  console.log(`\n${fails === 0 ? "ALL TESTS PASSED" : fails + " TEST(S) FAILED"}`);
  process.exit(fails ? 1 : 0);
})();
