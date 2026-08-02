/**
 * Markup % on a bill line: always a definite figure, colour-coded by band.
 *
 * computeMarkup and markupBand are lifted out of billing.js the same way
 * batch-expiry.test.js lifts normalizeExpiry. The band boundaries are the
 * point of most of this — 15 and 25 are the edges the shop actually reads,
 * and an off-by-one there silently miscolours every bill.
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
  "function round2(n) { return Math.round(n * 100) / 100; }\n" +
  grab("  function computeMarkup(", "  function escHtml(") +
  "\n; module.exports = { computeMarkup, markupBand, applyMarkupBand, MARKUP_BAND_TITLE };";

const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { computeMarkup, markupBand, applyMarkupBand, MARKUP_BAND_TITLE } = mod.exports;

let fails = 0;
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

// ---------------------------------------------------------------------------
// computeMarkup — the fix for boxes that came up empty
// ---------------------------------------------------------------------------

eq("cost 100 sold 110 is 10%", computeMarkup(100, 110), 10);
eq("cost 80 sold 100 is 25%", computeMarkup(80, 100), 25);
eq("sold at cost is 0%", computeMarkup(50, 50), 0);
eq("sold below cost is negative", computeMarkup(100, 90), -10);
eq("rounded to two places", computeMarkup(3, 10), 233.33);
eq("string inputs are parsed", computeMarkup("40", "50"), 25);

// The cases that legitimately have no answer stay null rather than becoming a
// misleading 0 — 0% would read as "sold at cost", which is a real state.
eq("no purchase price is null", computeMarkup(null, 100), null);
eq("undefined purchase price is null", computeMarkup(undefined, 100), null);
eq("zero cost is null", computeMarkup(0, 100), null);
eq("negative cost is null", computeMarkup(-5, 100), null);
eq("no sell price is null", computeMarkup(100, null), null);
eq("blank string is null", computeMarkup("", 100), null);

// A freshly added line has both numbers, so it must never come up blank —
// this was the reported fault.
{
  const purchase = 42, sell = 50;
  eq("a new line always gets a figure", computeMarkup(purchase, sell) !== null, true);
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

eq("0% is thin", markupBand(0), "thin");
eq("4.99% is thin", markupBand(4.99), "thin");
eq("5% is healthy", markupBand(5), "healthy");
eq("10% is healthy", markupBand(10), "healthy");
eq("15% is still healthy", markupBand(15), "healthy");
eq("15.01% is high", markupBand(15.01), "high");
eq("20% is high", markupBand(20), "high");
eq("25% is still high", markupBand(25), "high");
eq("25.01% is steep", markupBand(25.01), "steep");
eq("60% is steep", markupBand(60), "steep");

// Below cost is its own band: it needs the opposite reaction to a thin margin.
eq("-0.01% is a loss", markupBand(-0.01), "loss");
eq("-30% is a loss", markupBand(-30), "loss");

// Unknown must never be coloured as a judgement about the price.
eq("null is none", markupBand(null), "none");
eq("undefined is none", markupBand(undefined), "none");
eq("NaN is none", markupBand(NaN), "none");

// A string figure off an input element still bands correctly.
eq("string 12 is healthy", markupBand("12"), "healthy");
eq("string 30 is steep", markupBand("30"), "steep");

// Every band has a tooltip, or a box gets a blank title on hover.
for (const band of ["none", "loss", "thin", "healthy", "high", "steep"]) {
  eq(`${band} has a tooltip`, typeof MARKUP_BAND_TITLE[band] === "string" &&
    MARKUP_BAND_TITLE[band].length > 0, true);
}

// ---------------------------------------------------------------------------
// applyMarkupBand — one band class at a time
// ---------------------------------------------------------------------------

function fakeInput() {
  const classes = new Set();
  return {
    title: "",
    classList: {
      add: (c) => classes.add(c),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      has: (c) => classes.has(c),
    },
    _classes: () => [...classes].sort(),
  };
}

{
  const el = fakeInput();
  applyMarkupBand(el, 10);
  eq("healthy class applied", el._classes(), ["markup-healthy"]);
  eq("tooltip set", el.title, MARKUP_BAND_TITLE.healthy);

  // Re-banding must not leave the old class behind, or a line that moved from
  // healthy to steep would carry both.
  applyMarkupBand(el, 40);
  eq("previous band cleared", el._classes(), ["markup-steep"]);
  eq("tooltip updated", el.title, MARKUP_BAND_TITLE.steep);

  applyMarkupBand(el, null);
  eq("unknown clears to none", el._classes(), ["markup-none"]);
}

// A missing element must not throw — the box is absent while a row re-renders.
{
  let threw = false;
  try { applyMarkupBand(null, 10); } catch (e) { threw = true; }
  eq("no element is a no-op", threw, false);
}

// ---------------------------------------------------------------------------
// The colouring must not reach the money
// ---------------------------------------------------------------------------
{
  // applyMarkupBand only ever touches classList and title.
  const body = grab("  function applyMarkupBand(", "  function escHtml(");
  eq("band painter does not set a value", body.includes(".value"), false);
  eq("band painter does not touch totals", /recalc|lineTotal|sellPrice/.test(body), false);

  // Every band name the script can produce has a stylesheet rule, and every
  // rule has a band — a typo either way shows as an uncoloured box.
  const css = fs.readFileSync(path.join(PROJECT, "styles.css"), "utf8");
  for (const band of ["none", "loss", "thin", "healthy", "high", "steep"]) {
    eq(`.markup-${band} is styled`, css.includes(`.markup-${band} {`), true);
  }

  // The line total is sell x qty and has nothing to do with markup.
  const render = grab("      var lineTotal =", "\n");
  eq("line total is sell x qty only", render.includes("item.sellPrice * item.quantity"), true);
  eq("line total ignores markup", render.includes("markup"), false);
}

console.log(fails ? `\n${fails} FAILED` : "\nall markup assertions passed");
process.exit(fails ? 1 : 0);
