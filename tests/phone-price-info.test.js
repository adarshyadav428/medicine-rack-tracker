"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), assert = require("node:assert/strict");
const source = fs.readFileSync(path.join(__dirname, "..", "billing.js"), "utf8");
function section(start, end) { const a = source.indexOf(start); return source.slice(a, source.indexOf(end, a)); }
const requests = [], events = [];
const model = { customerLastPrices: {}, customerLastPricesFor: null, soldCounts: {} };
const context = {
  bState: model, bEl: { customerName: { value: "Alice" } },
  state: { items: [
    { id: "a", medicineName: "Test medicine", mrp: 61, purchasePrice: 44.91, sellingPrice: 54.56, quantity: null, seller: "Milan", location: "A1" },
    { id: "b", medicineName: "Test medicine", mrp: 56, purchasePrice: 41.41, sellingPrice: 50.16, quantity: 0 }
  ] },
  normalizeString: value => String(value == null ? "" : value).trim(),
  loadSavedCustomers: () => [], notifyBillingChange: field => events.push(field),
  requestApi: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
};
vm.createContext(context);
vm.runInContext(section("  function pickSellPrice(", "  function setBillingStatus(") +
  section("  function loadCustomerLastPrices(", "  // -------------------------------------------------------------------------\n  // Medicine Search") +
  section("  function loadSoldCounts(", "  /**\n   * Fold a bill"), context);
let checks = 0;
function check(label, actual, expected) { assert.deepEqual(actual === undefined ? undefined : JSON.parse(JSON.stringify(actual)), expected, label); checks++; console.log("PASS " + label); }
const drain = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const loading = context.refreshPriceHistory({ force: true });
  context.refreshPriceHistory({ force: true });
  check("concurrent reference refreshes coalesce customer and global reads", requests.length, 2);
  check("phone price metadata distinguishes pending references", [context.getPriceInfo("a").customerStatus, context.getPriceInfo("a").globalStatus], ["loading", "loading"]);
  requests.find(r => r.url.includes("soldcounts")).resolve({ counts: { "test medicine": { lastSellPrice: 52, lastSoldAt: "2026-10-01T00:00:00Z" } } });
  requests.find(r => r.url.includes("lastprices")).resolve({ priceMap: { "test medicine": { sellPrice: 48.5 } } });
  await loading;
  const first = context.getPriceInfo("a"), second = context.getPriceInfo("b");
  check("phone exposes both historical references and existing customer autofill", [first.customerLastRate, first.latestSoldRate, first.suggestedRate, first.source], [48.5, 52, 48.5, "customer"]);
  check("duplicate name inventory records retain independent prices and stock", [first.mrp, second.mrp, first.purchasePrice, second.purchasePrice, first.stock, second.stock], [61, 56, 44.91, 41.41, null, 0]);
  check("only the available global history date is exposed", first.latestSoldAt, "2026-10-01T00:00:00Z");
  model.customerLastPrices["test medicine"].sellPrice = 0; model.soldCounts["test medicine"].lastSellPrice = 0;
  const zero = context.getPriceInfo("a");
  check("zero-price references remain distinguishable from missing history", [zero.customerLastRate, zero.latestSoldRate, zero.suggestedRate], [0, 0, 54.56]);
  context.bEl.customerName.value = "Bob";
  check("typed customer never consumes another customer's rate", context.getPriceInfo("a").customerLastRate, null);
  const oldAlice = context.loadCustomerLastPrices("Alice", { force: true });
  const oldRequest = requests.at(-1);
  context.loadCustomerLastPrices("Bob", { force: true });
  const bobRequest = requests.at(-1);
  const freshAlice = context.loadCustomerLastPrices("Alice", { force: true });
  const freshRequest = requests.at(-1);
  context.bEl.customerName.value = "Alice";
  oldRequest.resolve({ priceMap: { "test medicine": { sellPrice: 99 } } }); await oldAlice;
  check("Alice-to-Bob-to-Alice rejects first Alice's late response", model.customerLastPrices["test medicine"], undefined);
  bobRequest.resolve({ priceMap: { "test medicine": { sellPrice: 88 } } });
  freshRequest.resolve({ priceMap: { "test medicine": { sellPrice: 49 } } }); await freshAlice;
  check("latest request owns the selected customer's reference", context.getPriceInfo("a").customerLastRate, 49);
  const failed = context.loadCustomerLastPrices("Alice", { force: true }); requests.at(-1).reject(new Error("offline")); await failed;
  check("failed refresh marks retained reference as unavailable instead of no sale", [context.getPriceInfo("a").customerStatus, context.getPriceInfo("a").customerLastRate], ["error", 49]);
  const empty = context.loadCustomerLastPrices("Alice", { force: true }); requests.at(-1).resolve({ priceMap: {} }); await empty;
  check("successful empty history is distinct from failure", [context.getPriceInfo("a").customerStatus, context.getPriceInfo("a").customerLastRate], ["ready", null]);
  await context.loadCustomerLastPrices(""); context.bEl.customerName.value = "";
  check("no customer has an explicit reference state", context.getPriceInfo("a").customerStatus, "none");
  // Resolve the coalesced global read started by the later customer change.
  requests.filter(r => r.url.includes("soldcounts")).slice(1).forEach(r => r.resolve({ counts: {} })); await drain();
  check("reference loading never edits the bill's customer input", context.bEl.customerName.value, "");
  console.log(checks + " phone price-info assertions passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
