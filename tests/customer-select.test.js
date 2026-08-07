/**
 * Picking a customer for a bill.
 *
 * The saved-customer dropdown used to carry array positions as its option
 * values, while every refresh replaced the cache with a fresh list sorted by
 * name. These tests pin the two behaviours that fell out of that: the box is
 * keyed by name, and a rebuild does not silently drop the selection.
 *
 * renderCustomerSelect and onSavedCustomerChange are lifted out of billing.js
 * by source extraction, the same way sell-price-memory.test.js does it.
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
  grab("  function customerKey(", "  function toMonthYear(") +
  grab("  function renderCustomerSelect(", "  function setSaveCustomerStatus(");

const makePage = new Function(
  "bState", "bEl", "document", "normalizeString", "loadSavedCustomers",
  "setSaveCustomerStatus", "loadCustomerLastPrices", "recalcPayment",
  "syncSelectedCustomerBalanceSoon",
  code + "\n return { renderCustomerSelect, onSavedCustomerChange, findCustomerIdx };"
);

let fails = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`));
}

/**
 * Enough of a <select> to be honest about the two behaviours that matter:
 * clearing it drops the selection, and assigning a value that no option
 * carries leaves it on the placeholder rather than inventing a selection.
 */
function fakeSelect() {
  return {
    options: [],
    _value: "",
    get value() { return this._value; },
    set value(v) {
      this._value = this.options.some((o) => o.value === v) ? v : "";
    },
    set textContent(t) { if (t === "") { this.options = []; this._value = ""; } },
    appendChild(o) { this.options.push(o); },
  };
}

function page(customers, opts = {}) {
  let list = customers;
  const bState = {
    currentBillId: opts.currentBillId || null,
    currentCustomerIdx: opts.currentCustomerIdx === undefined ? null : opts.currentCustomerIdx,
    currentCustomerBalance: opts.shownBalance || 0,
    openingBalanceTouched: !!opts.openingBalanceTouched,
  };
  const bEl = {
    savedCustomerSelect: fakeSelect(),
    customerName:   { value: opts.customerName || "" },
    customerPhone:  { value: "" },
    openingBalance: { value: opts.shownBalance ? String(opts.shownBalance) : "" },
  };
  const calls = { lastPricesFor: [], syncs: 0, recalcs: 0 };

  const api = makePage(
    bState,
    bEl,
    { createElement: () => ({ value: "", textContent: "" }) },
    (v) => String(v == null ? "" : v).trim(),
    () => list,
    () => {},
    (n) => calls.lastPricesFor.push(n),
    () => { calls.recalcs += 1; },
    () => { calls.syncs += 1; }
  );

  return {
    bState, bEl, calls, api,
    /** Stand in for a refresh: the server returns the list sorted by name. */
    refresh(next) {
      list = next.slice().sort((a, b) => a.name.localeCompare(b.name));
      api.renderCustomerSelect();
    },
    optionValues: () => bEl.savedCustomerSelect.options.map((o) => o.value),
  };
}

const YASWANT = { name: "Dr. Yaswant", phone: "9616095373", balance: 1200 };
const SANJAY  = { name: "Dr. Sanjay",  phone: "",           balance: 40 };
const AMIT    = { name: "Amit Verma",  phone: "",           balance: 0 };

console.log("=== the dropdown is keyed by name, not position ===");
{
  const p = page([YASWANT, SANJAY]);
  p.api.renderCustomerSelect();
  check("options carry names", p.optionValues(), ["", "Dr. Yaswant", "Dr. Sanjay"]);
}
{
  // The bug: pick position 1, then a refresh re-sorts and position 1 is now
  // somebody else. Reading the box back must still name who was picked.
  const p = page([YASWANT, SANJAY]);
  p.api.renderCustomerSelect();
  p.bEl.savedCustomerSelect.value = "Dr. Yaswant";
  p.api.onSavedCustomerChange();
  check("the picked customer resolves", p.bState.currentCustomerBalance, 1200);

  p.refresh([AMIT, SANJAY, YASWANT]);
  check("a re-sort keeps the selection", p.bEl.savedCustomerSelect.value, "Dr. Yaswant");
  check("and re-resolves the position",  p.api.findCustomerIdx("Dr. Yaswant"), 2);
  check("order really did change",       p.optionValues(),
    ["", "Amit Verma", "Dr. Sanjay", "Dr. Yaswant"]);
}
{
  const p = page([YASWANT, SANJAY]);
  p.api.renderCustomerSelect();
  p.bEl.savedCustomerSelect.value = "Dr. Yaswant";
  // A customer deleted elsewhere cannot leave a stale name showing.
  p.refresh([SANJAY]);
  check("a vanished customer clears the box", p.bEl.savedCustomerSelect.value, "");
}
{
  // A bill whose customer was typed, not picked: the rebuild should find them.
  const p = page([YASWANT, SANJAY], { customerName: "Dr. Sanjay" });
  p.api.renderCustomerSelect();
  check("a typed name selects itself", p.bEl.savedCustomerSelect.value, "Dr. Sanjay");
}
{
  const p = page([YASWANT], { customerName: "Walk-in, not on file" });
  p.api.renderCustomerSelect();
  check("a name not on file selects nobody", p.bEl.savedCustomerSelect.value, "");
}

console.log("\n=== picking a customer fills the bill ===");
{
  const p = page([YASWANT, SANJAY]);
  p.api.renderCustomerSelect();
  p.bEl.savedCustomerSelect.value = "Dr. Sanjay";
  p.api.onSavedCustomerChange();
  check("name is filled in",       p.bEl.customerName.value,  "Dr. Sanjay");
  check("balance is carried over", p.bState.currentCustomerBalance, 40);
  check("their rates are loaded",  p.calls.lastPricesFor, ["Dr. Sanjay"]);
  check("a fresh balance is requested", p.calls.syncs, 1);
}
{
  const p = page([YASWANT, AMIT]);
  p.api.renderCustomerSelect();
  p.bEl.savedCustomerSelect.value = "Amit Verma";
  p.api.onSavedCustomerChange();
  check("a zero balance blanks the box", p.bEl.openingBalance.value, "");
}
{
  const p = page([YASWANT], { customerName: "Dr. Yaswant", shownBalance: 1200 });
  p.api.renderCustomerSelect();
  p.bEl.savedCustomerSelect.value = "";
  p.api.onSavedCustomerChange();
  check("clearing releases the customer", p.bState.currentCustomerIdx, null);
  check("and zeroes the previous balance", p.bState.currentCustomerBalance, 0);
}

console.log("\n=== but never rewrites a saved bill's snapshot ===");
{
  // Editing bill AM-…-007, raised when Dr. Yaswant owed ₹300. Touching the
  // dropdown used to replace that with today's ₹1200 — and a re-save wrote
  // the wrong previous balance onto the stored bill.
  const p = page([YASWANT, SANJAY], {
    currentBillId: "bill-7", shownBalance: 300, customerName: "Dr. Yaswant",
  });
  p.api.renderCustomerSelect();
  p.bEl.savedCustomerSelect.value = "Dr. Sanjay";
  p.api.onSavedCustomerChange();
  check("the customer on the bill still changes", p.bEl.customerName.value, "Dr. Sanjay");
  check("the snapshot is left alone",       p.bState.currentCustomerBalance, 300);
  check("as is the Opening Balance box",    p.bEl.openingBalance.value, "300");
  check("and no resync is requested",       p.calls.syncs, 0);
}
{
  const p = page([YASWANT], { currentBillId: "bill-7", shownBalance: 300 });
  p.api.renderCustomerSelect();
  p.bEl.savedCustomerSelect.value = "";
  p.api.onSavedCustomerChange();
  check("clearing the box on a saved bill keeps its snapshot",
    p.bState.currentCustomerBalance, 300);
}

console.log("\n=== findCustomerIdx ===");
{
  const p = page([YASWANT, SANJAY]);
  check("matches regardless of case",   p.api.findCustomerIdx("dr. YASWANT"), 0);
  check("ignores surrounding spaces",   p.api.findCustomerIdx("  Dr. Sanjay "), 1);
  check("a blank name matches nobody",  p.api.findCustomerIdx("   "), -1);
  check("an unknown name matches nobody", p.api.findCustomerIdx("Nobody"), -1);
}

console.log(fails ? `\n${fails} FAILED` : "\nAll passed");
process.exit(fails ? 1 : 0);
