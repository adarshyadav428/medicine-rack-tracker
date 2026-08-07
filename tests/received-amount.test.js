/**
 * Amount Received and the previous balance it is set against.
 *
 * Two things are covered here:
 *   - readMoney, which stops a negative or unparseable Amount Received from
 *     raising the customer's balance instead of clearing it;
 *   - syncSelectedCustomerBalance, which re-reads the previous balance from the
 *     server so a payment recorded on the Customers page lands on the open bill
 *     instead of the bill printing a figure that has already been paid down.
 *
 * Both are lifted out of billing.js by source extraction, the same way
 * sell-price-memory.test.js does it — neither is exported and the file they
 * live in only runs in a browser.
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

const moneyCode =
  grab("  function round2(", "  function receivedAmountValue(") +
  "\n; module.exports = { round2, readMoney };";
const moneyMod = { exports: {} };
new Function("module", "exports", moneyCode)(moneyMod, moneyMod.exports);
const { round2, readMoney } = moneyMod.exports;

const syncSrc = grab(
  "  async function syncSelectedCustomerBalance(",
  "  /** Fire-and-forget"
);
const makeSync = new Function(
  "bState", "bEl", "normalizeString", "round2",
  "refreshSavedCustomers", "loadSavedCustomers", "recalcPayment",
  syncSrc + "\n return syncSelectedCustomerBalance;"
);

let fails = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`));
}

// ---------------------------------------------------------------------------
// readMoney
// ---------------------------------------------------------------------------
console.log("=== Amount Received never goes negative ===");
const field = (v) => ({ value: v });

check("a plain amount passes through",          readMoney(field("250")),     250);
check("decimals are kept",                      readMoney(field("249.50")),  249.5);
check("a third decimal rounds to paise",        readMoney(field("12.345")),  12.35);
check("blank reads as nothing received",        readMoney(field("")),        0);
check("text reads as nothing received",         readMoney(field("abc")),     0);
check("a missing element reads as zero",        readMoney(null),             0);
check("a typo'd minus cannot raise the balance", readMoney(field("-500")),   0);
check("negative zero is still zero",            readMoney(field("-0")),      0);
check("Infinity is rejected",                   readMoney(field("1e999")),   0);

// ---------------------------------------------------------------------------
// syncSelectedCustomerBalance
// ---------------------------------------------------------------------------
console.log("\n=== the previous balance follows the server ===");

/**
 * One billing page. `serverBalance` is what /api/customers would derive after
 * whatever payments have been recorded elsewhere; `duringFlight` runs while the
 * refresh is still pending, standing in for the user carrying on typing.
 */
function scenario(opts) {
  const state = {
    currentBillId: opts.currentBillId || null,
    currentCustomerIdx: opts.currentCustomerIdx === undefined ? 0 : opts.currentCustomerIdx,
    currentCustomerBalance: opts.shownBalance,
    openingBalanceTouched: !!opts.openingBalanceTouched,
  };
  const el = {
    customerName:   { value: opts.customerName },
    openingBalance: { value: String(opts.shownBalance || "") },
  };
  let recalcs = 0;
  const list = opts.customers || [{ name: "Dr. Yaswant", balance: opts.serverBalance }];

  const sync = makeSync(
    state,
    el,
    (v) => String(v == null ? "" : v).trim(),
    round2,
    async () => { if (opts.duringFlight) opts.duringFlight(state, el); },
    () => list,
    () => { recalcs += 1; }
  );

  return sync().then((moved) => ({
    moved,
    balance: state.currentCustomerBalance,
    field: el.openingBalance.value,
    idx: state.currentCustomerIdx,
    recalcs,
  }));
}

const base = { customerName: "Dr. Yaswant", shownBalance: 1200 };

(async () => {
  // A ₹500 payment taken on the Customers page while this bill was open.
  const paid = await scenario({ ...base, serverBalance: 700 });
  check("the drop is reported",        paid.moved,   { from: 1200, to: 700 });
  check("state picks up the new figure", paid.balance, 700);
  check("so does the Opening Balance box", paid.field, "700");
  check("totals are recalculated",     paid.recalcs, 1);

  // Nothing happened elsewhere: sync silently, report no move.
  const same = await scenario({ ...base, serverBalance: 1200 });
  check("an unchanged balance is not reported", same.moved, null);
  check("and is still in place",                same.balance, 1200);

  // Rounding noise is not a change worth stopping the save for.
  const noise = await scenario({ ...base, serverBalance: 1200.004 });
  check("sub-paise drift is not a change", noise.moved, null);

  // A settled account empties the box rather than showing "0".
  const cleared = await scenario({ ...base, serverBalance: 0 });
  check("a cleared account reports the drop", cleared.moved, { from: 1200, to: 0 });
  check("and leaves the box blank",           cleared.field, "");

  console.log("\n=== and leaves alone what it must not touch ===");

  // Editing a saved bill: its previous balance is a historical snapshot.
  const editing = await scenario({ ...base, serverBalance: 700, currentBillId: "bill-1" });
  check("a saved bill is not resynced", editing.moved,   null);
  check("its snapshot is untouched",    editing.balance, 1200);
  check("and nothing is recalculated",  editing.recalcs, 0);

  // A hand-typed correction outranks the derived figure.
  const typed = await scenario({ ...base, serverBalance: 700, openingBalanceTouched: true });
  check("a typed Opening Balance is not overwritten", typed.moved,   null);
  check("the typed figure stands",                    typed.balance, 1200);

  // No customer on the bill yet.
  const unnamed = await scenario({ ...base, customerName: "  ", serverBalance: 700 });
  check("a blank customer is a no-op", unnamed.moved,   null);
  check("nothing is written",          unnamed.balance, 1200);

  // Typed a name that is not on file — a new customer, not a stale index.
  const stranger = await scenario({
    ...base, serverBalance: 700, customers: [{ name: "Someone Else", balance: 40 }],
  });
  check("an unknown name pulls nobody's balance", stranger.moved,   null);
  check("and leaves the bill alone",              stranger.balance, 1200);

  console.log("\n=== a slow request cannot land on the wrong bill ===");

  // The counter does not wait: each of these happens while the refresh is in
  // flight, and each must make the answer stale rather than overwrite the user.
  const switched = await scenario({
    ...base, serverBalance: 700,
    duringFlight: (_s, el) => { el.customerName.value = "Dr. Sanjay"; },
  });
  check("a customer switched mid-flight is not overwritten", switched.moved,   null);
  check("their balance is left as found",                    switched.balance, 1200);

  const cleared2 = await scenario({
    ...base, serverBalance: 700,
    duringFlight: (s) => { s.currentBillId = "bill-9"; },
  });
  check("a bill opened mid-flight is not overwritten", cleared2.moved,   null);
  check("its snapshot survives",                       cleared2.balance, 1200);

  const corrected = await scenario({
    ...base, serverBalance: 700,
    duringFlight: (s) => { s.openingBalanceTouched = true; s.currentCustomerBalance = 999; },
  });
  check("a correction typed mid-flight wins", corrected.moved,   null);
  check("and is not undone",                  corrected.balance, 999);

  console.log(fails ? `\n${fails} FAILED` : "\nAll passed");
  process.exit(fails ? 1 : 0);
})();
