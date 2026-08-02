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
const SHOP_TIME_ZONE = "Asia/Kolkata";

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

/**
 * Next free bill number for a date: AM-YYYYMMDD-NNN
 *
 * Keyed off the highest sequence already issued that day, not the number of
 * bills. Counting rows handed out a number that was already taken whenever an
 * earlier bill had been deleted, and the insert then failed on the unique
 * constraint. `attempt` skips further ahead when a concurrent insert wins.
 */
async function generateBillNumberForDate(config, isoDate, attempt = 0) {
  // Stamped in shop time, matching api/bills.js. A CSV date is stored at UTC
  // midnight and reads back as the same calendar day in IST; a row with no
  // date falls back to now, which read in UTC put an import run before
  // 05:30 IST under the previous day.
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(isoDate))
    .replace(/-/g, "");
  const prefix = `AM-${dateStr}-`;
  const rows = await callSupabaseRest(
    config,
    `${BILLS_TABLE}?bill_number=like.${encodeURIComponent(prefix)}*&select=bill_number`,
    { method: "GET" }
  );

  let maxSeq = 0;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const match = /-(\d+)$/.exec(String(row.bill_number || ""));
      if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10) || 0);
    }
  }

  return `${prefix}${String(maxSeq + 1 + attempt).padStart(3, "0")}`;
}

function isDuplicateError(error) {
  return /duplicate|unique|conflict|23505/i.test(String(error?.message || ""));
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
        .map((r, index) => {
          const qty = Math.max(0.001, parseFloat(r.quantity) || 1);
          const sp = toNum(r.sell_price) ?? 0;
          return {
            medicine_name:  normalizeString(r.medicine_name),
            location:       normalizeString(r.location) || "",
            batch_no:       normalizeString(r.batch_no) || null,
            expiry:         normalizeString(r.expiry) || null,
            quantity:       qty,
            mrp:            toNum(r.mrp),
            purchase_price: toNum(r.purchase_price),
            sell_price:     sp,
            markup_percent: null,
            line_total:     round2(sp * qty),
            // Keeps the imported bill's lines in CSV order when it is reopened.
            sort_order:     index,
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

      // Without these the imported bill has no ledger snapshot at all, so every
      // imported sale read as fully unpaid and inflated the customer's balance.
      const previousBalance = round2(Math.max(0, toNum(firstRow.previous_balance) ?? 0));
      const amountReceived  = round2(Math.max(0, toNum(firstRow.amount_received) ?? 0));

      const header = {
        customer_name:    normalizeString(firstRow.customer_name) || "",
        customer_phone:   normalizeString(firstRow.customer_phone) || "",
        notes:            normalizeString(firstRow.notes) || "",
        subtotal,
        gst_percent:      gstPct,
        gst_amount:       gstAmount,
        grand_total:      grandTotal,
        previous_balance: previousBalance,
        amount_received:  amountReceived,
        balance_due:      round2(previousBalance + grandTotal - amountReceived),
        created_by:       authContext.user.email,
        created_at:       createdAt,
        updated_at:       createdAt,
      };

      try {
        // Only an auto-generated number may be retried: a number given in the
        // CSV was already checked for duplicates and must be honoured as-is.
        let savedBill = null;
        let lastError = null;
        const maxAttempts = group.billNumber ? 1 : 5;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          if (attempt > 0) {
            billNumber = await generateBillNumberForDate(config, createdAt, attempt);
          }
          try {
            const billRows = await callSupabaseRest(config, BILLS_TABLE, {
              method: "POST",
              body: { ...header, bill_number: billNumber },
              prefer: "return=representation",
            });
            savedBill = Array.isArray(billRows) ? billRows[0] : null;
            if (savedBill) break;
            lastError = new Error("Bill insert returned no data.");
          } catch (insertErr) {
            lastError = insertErr;
            if (!isDuplicateError(insertErr)) throw insertErr;
          }
        }

        if (!savedBill) throw lastError || new Error("Bill insert returned no data.");

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
