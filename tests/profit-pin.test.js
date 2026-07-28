/**
 * The profit PIN is stored and verified on the server, and /api/profit refuses
 * to return figures without a valid unlock. Both used to be browser-only.
 */
const path = require("path");
const Module = require("module");

const PROJECT = path.resolve(__dirname, "..");
const real = require(path.join(PROJECT, "lib/supabase-server.js"));

const db = { bills: [], bill_items: [], app_settings: [] };
let seq = 0;

function parseQuery(pathStr) {
  const [table, qs] = pathStr.split("?");
  return { table, params: new URLSearchParams(qs || "") };
}

function matches(row, params) {
  for (const [key, raw] of params.entries()) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(key)) continue;
    if (raw.startsWith("eq.") && String(row[key]) !== raw.slice(3)) return false;
  }
  return true;
}

const fake = {
  ...real,
  callSupabaseRest: async (config, pathStr, options = {}) => {
    const { table, params } = parseQuery(pathStr);
    const rows = db[table];
    if (!rows) throw new Error("unknown table " + table);
    const method = options.method || "GET";

    if (method === "GET") return rows.filter((r) => matches(r, params));

    if (method === "POST") {
      const body = Array.isArray(options.body) ? options.body : [options.body];
      const conflict = params.get("on_conflict");
      const out = [];
      for (const b of body) {
        const existing = conflict
          ? rows.find((r) => String(r[conflict]) === String(b[conflict]))
          : null;
        if (existing) { Object.assign(existing, b); out.push(existing); continue; }
        const row = { id: `row-${++seq}`, ...b };
        rows.push(row); out.push(row);
      }
      return out;
    }
    throw new Error("unhandled " + method);
  },
};

// Auth is stubbed out; these tests are about the PIN layer sitting on top of it.
let currentRole = "admin";
fake.getServerConfig = () => ({
  enabled: true, projectUrl: "https://fake", anonKey: "a",
  serviceRoleKey: "service-role-secret", tableName: "medicines",
  roleTable: "user_roles", adminEmails: ["admin@test"],
});
fake.requireAuthContext = async (req, res, config, options = {}) => {
  if (options.adminOnly && currentRole !== "admin") {
    fake.sendJson(res, 403, { error: "Admin access required." });
    return null;
  }
  return { user: { id: "u1", email: "admin@test", role: currentRole } };
};

const origLoad = Module._load;
Module._load = function (request) {
  if (/supabase-server$/.test(request)) return fake;
  return origLoad.apply(this, arguments);
};

const pinApi = require(path.join(PROJECT, "api/profit-pin.js"));
const profitApi = require(path.join(PROJECT, "api/profit.js"));

// A tiny cookie jar, so the unlock cookie behaves the way a browser would.
let jar = {};
function applySetCookie(headers) {
  const set = headers["Set-Cookie"];
  if (!set) return;
  (Array.isArray(set) ? set : [set]).forEach((line) => {
    const [pair, ...attrs] = line.split(";");
    const idx = pair.indexOf("=");
    const name = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1));
    const maxAge = attrs.find((a) => /max-age=/i.test(a));
    if (maxAge && parseInt(maxAge.split("=")[1], 10) === 0) delete jar[name];
    else jar[name] = value;
  });
}

function invoke(fn, method, { query = {}, body = null, cookies = jar } = {}) {
  return new Promise((resolve) => {
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("; ");
    const req = { method, query, body, headers: { cookie: cookieHeader } };
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      getHeader(k) { return this.headers[k]; },
      end(t) {
        applySetCookie(this.headers);
        resolve({ status: this.statusCode, json: JSON.parse(t || "{}") });
      },
    };
    fn(req, res);
  });
}
const pin = (m, o) => invoke(pinApi, m, o);
const profit = (m, o) => invoke(profitApi, m, o);

let fails = 0;
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

(async () => {
  console.log("--- before any PIN is set ---");
  let r = await pin("GET");
  eq("no PIN yet", r.json.isSet, false);
  eq("profit data is refused", (await profit("GET", { query: { period: "all" } })).status, 403);

  console.log("\n--- setup ---");
  eq("rejects a 3-character PIN",
     (await pin("POST", { body: { pin: "123", confirm: "123" } })).status, 400);
  eq("rejects a mismatched confirmation",
     (await pin("POST", { body: { pin: "1234", confirm: "9999" } })).status, 400);

  r = await pin("POST", { body: { pin: "1234", confirm: "1234" } });
  eq("PIN set", r.json.ok, true);
  eq("stored in the database", db.app_settings.some((s) => s.key === "profit_pin"), true);

  const stored = db.app_settings.find((s) => s.key === "profit_pin").value;
  eq("stored as a pbkdf2 hash, not the PIN", /^pbkdf2\$\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(stored), true);
  eq("the PIN itself never appears", stored.includes("1234"), false);

  console.log("\n--- the unlock cookie gates the figures ---");
  eq("unlocked after setup", (await profit("GET", { query: { period: "all" } })).status, 200);
  eq("no cookie, no data",
     (await profit("GET", { query: { period: "all" }, cookies: {} })).status, 403);

  console.log("\n--- a forged or tampered token is rejected ---");
  const future = Date.now() + 3600000;
  eq("made-up signature", (await profit("GET", {
    query: { period: "all" }, cookies: { "am-profit-unlock": `${future}.${"0".repeat(64)}` },
  })).status, 403);
  eq("no signature at all", (await profit("GET", {
    query: { period: "all" }, cookies: { "am-profit-unlock": `${future}.` },
  })).status, 403);
  eq("expired token", (await profit("GET", {
    query: { period: "all" }, cookies: { "am-profit-unlock": `${Date.now() - 1000}.${"a".repeat(64)}` },
  })).status, 403);

  console.log("\n--- locking, then unlocking again ---");
  await pin("DELETE");
  eq("locked again", (await profit("GET", { query: { period: "all" } })).status, 403);
  eq("wrong PIN refused", (await pin("POST", { body: { pin: "0000" } })).status, 401);
  eq("still locked", (await profit("GET", { query: { period: "all" } })).status, 403);
  eq("right PIN accepted", (await pin("POST", { body: { pin: "1234" } })).status, 200);
  eq("data flows again", (await profit("GET", { query: { period: "all" } })).status, 200);

  console.log("\n--- lockout after repeated guesses ---");
  for (let i = 0; i < 5; i++) await pin("POST", { body: { pin: "8888" } });
  r = await pin("POST", { body: { pin: "1234" } });
  eq("correct PIN is refused while locked out", r.status, 429);
  r = await pin("GET");
  eq("status reports the lockout", r.json.lockedOutMinutes > 0, true);

  // Clear it the way the lockout expiring would.
  db.app_settings.find((s) => s.key === "profit_pin_fails").value =
    JSON.stringify({ count: 0, lockedUntil: 0 });
  eq("works again once the lockout passes",
     (await pin("POST", { body: { pin: "1234" } })).status, 200);

  console.log("\n--- changing the PIN needs the current one ---");
  eq("wrong current PIN refused",
     (await pin("PUT", { body: { currentPin: "0000", newPin: "5678" } })).status, 401);
  db.app_settings.find((s) => s.key === "profit_pin_fails").value =
    JSON.stringify({ count: 0, lockedUntil: 0 });
  eq("too-short replacement refused",
     (await pin("PUT", { body: { currentPin: "1234", newPin: "12" } })).status, 400);
  eq("change accepted",
     (await pin("PUT", { body: { currentPin: "1234", newPin: "5678" } })).status, 200);
  await pin("DELETE");
  eq("old PIN no longer works", (await pin("POST", { body: { pin: "1234" } })).status, 401);
  db.app_settings.find((s) => s.key === "profit_pin_fails").value =
    JSON.stringify({ count: 0, lockedUntil: 0 });
  eq("new PIN works", (await pin("POST", { body: { pin: "5678" } })).status, 200);

  console.log("\n--- a non-admin never gets as far as the PIN ---");
  currentRole = "staff";
  eq("PIN endpoint is admin-only", (await pin("GET")).status, 403);
  eq("profit endpoint is admin-only",
     (await profit("GET", { query: { period: "all" } })).status, 403);
  currentRole = "admin";

  console.log(`\n${fails === 0 ? "ALL TESTS PASSED" : fails + " TEST(S) FAILED"}`);
  process.exit(fails ? 1 : 0);
})();
