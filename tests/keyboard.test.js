/**
 * Keyboard-only billing.
 *
 * initKeyboardShortcuts is lifted out of billing.js the same way
 * batch-expiry.test.js lifts normalizeExpiry, and run against a hand-rolled
 * stand-in for document/bEl. What is being checked is the dispatch: which key
 * reaches which field, and — just as important — which keys are deliberately
 * ignored, because a hotkey that fires while a modal is open or while the
 * operator is typing Hindi would be worse than no hotkey at all.
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
  grab("  function initKeyboardShortcuts()", "\n  // ---") +
  "\n; module.exports = { initKeyboardShortcuts };";

let fails = 0;
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

/** Records what the shortcut did to it, so a test can assert on the effect. */
function makeField(name, log) {
  return {
    _name: name,
    disabled: false,
    focus() { log.push("focus:" + name); },
    select() { log.push("select:" + name); },
  };
}

function makeButton(name, log) {
  return {
    _name: name,
    disabled: false,
    click() { log.push("click:" + name); },
  };
}

/**
 * Builds a fresh world and returns { press, log, bEl, env } where press()
 * dispatches one synthetic keydown through the registered handler.
 */
function makeWorld(opts = {}) {
  const log = [];
  const bEl = {
    search:          makeField("search", log),
    customerName:    makeField("customerName", log),
    customerPhone:   makeField("customerPhone", log),
    notes:           makeField("notes", log),
    receivedAmount:  makeField("receivedAmount", log),
    historySearch:   makeField("historySearch", log),
    saveBillButton:  makeButton("save", log),
    printBillButton: makeButton("print", log),
    newBillButton:   makeButton("new", log),
    // offsetParent non-null == the billing page is on screen.
    billFormSection: { offsetParent: opts.pageHidden ? null : {} },
    receiptModal:    { classList: { contains: () => !opts.receiptOpen } },
  };

  let handler = null;
  const document = {
    addEventListener(type, fn) { if (type === "keydown") handler = fn; },
    querySelector(sel) {
      if (sel === ".manual-add-overlay") return opts.overlayOpen ? {} : null;
      return null;
    },
  };

  const mod = { exports: {} };
  new Function("module", "exports", "document", "bEl", code)(mod, mod.exports, document, bEl);
  mod.exports.initKeyboardShortcuts();

  function press(init) {
    let prevented = false;
    handler({
      key: init.key || "",
      code: init.code || "",
      altKey: !!init.altKey,
      ctrlKey: !!init.ctrlKey,
      metaKey: !!init.metaKey,
      preventDefault() { prevented = true; },
    });
    return prevented;
  }

  return { press, log, bEl };
}

// ---------------------------------------------------------------------------
// Field jumps
// ---------------------------------------------------------------------------

const JUMPS = [
  ["KeyM", "search"],
  ["KeyC", "customerName"],
  ["KeyH", "customerPhone"],
  ["KeyO", "notes"],
  ["KeyR", "receivedAmount"],
  ["KeyF", "historySearch"],
];

for (const [code_, field] of JUMPS) {
  const w = makeWorld();
  const prevented = w.press({ code: code_, key: "x", altKey: true });
  eq(`Alt+${code_.slice(3)} focuses ${field}`, w.log, ["focus:" + field, "select:" + field]);
  eq(`Alt+${code_.slice(3)} swallows the key`, prevented, true);
}

// F2 is the one shortcut with no modifier at all.
{
  const w = makeWorld();
  eq("F2 swallowed", w.press({ key: "F2", code: "F2" }), true);
  eq("F2 focuses the medicine search", w.log, ["focus:search", "select:search"]);
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

{
  const w = makeWorld();
  w.press({ code: "KeyS", key: "s", altKey: true });
  eq("Alt+S saves", w.log, ["click:save"]);
}
{
  const w = makeWorld();
  w.press({ code: "KeyN", key: "n", altKey: true });
  eq("Alt+N starts a new bill", w.log, ["click:new"]);
}
{
  const w = makeWorld();
  w.press({ code: "KeyI", key: "i", altKey: true });
  eq("Alt+I prints", w.log, ["click:print"]);
}
{
  const w = makeWorld();
  eq("Ctrl+Enter swallowed", w.press({ key: "Enter", ctrlKey: true }), true);
  eq("Ctrl+Enter saves from anywhere", w.log, ["click:save"]);
}
{
  const w = makeWorld();
  w.press({ key: "Enter", metaKey: true });
  eq("Cmd+Enter saves too", w.log, ["click:save"]);
}

// A disabled button must not fire: Print is disabled until a bill is saved,
// and clicking it anyway would print an empty receipt.
{
  const w = makeWorld();
  w.bEl.printBillButton.disabled = true;
  w.press({ code: "KeyI", key: "i", altKey: true });
  eq("Alt+I does nothing while Print is disabled", w.log, []);
}
{
  const w = makeWorld();
  w.bEl.receivedAmount.disabled = true;
  w.press({ code: "KeyR", key: "r", altKey: true });
  eq("a disabled field is not focused", w.log, []);
}

// ---------------------------------------------------------------------------
// What must NOT fire
// ---------------------------------------------------------------------------

// AltGr on an Indian layout reports as Ctrl+Alt. Treating it as Alt would make
// the shop unable to type half its characters.
{
  const w = makeWorld();
  const prevented = w.press({ code: "KeyC", key: "क", altKey: true, ctrlKey: true });
  eq("AltGr+C is left alone", w.log, []);
  eq("AltGr+C is not swallowed", prevented, false);
}

// Plain typing must never be intercepted — every field here is a text box.
{
  const w = makeWorld();
  const prevented = w.press({ code: "KeyS", key: "s" });
  eq("plain s types normally", w.log, []);
  eq("plain s is not swallowed", prevented, false);
}
{
  const w = makeWorld();
  w.press({ key: "Enter" });
  eq("bare Enter is left to the field handlers", w.log, []);
}

// Modals own the keyboard while they are open.
{
  const w = makeWorld({ overlayOpen: true });
  w.press({ code: "KeyS", key: "s", altKey: true });
  eq("no shortcuts while the add-medicine modal is open", w.log, []);
}
{
  const w = makeWorld({ receiptOpen: true });
  w.press({ code: "KeyM", key: "m", altKey: true });
  eq("no shortcuts while the receipt modal is open", w.log, []);
}
{
  const w = makeWorld({ receiptOpen: true });
  w.press({ key: "Enter", ctrlKey: true });
  eq("Ctrl+Enter does not save from behind the receipt modal", w.log, []);
}

// Another page of the app is showing.
{
  const w = makeWorld({ pageHidden: true });
  w.press({ code: "KeyS", key: "s", altKey: true });
  eq("no shortcuts when the billing form is off screen", w.log, []);
}

// An Alt combination we do not claim must pass through to the browser.
{
  const w = makeWorld();
  const prevented = w.press({ code: "KeyZ", key: "z", altKey: true });
  eq("unclaimed Alt+Z does nothing", w.log, []);
  eq("unclaimed Alt+Z is not swallowed", prevented, false);
}

// ---------------------------------------------------------------------------
// The on-screen map must not drift from the handler.
// ---------------------------------------------------------------------------
{
  const html = fs.readFileSync(path.join(PROJECT, "billing.html"), "utf8");
  const panel = html.slice(
    html.indexOf('<details class="bill-shortcuts">'),
    html.indexOf("</details>")
  );
  eq("shortcut panel exists", panel.length > 0, true);
  for (const letter of ["M", "C", "H", "O", "R", "S", "I", "N", "F"]) {
    eq(`panel documents Alt+${letter}`,
      panel.includes(`<kbd>Alt</kbd>+<kbd>${letter}</kbd>`), true);
  }
  eq("panel documents F2", panel.includes("<kbd>F2</kbd>"), true);
  eq("panel documents Ctrl+Enter",
    panel.includes("<kbd>Ctrl</kbd>+<kbd>Enter</kbd>"), true);
}

// The row-level bindings live in renderLineItems, not in the shortcut layer;
// assert the source still wires them rather than silently losing them.
{
  const rowBinding = grab("      function bindInput(el, field, onEnter)", "      bindInput(mrpInput");
  eq("Escape leaves a line-item field", rowBinding.includes('e.key === "Escape"'), true);
  eq("Alt+Delete removes the line",
    rowBinding.includes('e.altKey && (e.key === "Delete" || e.key === "Backspace")'), true);
  eq("row removal calls removeLineItem", rowBinding.includes("removeLineItem(item._rowId)"), true);
}

console.log(fails ? `\n${fails} FAILED` : "\nall keyboard assertions passed");
process.exit(fails ? 1 : 0);
