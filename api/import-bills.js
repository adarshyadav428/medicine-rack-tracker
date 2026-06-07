const {
  allowMethods,
  callSupabaseRest,
  getServerConfig,
  normalizeString,
  parseJsonBody,
  requireAuthContext,
  sendJson,
} = require("../lib/supabase-server");

const BILLS_TABLE = "bills";
const ITEMS_TABLE = "bill_items";

function round2(n) { return Math.round(n * 100) / 100; }
function toNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

function parseDate(str) {
  const s = (str || "").trim();
  if (!s) return new Date().toISOString();
  // DD/MM/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split("/");
    return new Date(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}T00:00:00Z`).toISOString();
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00Z`).toISOString();
  }
  return new Date().toISOString();
}

async function generateBillNumberForDate(config, isoDate) {
  const d = new Date(isoDate);
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = String(d.getUTCFullYear()) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
  const prefix = `AM-${dateStr}-`;
  const rows = await callSupabaseRest(
    config,
    `${BILLS_TABLE}?bill_number=like.${encodeURIComponent(prefix)}*&select=id`,
    { method: "GET" }
  );
  const count = Array.isArray(rows) ? rows.length : 0;
  return `${prefix}${String(count + 1).padStart(3, "0")}`;
}

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["POST"])) return;

  const config = getServerConfig();

  try {
    const authContext = await requireAuthContext(req, res, config, { adminOnly: true });
    if (!authContext) return;

    const body = await parseJsonBody(req);
    const rows = body.rows;

    if (!Array.isArray(rows) || !rows.length) {
      sendJson(res, 400, { error: "No rows provided." });
      return;
    }

    // Group rows by bill_number; blank bill_number → each row is its own bill
    const groups = [];
    const seen = new Map();

    for (const row of rows) {
      const bn = normalizeString(row.bill_number);
      if (bn) {
        if (seen.has(bn)) {
          seen.get(bn).rows.push(row);
        } else {
          const g = { billNumber: bn, rows: [row] };
          seen.set(bn, g);
          groups.push(g);
        }
      } else {
        groups.push({ billNumber: "", rows: [row] });
      }
    }

    const results = [];

    for (const group of groups) {
      const firstRow = group.rows[0];
      const createdAt = parseDate(firstRow.date);

      let billNumber = group.billNumber;

      if (billNumber) {
        // Check for duplicate
        const existing = await callSupabaseRest(
          config,
          `${BILLS_TABLE}?bill_number=eq.${encodeURIComponent(billNumber)}&select=id`,
          { method: "GET" }
        );
        if (Array.isArray(existing) && existing.length) {
          results.push({ bill_number: billNumber, status: "skipped", message: "Already exists." });
          continue;
        }
      } else {
        billNumber = await generateBillNumberForDate(config, createdAt);
      }

      // Build line items
      const items = group.rows
        .filter((r) => normalizeString(r.medicine_name))
        .map((r) => {
          const qty = Math.max(0.001, parseFloat(r.quantity) || 1);
          const sp = toNum(r.sell_price) ?? 0;
          return {
            medicine_name:  normalizeString(r.medicine_name),
            location:       normalizeString(r.location) || "",
            quantity:       qty,
            mrp:            toNum(r.mrp),
            purchase_price: toNum(r.purchase_price),
            sell_price:     sp,
            markup_percent: null,
            line_total:     round2(sp * qty),
          };
        });

      if (!items.length) {
        results.push({ bill_number: billNumber, status: "error", message: "No valid medicine rows." });
        continue;
      }

      const gstPct    = Math.max(0, toNum(firstRow.gst_percent) ?? 0);
      const subtotal  = round2(items.reduce((s, it) => s + it.line_total, 0));
      const gstAmount = round2(subtotal * gstPct / 100);
      const grandTotal = Math.ceil(round2(subtotal + gstAmount));

      try {
        const billRows = await callSupabaseRest(config, BILLS_TABLE, {
          method: "POST",
          body: {
            bill_number:    billNumber,
            customer_name:  normalizeString(firstRow.customer_name) || "",
            customer_phone: normalizeString(firstRow.customer_phone) || "",
            notes:          normalizeString(firstRow.notes) || "",
            subtotal,
            gst_percent:    gstPct,
            gst_amount:     gstAmount,
            grand_total:    grandTotal,
            created_by:     authContext.user.email,
            created_at:     createdAt,
            updated_at:     createdAt,
          },
          prefer: "return=representation",
        });

        const savedBill = Array.isArray(billRows) ? billRows[0] : null;
        if (!savedBill) throw new Error("Bill insert returned no data.");

        await callSupabaseRest(config, ITEMS_TABLE, {
          method: "POST",
          body: items.map((it) => ({ ...it, bill_id: savedBill.id })),
          prefer: "return=minimal",
        });

        results.push({ bill_number: billNumber, status: "ok" });
      } catch (err) {
        // Attempt rollback if bill was created
        results.push({ bill_number: billNumber, status: "error", message: err.message });
      }
    }

    const ok      = results.filter((r) => r.status === "ok").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const errors  = results.filter((r) => r.status === "error").length;

    sendJson(res, 200, { ok, skipped, errors, results });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Import failed." });
  }
};
