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

const { createFixture } = require("./helpers/financial-fixture");

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

  const fixture = await createFixture();
  try {
  console.log("\n--- the staged atomic API persists batch and expiry ---");
  let r = await fixture.createBill("Ramesh", [
    { medicineName: "Calpol 500", sellPrice: 10, quantity: 3, batchNo: "B2231", expiry: "11/27" },
    { medicineName: "Crocin", sellPrice: 20, quantity: 1 },
  ], { amountReceived: 0 });
  eq("bill saved", r.status, 200);
  const billId = r.json.bill.id;
  const saved = (await fixture.pg.query(
    "SELECT * FROM public.bill_items WHERE bill_id=$1 ORDER BY sort_order", [billId]
  )).rows;
  eq("batch stored", saved[0].batch_no, "B2231");
  eq("expiry stored", saved[0].expiry, "11/27");
  eq("an unrecorded batch is null, not empty string", saved[1].batch_no, null);
  eq("an unrecorded expiry is null", saved[1].expiry, null);

  console.log("\n--- reading the bill back returns them ---");
  r = await fixture.request("bills", "GET", { query: { id: billId } });
  const back = r.json.items.sort((a, b) => a.sort_order - b.sort_order);
  eq("batch round-trips", back[0].batch_no, "B2231");
  eq("expiry round-trips", back[0].expiry, "11/27");

  console.log("\n--- editing a bill can add a batch to an existing line ---");
  r = await fixture.updateBill(billId, { items: [
    { medicineName: "Calpol 500", sellPrice: 10, quantity: 3, batchNo: "B9999", expiry: "01/28" },
  ] });
  eq("versioned edit succeeds", r.status, 200);
  const edited = (await fixture.pg.query(
    "SELECT * FROM public.bill_items WHERE bill_id=$1", [billId]
  )).rows;
  eq("one line after edit", edited.length, 1);
  eq("batch updated", edited[0].batch_no, "B9999");
  eq("expiry updated", edited[0].expiry, "01/28");

  // The storage above is deliberately kept, but the billing form no longer
  // collects either field and the receipt no longer prints them — the shop's
  // batch data is not uploaded, so both would be blank in practice. These
  // guard against the UI creeping back in without that data.
  const render  = grab("      tr.innerHTML =", '<td class="num-col">');
  eq("no batch input on the line-item row", render.includes('id="batch-'), false);
  eq("no expiry input on the line-item row", render.includes('id="expiry-'), false);

  const receipt = grab("  function buildReceiptHtml(", "\n  function ");
  eq("receipt does not print a batch number", receipt.includes("B.No"), false);
  eq("receipt does not print an expiry", receipt.includes("Exp: "), false);

  } finally { await fixture.close(); }

  console.log(fails ? `\n${fails} FAILED` : "\nall batch/expiry assertions passed");
  process.exit(fails ? 1 : 0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
