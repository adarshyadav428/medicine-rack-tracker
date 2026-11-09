/**
 * Billing medicine search: accuracy first, sales history as the tie-breaker.
 *
 * The search was a plain substring test, so results came back in whatever
 * order the inventory happened to be stored in. These pin the two properties
 * that matter: the best name match wins, and history only ever breaks ties
 * between comparable matches — it must never float a poor match to the top.
 *
 * The scorers are lifted out of billing.js the same way batch-expiry.test.js
 * lifts normalizeExpiry; the soldcounts endpoint runs against the real
 * api/bills.js through the staged PostgreSQL RPC fixture.
 */
const fs = require("fs");
const path = require("path");

const PROJECT = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(PROJECT, "billing.js"), "utf8");

function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error("not found: " + startMarker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error("end not found: " + endMarker);
  return src.slice(a, b);
}

const code =
  grab("  function nameMatchScore(", "  function handleSearchInput(") +
  "\n; module.exports = { nameMatchScore, soldWeight, rankSearchResults };";

let fails = 0;
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

/** Fresh scorers bound to a given history, since both read bState. */
function withHistory({ lastPrices = {}, soldCounts = {} } = {}) {
  const bState = { customerLastPrices: lastPrices, soldCounts };
  const mod = { exports: {} };
  new Function("module", "exports", "bState", code)(mod, mod.exports, bState);
  return mod.exports;
}

/** Names only, in ranked order — what the dropdown would show. */
function rank(api, names, query, extra = {}) {
  const items = names.map((n) =>
    typeof n === "string" ? { medicineName: n, quantity: 10, ...extra } : n
  );
  return api.rankSearchResults(items, query).map((i) => i.medicineName);
}

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------
{
  const { nameMatchScore } = withHistory();
  const s = (name, q) => nameMatchScore(name, q, q.split(/\s+/).filter(Boolean));

  eq("exact name scores highest", s("crocin", "crocin"), 1000);
  eq("case is ignored", s("Crocin", "crocin"), 1000);
  eq("prefix beats substring", s("Crocin 650", "crocin") > s("Zecrocin", "crocin"), true);
  eq("name starting with the query", s("Crocin 650", "cro"), 800);
  eq("a word starting with the query", s("Tab Crocin 650", "cro"), 600);
  eq("plain substring is last", s("Microcin", "cro"), 200);

  // Multi-word, any order — the thing a substring test cannot do at all.
  eq("a full prefix still wins outright", s("Crocin 650mg Tablet", "crocin 650"), 800);
  eq("all typed words present", s("Tablet Crocin 650mg", "crocin 650"), 400);
  eq("word order does not matter", s("Crocin 650mg Tablet", "650 crocin"), 400);
  eq("a missing word is no match", s("Crocin 650mg", "crocin 500"), null);

  eq("no match is null", s("Dolo 650", "azithro"), null);
  eq("empty query is null", s("Crocin", ""), null);
  eq("empty name is null", s("", "crocin"), null);
  eq("punctuation splits words", s("Vitamin-D3 Sachet", "d3"), 600);
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------
{
  const api = withHistory();

  eq("exact match first",
    rank(api, ["Crocin Advance", "Crocin", "Microcin"], "crocin"),
    ["Crocin", "Crocin Advance", "Microcin"]);

  // The reported fault: an unrelated item that merely contains the letters
  // must not sit above the medicine whose name starts with them.
  eq("prefix beats mid-word",
    rank(api, ["Sucrocin Syrup", "Crocin 650"], "cro"),
    ["Crocin 650", "Sucrocin Syrup"]);

  // Shorter name wins a tie: a more specific answer to what was typed.
  eq("shorter name breaks a tie",
    rank(api, ["Dolo 650 Extra Strength", "Dolo 650"], "dolo 650"),
    ["Dolo 650", "Dolo 650 Extra Strength"]);

  eq("non-matches are dropped",
    rank(api, ["Crocin", "Azithral", "Dolo"], "cro"), ["Crocin"]);

  // In stock beats out of stock, all else equal.
  eq("stocked item first", api.rankSearchResults([
    { medicineName: "Calpol 500", quantity: 0 },
    { medicineName: "Calpol 500", quantity: 12 },
  ], "calpol").map((i) => i.quantity), [12, 0]);
}

// ---------------------------------------------------------------------------
// History weighting
// ---------------------------------------------------------------------------
{
  const api = withHistory({ soldCounts: { "dolo 650": { count: 40, lastSoldAt: "2026-07-01" } } });

  // What the shop actually sells leads among equal-quality matches.
  eq("a sold medicine leads its equals",
    rank(api, ["Dolo 650 MD", "Dolo 650"], "dolo"),
    ["Dolo 650", "Dolo 650 MD"]);

  // ...but never at the cost of accuracy. "Paracip" is the exact thing typed;
  // a heavily sold item that only matches loosely stays below it.
  const api2 = withHistory({ soldCounts: { "sudolo paracip mix": { count: 500 } } });
  eq("history never beats a better name match",
    rank(api2, ["Sudolo Paracip Mix", "Paracip"], "paracip"),
    ["Paracip", "Sudolo Paracip Mix"]);

  // This customer's own history is the strongest of the history signals.
  const api3 = withHistory({
    lastPrices: { "amoxil 500": { sellPrice: 42 } },
    soldCounts: { "amoxil 250": { count: 30 } },
  });
  eq("this customer's own history leads",
    rank(api3, ["Amoxil 250", "Amoxil 500"], "amoxil"),
    ["Amoxil 500", "Amoxil 250"]);
}

// Weighting shape.
{
  const api = withHistory({
    lastPrices: { "a": {} },
    soldCounts: { "b": { count: 1 }, "c": { count: 1000 } },
  });
  eq("unknown medicine has no weight", api.soldWeight("zzz"), 0);
  eq("this customer's history outweighs volume alone",
    api.soldWeight("a") > api.soldWeight("c"), true);
  eq("more sales weigh more", api.soldWeight("c") > api.soldWeight("b"), true);
  // One match tier is 200; the whole history budget has to stay inside it.
  eq("weight stays under a match tier", api.soldWeight("c") < 200, true);
  eq("even both signals together stay under a tier",
    withHistory({ lastPrices: { x: {} }, soldCounts: { x: { count: 999999 } } })
      .soldWeight("x") < 200, true);
}

// ---------------------------------------------------------------------------
// The soldcounts endpoint
// ---------------------------------------------------------------------------
const { createFixture } = require("./helpers/financial-fixture");

(async () => {
  const fixture = await createFixture();
  try {
    await fixture.createCustomer("Counter");
    const customerId = (await fixture.pg.query("SELECT id FROM public.customers WHERE name_key='counter'")).rows[0].id;
    const rows = [
      { name: "Dolo 650", price: 25.5, at: "2026-07-30T00:00:00Z" },
      { name: "dolo 650", price: 24.5, at: "2026-07-28T00:00:00Z" },
      { name: "Crocin", price: 31, at: "2026-07-20T00:00:00Z" },
      { name: "  Dolo 650  ", price: 19, at: "2026-06-01T00:00:00Z" },
      { name: "", price: 0, at: "2026-06-01T00:00:00Z" },
    ];
    const ids = [];
    // Seed legacy, schema-valid rows directly. API creation intentionally rejects
    // blank names; reads must still tolerate old empty-string medicine names.
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const header = (await fixture.pg.query(
        "INSERT INTO public.bills(bill_number,customer_id,customer_name,subtotal,grand_total,created_by,created_at) VALUES($1,$2,'Counter',$3,$4,'fixture',$5) RETURNING id",
        ["COUNT-" + index, customerId, row.price, Math.ceil(row.price), row.at]
      )).rows[0];
      ids.push(header.id);
      await fixture.pg.query(
        "INSERT INTO public.bill_items(bill_id,medicine_name,quantity,sell_price,line_total,created_at) VALUES($1,$2,1,$3,$3,$4)",
        [header.id, row.name, row.price, row.at]
      );
    }
    let result = await fixture.request("bills", "GET", { query: { soldcounts: "1" } });
    const body = result.json;
    eq("soldcounts responds 200", result.status, 200);
    eq("counted case-insensitively", body.counts["dolo 650"].count, 3);
    eq("other medicine counted separately", body.counts["crocin"].count, 1);
    eq("blank legacy names are skipped", Object.keys(body.counts).sort(), ["crocin", "dolo 650"]);
    eq("last sold uses the newest bill date", body.counts["dolo 650"].lastSoldAt.slice(0, 10), "2026-07-30");
    eq("latest recorded sale supplies its rate", body.counts["dolo 650"].lastSellPrice, 25.5);
    eq("last sell price for a single sale", body.counts["crocin"].lastSellPrice, 31);
    eq("scanned count includes all persisted legacy lines", body.scanned, 5);
    eq("not truncated on a small shop", body.truncated, false);

    let invalidPriceRejected = false;
    try {
      await fixture.pg.query(
        "INSERT INTO public.bill_items(bill_id,medicine_name,quantity,sell_price,line_total) VALUES($1,'Invalid',1,NULL,0)",
        [ids[0]]
      );
    } catch (error) { invalidPriceRejected = error.code === "23502"; }
    eq("real schema rejects the null prices accepted by the old fake", invalidPriceRejected, true);

    const edit = await fixture.updateBill(ids[3], {
      items: [{ medicineName: "  Dolo 650  ", quantity: 1, sellPrice: 99 }],
    });
    eq("editing an older bill succeeds", edit.status, 200);
    result = await fixture.request("bills", "GET", { query: { soldcounts: "1" } });
    eq("editing an old line does not make its price the newest sale", result.json.counts["dolo 650"].lastSellPrice, 25.5);

    await fixture.pg.exec("TRUNCATE public.bill_items,public.bills CASCADE");
    const empty = await fixture.request("bills", "GET", { query: { soldcounts: "1" } });
    eq("no sales yet is an empty map", empty.json.counts, {});
    eq("badge reads the same map", src.includes("bState.soldCounts[medicineLower]"), true);
  } finally { await fixture.close(); }
  console.log(fails ? "\n" + fails + " FAILED" : "\nall search-ranking assertions passed");
  process.exitCode = fails ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
