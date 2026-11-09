"use strict";

// All financial mutations are a single database RPC transaction. Never fall
// back to separate header/item/customer REST writes when the migration is absent.
const { callSupabaseRest, normalizeString, sendJson } = require("./supabase-server");

class FinancialInputError extends Error {
  constructor(message, code = "INVALID_FINANCIAL_INPUT", status = 400) {
    super(message); this.code = code; this.status = status;
  }
}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FinancialInputError("A JSON object is required.");
  return value;
}

function decimal(value, label, scale = 2, { optional = false, signed = false, max = 99999999.99 } = {}) {
  if (value === null || value === undefined || value === "") {
    if (optional) return null;
    throw new FinancialInputError(`${label} is required.`);
  }
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!new RegExp(`^${signed ? "-?" : ""}\\d+(?:\\.\\d{1,${scale}})?$`).test(text)) {
    throw new FinancialInputError(`${label} must be a finite decimal with at most ${scale} decimal places.`);
  }
  const n = Number(text);
  if (!Number.isFinite(n) || Math.abs(n) > max) throw new FinancialInputError(`${label} is outside the supported range.`);
  return n;
}

function text(value, label, max, required = false) {
  if (value !== undefined && value !== null && typeof value !== "string") throw new FinancialInputError(`${label} must be text.`);
  const result = normalizeString(value);
  if ((required && !result) || result.length > max) throw new FinancialInputError(`${label} must contain ${required ? "1" : "0"} to ${max} characters.`);
  return result;
}

function uuid(value, label = "id", optional = true) {
  if ((value === undefined || value === null || value === "") && optional) return null;
  const s = String(value || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) throw new FinancialInputError(`${label} must be a valid UUID.`);
  return s;
}

function operationId(value) {
  const s = String(value || "");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(s)) throw new FinancialInputError("Refresh this page and retry: a transaction operationId is required.", "OPERATION_ID_REQUIRED");
  return s;
}

function moneyUnits(value) { return BigInt(Math.round(value * 100)); }
function roundDivide(n, divisor) { return (n + divisor / 2n) / divisor; }

function validateItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 5000) throw new FinancialInputError("A bill must contain 1 to 5000 medicine lines.");
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new FinancialInputError("Every medicine line must be an object.");
    const quantity = decimal(item.quantity, "Quantity", 3, { max: 9999999.999 });
    if (quantity < 0.001) throw new FinancialInputError("Quantity must be at least 0.001.");
    const sellPrice = decimal(item.sellPrice, "Sell price");
    const row = {
      medicineId: uuid(item.medicineId, "Medicine id"),
      medicineName: text(item.medicineName, "Medicine name", 240, true),
      location: text(item.location, "Location", 120), quantity, sellPrice,
      mrp: decimal(item.mrp, "MRP", 2, { optional: true }),
      purchasePrice: decimal(item.purchasePrice, "Purchase price", 2, { optional: true }),
      markupPercent: decimal(item.markupPercent, "Markup", 2, { optional: true, signed: true, max: 9999.99 }),
      batchNo: text(item.batchNo, "Batch", 120), expiry: text(item.expiry, "Expiry", 60),
    };
    if (item.billOnly !== undefined && typeof item.billOnly !== "boolean") throw new FinancialInputError("billOnly must be true or false.");
    if (item.billOnly === true) {
      if (row.medicineId) throw new FinancialInputError("Bill-only lines cannot reference inventory.");
      row.billOnly = true;
    }
    const total = roundDivide(moneyUnits(sellPrice) * BigInt(Math.round(quantity * 1000)), 1000n);
    if (total > 9999999999n) throw new FinancialInputError("A medicine line total is outside the supported range.");
    return row;
  });
}

function totals(items, gstPercent) {
  const subtotal = items.reduce((s, i) => s + roundDivide(moneyUnits(i.sellPrice) * BigInt(Math.round(i.quantity * 1000)), 1000n), 0n);
  const tax = roundDivide(subtotal * BigInt(Math.round(gstPercent * 100)), 10000n);
  const grand = ((subtotal + tax + 99n) / 100n) * 100n;
  if (grand > 9999999999n) throw new FinancialInputError("The bill total is outside the supported range.");
  return { subtotal: Number(subtotal) / 100, gstAmount: Number(tax) / 100, grandTotal: Number(grand) / 100 };
}

function date(value, label = "Date") {
  const s = text(value, label, 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new FinancialInputError(`${label} must use YYYY-MM-DD.`);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new FinancialInputError(`${label} is not a valid calendar date.`);
  return s;
}

function validateBill(body, editing = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinancialInputError("A bill object is required.");
  const items = validateItems(body.items);
  if (body.confirmReassignment !== undefined && typeof body.confirmReassignment !== "boolean") throw new FinancialInputError("confirmReassignment must be true or false.");
  const gstPercent = decimal(body.gstPercent ?? 0, "GST percentage", 2, { max: 100 });
  const amountReceived = decimal(body.amountReceived ?? 0, "Amount received");
  const result = {
    ...body, operationId: operationId(body.operationId),
    id: uuid(body.id, "Bill id", !editing), customerId: uuid(body.customerId ?? body.customer_id, "Customer id"),
    customerName: text(body.customerName, "Customer name", 120),
    customerPhone: text(body.customerPhone, "Customer phone", 40), notes: text(body.notes, "Notes", 4000),
    items, gstPercent, amountReceived,
  };
  delete result.customer_id;
  for (const k of ["previousBalance", "initialOpeningBalance", "expectedBalance"]) {
    if (body[k] !== undefined && body[k] !== null) result[k] = decimal(body[k], k, 2, { signed: true });
  }
  if (editing && !body.expectedUpdatedAt) throw new FinancialInputError("Reload the bill before editing it: its expectedUpdatedAt version is required.", "BILL_VERSION_REQUIRED", 409);
  if (editing && (!Number.isSafeInteger(Number(body.expectedVersion)) || Number(body.expectedVersion) < 1)) throw new FinancialInputError("Reload the bill before editing it: its expectedVersion is required.", "BILL_VERSION_REQUIRED", 409);
  if (editing && !Number.isFinite(Date.parse(body.expectedUpdatedAt))) throw new FinancialInputError("Invalid bill version.");
  const calculated = totals(items, gstPercent);
  if (!result.customerId && !result.customerName && amountReceived !== calculated.grandTotal) throw new FinancialInputError("A customer is required for unpaid bills or customer credit.");
  return result;
}

async function read(config, request) {
  const rpc = ["lastprices", "soldcounts", "capabilities", "medicine_sales"].includes(request.kind) ? "rpc/billing_price_read" : "rpc/billing_read";
  const result = await callSupabaseRest(config, rpc, { method: "POST", body: { p_request: request } });
  const keys = { customers: "customers", bill: "items", payments: "payments", restore_customers: "customers", bills: "bills", medicine_sales: "sales" };
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      (keys[request.kind] && !Array.isArray(result[keys[request.kind]])) ||
      (request.kind === "bill" && !result.bill) ||
      (request.kind === "lastprices" && (!result.priceMap || typeof result.priceMap !== "object")) ||
      (request.kind === "soldcounts" && (!result.counts || typeof result.counts !== "object"))) throw new Error("Incomplete financial read response.");
  return result;
}

async function mutate(config, action, data, actor) {
  operationId(data.operationId);
  if ((Array.isArray(data.bills) ? data.bills : [data]).some(b => Array.isArray(b.items) && b.items.some(i => i.billOnly))) {
    const features = await read(config, { kind: "capabilities" });
    if (!features.billOnly) throw new FinancialInputError("Apply the bill-only database upgrade first.", "FINANCIAL_SCHEMA_REQUIRED", 503);
  }
  const result = await callSupabaseRest(config, "rpc/billing_mutate", { method: "POST", body: { p_action: action, p_data: data, p_actor: actor } });
  const required = { bill_create: "bill", bill_update: "bill", payment_create: "payment", payment_delete: "payment", customer_save: "customer", customer_archive: "customer", customers_reconcile: "customers", import_bills: "results", repair: "customer", bill_delete: "deletedBill" };
  if (!result || typeof result !== "object" || Array.isArray(result) || !result[required[action]]) throw new Error("Unconfirmed financial write response.");
  return result;
}

function fail(res, error) {
  const message = String(error.message || "");
  if (error instanceof FinancialInputError) return sendJson(res, error.status, { error: message, code: error.code });
  if (/PGRST202|could not find.*billing_|function.*billing_.*does not exist|schema cache.*billing_/i.test(message + " " + (error.code || ""))) {
    return sendJson(res, 503, { error: "Billing database upgrade is required. Apply the staged atomic ledger migration before using billing.", code: "FINANCIAL_SCHEMA_REQUIRED" });
  }
  const matched = /BILLING_([A-Z_]+):\s*([^\n]*)/.exec(message);
  if (matched) {
    const code = matched[1];
    return sendJson(res, code === "NOT_FOUND" ? 404 : ["CONFLICT", "ARCHIVED", "OPERATION_REUSED", "MANUAL_BALANCE_REQUIRES_ADJUSTMENT"].includes(code) ? 409 : 400, { error: matched[2], code });
  }
  return sendJson(res, 503, { error: "The complete financial ledger is unavailable. Nothing has been reported as saved; retry with the same operationId.", code: "FINANCIAL_LEDGER_UNAVAILABLE" });
}

module.exports = { FinancialInputError, object, decimal, text, uuid, operationId, validateItems, totals, date, validateBill, read, mutate, fail };
