/**
 * Extracts the PDF line-parsing functions out of billing.js and runs them
 * against realistic pharmacy-bill rows. Pure logic — no browser needed.
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "billing.js"), "utf8");

function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error("not found: " + startMarker);
  const b = src.indexOf(endMarker, a);
  return src.slice(a, b);
}

const code =
  grab("  var PDF_SKIP_RE =", "  async function handlePdfFile") +
  "\n; module.exports = { pdfNums, assignPdfNums, parsePdfLines, PDF_SKIP_RE };";

const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { assignPdfNums, parsePdfLines } = mod.exports;

let fails = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`));
}
const row = (line) => parsePdfLines([line])[0];

console.log("=== typical item lines ===");
let r = row("1.  PARACETAMOL 500MG TAB   10   25.00   250.00");
check("qty/rate/total: name", r && r.medicine_name, "PARACETAMOL 500MG TAB");
check("qty/rate/total: qty", r && r.quantity, "10");
check("qty/rate/total: sell", r && r.sell_price, "25");

r = row("2.  AZITHRAL 500   MRP 120.00   2   55.00   110.00");
check("mrp/qty/rate/total parses", !!r, true);

r = row("CROCIN ADVANCE   5   18.50   92.50");
check("no serial number: name", r && r.medicine_name, "CROCIN ADVANCE");
check("no serial number: qty", r && r.quantity, "5");

console.log("\n=== lines that must be skipped ===");
const skips = [
  "Grand Total                      1250.00",
  "Sub Total                         900.00",
  "Bill No: AM-20260728-001",
  "GSTIN: 09ABCDE1234F1Z5",
  "Customer: Dr.Sanjay",
  "Previous Balance          500.00",
  "Received                  200.00",
  "Drug Lic No: UP32200012345",
  "Page 1 of 2",
  "Adarsh Medicals, Thekma, Azamgarh",
];
skips.forEach((line) => check("skipped: " + line.slice(0, 32), parsePdfLines([line]).length, 0));

console.log("\n=== number assignment ===");
check("single number is the rate", assignPdfNums([45]), { qty: "", mrp: "", purchase: "", sell: 45 });
check("two numbers = qty, rate", assignPdfNums([3, 20]), { qty: 3, mrp: "", purchase: "", sell: 20 });
check("qty*rate=total detected", assignPdfNums([4, 25, 100]), { qty: 4, mrp: "", purchase: "", sell: 25 });
check("mrp,qty,rate,total (this app's own receipt)",
      assignPdfNums([150, 2, 120, 240]), { qty: 2, mrp: 150, purchase: "", sell: 120 });

console.log("\n=== edge cases worth knowing about ===");
r = row("B12 INJECTION   2   45.00   90.00");
check("medicine starting with a letter+digits", r && r.medicine_name, "B12 INJECTION");

r = row("VITAMIN D3 60K   1   85.00");
check("name containing 60K survives", !!r, true);

r = row("AMOXYCILLIN 250   0   30.00   0.00");
check("zero quantity does not become 1 silently", r && r.quantity, "0");


console.log("\n=== receipt date comes from the bill, not the clock ===");
{
  const b = src.indexOf("  function buildReceiptHtml(overrides) {");
  const snippet = src.slice(b, b + 3000);
  const usesOverride = /overrides && overrides\.createdAt/.test(snippet);
  const guardsBadDate = /isNaN\(issued\.getTime\(\)\)/.test(snippet);
  check("reprint uses the stored bill date", usesOverride, true);
  check("an unparseable date falls back safely", guardsBadDate, true);

  const callSites = (src.match(/createdAt:\s+bill\.created_at,/g) || []).length;
  check("all three receipt callers pass the date", callSites, 3);
}
console.log(`\n${fails === 0 ? "ALL PASSED" : fails + " FAILED"}`);
process.exit(fails === 0 ? 0 : 1);
