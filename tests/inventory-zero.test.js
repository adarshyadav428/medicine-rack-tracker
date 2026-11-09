"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const src = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const numeric = src.slice(src.indexOf("function normalizeString("), src.indexOf("function normalizeDateOnly("));
const decimal = src.slice(src.indexOf("function normalizeDecimal("), src.indexOf("function normalizeItem("));
const { normalizePositiveInteger, normalizeDecimal } = new Function(numeric + decimal + "; return {normalizePositiveInteger,normalizeDecimal};")();
for (const [label, actual, expected] of [
  ["numeric zero stock remains recorded", normalizePositiveInteger(0), 0],
  ["text zero stock remains recorded", normalizePositiveInteger("0"), 0],
  ["null stock stays unknown", normalizePositiveInteger(null), null],
  ["missing stock stays unknown", normalizePositiveInteger(undefined), null],
  ["numeric zero MRP/purchase/sell remains recorded", normalizeDecimal(0), 0],
  ["text zero price remains recorded", normalizeDecimal("0"), 0],
  ["null price stays unknown", normalizeDecimal(null), null],
  ["blank price stays unknown", normalizeDecimal(""), null],
  ["missing price stays unknown", normalizeDecimal(undefined), null]
]) { assert.equal(actual, expected, label); console.log("PASS " + label); }
