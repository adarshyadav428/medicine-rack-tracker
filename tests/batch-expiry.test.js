/**
 * Batch number and expiry on a bill line.
 *
 * Two halves:
 *   — normalizeExpiry / toMonthYear, lifted out of billing.js the same way
 *     pdf-import.test.js does, since they are browser-side pure functions.
 *   — the API actually persisting batch_no and expiry onto bill_items.
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const PROJECT = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(PROJECT, "billing.js"), "utf8");

function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error("not found: " + startMarker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error("end not found: " + endMarker);
  return src.slice(a, b);
}

// Both helpers lean on normalizeString, which billing.js gets from app.js.
const code =
  "function normalizeString(v) { return String(v == null ? '' : v).trim(); }\n" +
  grab("  function toMonthYear(", "  function escHtml(") +
  grab("  function normalizeExpiry(", "\n  // ---") +
  "\n; module.exports = { normalizeExpiry, toMonthYear };";

const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { normalizeExpiry, toMonthYear } = mod.exports;

let fails = 0;
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

// ---------------------------------------------------------------------------
// Fake Supabase, so the API half runs against the real api/bills.js
// ---------------------------------------------------------------------------
const real = require(path.join(PROJECT, "lib/supabase-server.js"));
const db = { bills: [], bill_items: [], payments: [], customers: [], medicines: [] };
let seq = 0;

const fake = {
  ...real,
  getServerConfig: () => ({
    enabled: true, projectUrl: "https://fake", anonKey: "a", serviceRoleKey: "s",
    tableName: "medicines", roleTable: "user_roles", adminEmails: ["admin@test"],
  }),
  requireAuthContext: async () => ({ user: { id: "u1", email: "admin@test", role: "admin" } }),
  callSupabaseRest: async (config, pathStr, options = {}) => {
    const [table, qs] = pathStr.split("?");
    const params = new URLSearchParams(qs || "");
    const rows = db[table];
    if (!rows) throw new Error("unknown table " + table);
    const method = options.method || "GET";

    const match = (r) => {
      for (const [key, raw] of params.entries()) {
        if (["select", "order", "limit", "offset", "on_conflict"].includes(key)) continue;
        if (raw.startsWith("eq.") && String(r[key]) !== raw.slice(3)) return false;
        if (raw.startsWith("like.") &&
            !String(r[key] || "").startsWith(raw.slice(5).replace(/\*/g, ""))) return false;
      }
      return true;
    };

    if (method === "GET") return rows.filter(match);
    if (method === "POST") {
      const body = Array.isArray(options.body) ? options.body : [options.body];
      return body.map((b) => {
        const row = { id: `${table}-${++seq}`, created_at: new Date().toISOString(), ...b };
        rows.push(row);
        return row;
      });
    }
    if (method === "PATCH") {
      const t = rows.filter(match);
      t.forEach((r) => Object.assign(r, options.body));
      return t;
    }
    if (method === "DELETE") {
      const removed = rows.filter(match);
      db[table] = rows.filter((r) => !match(r));
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

function bills(method, { query = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = { method, query, body, headers: {} };
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(t) { resolve({ status: this.statusCode, json: JSON.parse(t || "{}") }); },
    };
    billsApi(req, res);
  });
}

(async () => {
  console.log("--- expiry typed off a strip normalises to MM/YY ---");
  eq("slash, 2-digit year", normalizeExpiry("11/27"), "11/27");
  eq("bare digits", normalizeExpiry("1127"), "11/27");
  eq("hyphen", normalizeExpiry("11-27"), "11/27");
  eq("dot", normalizeExpiry("11.27"), "11/27");
  eq("4-digit year", normalizeExpiry("11/2027"), "11/27");
  eq("single-digit month padded", normalizeExpiry("3/27"), "03/27");
  eq("bare 3-digit", normalizeExpiry("327"), "03/27");
  eq("spaces tolerated", normalizeExpiry(" 11 / 27 "), "11/27");

  console.log("\n--- anything unrecognisable is kept verbatim, not mangled ---");
  eq("month out of range left alone", normalizeExpiry("13/27"), "13/27");
  eq("zero month left alone", normalizeExpiry("00/27"), "00/27");
  eq("free text left alone", normalizeExpiry("NA"), "NA");
  eq("empty stays empty", normalizeExpiry(""), "");
  eq("null stays empty", normalizeExpiry(null), "");

  console.log("\n--- inventory dates reduce to MM/YYYY-style month ---");
  eq("ISO date", toMonthYear("2027-11-30"), "11/2027");
  eq("ISO datetime", toMonthYear("2027-03-01T00:00:00.000Z"), "03/2027");
  eq("blank", toMonthYear(""), "");
  eq("non-date passes through", toMonthYear("11/27"), "11/27");

  console.log("\n--- a saved bill carries batch and expiry ---");
  let r = await bills("POST", {
    body: {
      customerName: "Ramesh",
      amountReceived: 0,
      items: [
        { medicineName: "Calpol 500", sellPrice: 10, quantity: 3,
          batchNo: "B2231", expiry: "11/27" },
        { medicineName: "Crocin", sellPrice: 20, quantity: 1 },
      ],
    },
  });
  eq("bill saved", r.status, 200);

  const saved = db.bill_items.filter((i) => i.bill_id === r.json.bill.id)
    .sort((a, b) => a.sort_order - b.sort_order);
  eq("batch stored", saved[0].batch_no, "B2231");
  eq("expiry stored", saved[0].expiry, "11/27");
  eq("an unrecorded batch is null, not empty string", saved[1].batch_no, null);
  eq("an unrecorded expiry is null", saved[1].expiry, null);

  console.log("\n--- reading the bill back returns them ---");
  r = await bills("GET", { query: { id: r.json.bill.id } });
  const back = r.json.items.sort((a, b) => a.sort_order - b.sort_order);
  eq("batch round-trips", back[0].batch_no, "B2231");
  eq("expiry round-trips", back[0].expiry, "11/27");

  console.log("\n--- editing a bill can add a batch to an existing line ---");
  const billId = back[0].bill_id;
  await bills("PUT", {
    body: {
      id: billId,
      customerName: "Ramesh",
      amountReceived: 0,
      items: [
        { medicineName: "Calpol 500", sellPrice: 10, quantity: 3,
          batchNo: "B9999", expiry: "01/28" },
      ],
    },
  });
  const edited = db.bill_items.filter((i) => i.bill_id === billId);
  eq("one line after edit", edited.length, 1);
  eq("batch updated", edited[0].batch_no, "B9999");
  eq("expiry updated", edited[0].expiry, "01/28");

  console.log(fails ? `\n${fails} FAILED` : "\nall batch/expiry assertions passed");
  process.exit(fails ? 1 : 0);
})();
