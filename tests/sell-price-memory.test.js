/**
 * The rate that lands in the Sell box when a medicine is added to a bill.
 *
 * Lifted out of billing.js by source extraction, the same way
 * pdf-import.test.js does it — pickSellPrice is not exported, and the file it
 * lives in only runs in a browser.
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "billing.js"), "utf8");

function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error("not found: " + startMarker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error("not found: " + endMarker);
  return src.slice(a, b);
}

const code =
  grab("  function pickSellPrice(", "  function setBillingStatus(") +
  "\n; module.exports = { pickSellPrice };";

const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { pickSellPrice } = mod.exports;

let fails = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`));
}

// A medicine as inventory holds it.
const med = { medicineName: "Calpol 650", sellingPrice: 30, mrp: 42 };

console.log("=== the customer's own rate wins ===");
check(
  "customer price beats both history and inventory",
  pickSellPrice(med, { sellPrice: 26 }, { lastSellPrice: 28, lastSoldAt: "2026-07-01" }).sellPrice,
  26
);
check(
  "and is labelled as theirs",
  pickSellPrice(med, { sellPrice: 26 }, null).source,
  "customer"
);

console.log("\n=== a new customer inherits the last rate the shop sold at ===");
let r = pickSellPrice(med, null, { lastSellPrice: 28, lastSoldAt: "2026-07-01T10:00:00Z" });
check("uses the last sale, not the inventory price", r.sellPrice, 28);
check("says where it came from", r.source, "history");
check("carries the date, for the caption", r.soldAt, "2026-07-01T10:00:00Z");

check(
  "undefined customer entry falls through to history",
  pickSellPrice(med, undefined, { lastSellPrice: 28 }).sellPrice,
  28
);

console.log("\n=== never sold: inventory, then MRP, then zero ===");
check("inventory selling price", pickSellPrice(med, null, null).sellPrice, 30);
check("labelled as inventory", pickSellPrice(med, null, null).source, "inventory");
check(
  "sellPrice spelling is accepted too",
  pickSellPrice({ sellPrice: 33, mrp: 42 }, null, null).sellPrice,
  33
);
check("falls back to MRP", pickSellPrice({ mrp: 42 }, null, null).sellPrice, 42);
check("nothing on record at all", pickSellPrice({}, null, null).sellPrice, 0);
check("no medicine at all", pickSellPrice(null, null, null).sellPrice, 0);

console.log("\n=== a zero or junk remembered price must not be carried forward ===");
// A line saved at 0 is a real row — a sample, a replacement, an abandoned
// bill. Carrying it forward would silently zero the next customer's bill.
check(
  "zero last sale price falls through to inventory",
  pickSellPrice(med, null, { lastSellPrice: 0 }).sellPrice,
  30
);
check(
  "zero customer price falls through to history",
  pickSellPrice(med, { sellPrice: 0 }, { lastSellPrice: 28 }).sellPrice,
  28
);
check(
  "null last sale price falls through",
  pickSellPrice(med, null, { lastSellPrice: null }).sellPrice,
  30
);
check(
  "unparseable price falls through",
  pickSellPrice(med, null, { lastSellPrice: "abc" }).sellPrice,
  30
);
check(
  "a negative price is not a price",
  pickSellPrice(med, null, { lastSellPrice: -5 }).sellPrice,
  30
);
check(
  "a numeric string is a price",
  pickSellPrice(med, null, { lastSellPrice: "28.50" }).sellPrice,
  28.5
);

console.log("\n=== inventory zero is still an answer, not a fallthrough ===");
// Distinct from the case above: nothing has ever been sold, and inventory
// genuinely says 0. There is nowhere further to fall.
check("inventory zero is returned as-is", pickSellPrice({ sellingPrice: 0, mrp: 0 }, null, null).sellPrice, 0);

process.exit(fails ? 1 : 0);
