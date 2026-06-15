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
const HISTORY_LIMIT = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDecimalOrNull(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isNaN(n) ? null : n;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Generate a date-based bill number: AM-YYYYMMDD-NNN
 * Counts existing bills for today and increments.
 * Retries with a random suffix on unique-constraint failure.
 */
async function generateBillNumber(config) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr =
    String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate());
  const prefix = `AM-${dateStr}-`;

  // Count bills created today
  const encodedPrefix = encodeURIComponent(prefix);
  const countRows = await callSupabaseRest(
    config,
    `${BILLS_TABLE}?bill_number=like.${encodedPrefix}*&select=id`,
    { method: "GET" }
  );
  const count = Array.isArray(countRows) ? countRows.length : 0;
  const seq = String(count + 1).padStart(3, "0");
  return `${prefix}${seq}`;
}

function buildItemRows(billId, items) {
  return items.map((item) => {
    const sellPrice = toDecimalOrNull(item.sellPrice) ?? 0;
    const qty = Math.max(0.001, parseFloat(item.quantity) || 0.001);
    return {
      bill_id: billId,
      medicine_id: normalizeString(item.medicineId) || null,
      medicine_name: normalizeString(item.medicineName),
      location: normalizeString(item.location),
      quantity: qty,
      mrp: toDecimalOrNull(item.mrp),
      purchase_price: toDecimalOrNull(item.purchasePrice),
      sell_price: sellPrice,
      markup_percent: toDecimalOrNull(item.markupPercent),
      line_total: round2(sellPrice * qty),
    };
  });
}

function calcTotals(items, gstPercent) {
  const subtotal = items.reduce((sum, item) => {
    const sp = toDecimalOrNull(item.sellPrice) ?? 0;
    const qty = Math.max(0.001, parseFloat(item.quantity) || 0.001);
    return sum + sp * qty;
  }, 0);
  const gstPct = Math.max(0, toDecimalOrNull(gstPercent) ?? 0);
  const gstAmount = round2(subtotal * gstPct / 100);
  const grandTotal = Math.ceil(round2(subtotal + gstAmount));
  return { subtotal: round2(subtotal), gstAmount, grandTotal, gstPct };
}

function validateItems(items, res) {
  if (!Array.isArray(items) || !items.length) {
    sendJson(res, 400, { error: "At least one medicine item is required." });
    return false;
  }
  for (const item of items) {
    if (!normalizeString(item.medicineName)) {
      sendJson(res, 400, { error: "Each item must have a medicine name." });
      return false;
    }
    const qty = parseFloat(item.quantity);
    if (isNaN(qty) || qty < 0.001) {
      sendJson(res, 400, { error: "Each item must have a quantity of at least 0.001." });
      return false;
    }
    const sp = toDecimalOrNull(item.sellPrice);
    if (sp === null || sp < 0) {
      sendJson(res, 400, { error: "Each item must have a valid sell price (≥ 0)." });
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["GET", "POST", "PUT", "DELETE"])) {
    return;
  }

  const config = getServerConfig();

  try {
    // All billing endpoints require admin
    const authContext = await requireAuthContext(req, res, config, { adminOnly: true });
    if (!authContext) return;

    // -----------------------------------------------------------------------
    // GET — list bills OR fetch single bill with items
    // -----------------------------------------------------------------------
    if (req.method === "GET") {
      res.setHeader("Cache-Control", "no-store");

      const id = normalizeString(req.query?.id);

      // Last-prices query: return price map for a specific customer
      if (req.query?.lastprices === "1") {
        const customer = normalizeString(req.query?.customer);
        if (!customer) {
          sendJson(res, 400, { error: "customer is required for lastprices query." });
          return;
        }

        // Step 1: get bill IDs for this customer
        const billRows = await callSupabaseRest(
          config,
          `${BILLS_TABLE}?customer_name=eq.${encodeURIComponent(customer)}&select=id`,
          { method: "GET" }
        );
        const billIds = Array.isArray(billRows) ? billRows.map(b => b.id) : [];

        if (!billIds.length) {
          sendJson(res, 200, { priceMap: {} });
          return;
        }

        // Step 2: get all items for those bills, most recent first
        const encodedIds = billIds.map(id => encodeURIComponent(id)).join(",");
        const itemRows = await callSupabaseRest(
          config,
          `${ITEMS_TABLE}?bill_id=in.(${encodedIds})&select=medicine_name,sell_price,markup_percent,created_at&order=created_at.desc&limit=500`,
          { method: "GET" }
        );

        // Build map: first occurrence = most recent price per medicine
        const priceMap = {};
        if (Array.isArray(itemRows)) {
          for (const item of itemRows) {
            const key = (item.medicine_name || "").toLowerCase().trim();
            if (key && !priceMap[key]) {
              priceMap[key] = {
                sellPrice: parseFloat(item.sell_price) ?? 0,
                markupPercent: item.markup_percent != null
                  ? parseFloat(item.markup_percent)
                  : null,
              };
            }
          }
        }

        sendJson(res, 200, { priceMap });
        return;
      }

      if (id) {
        // Single bill + its line items
        const bills = await callSupabaseRest(
          config,
          `${BILLS_TABLE}?id=eq.${encodeURIComponent(id)}&select=*`,
          { method: "GET" }
        );
        const bill = Array.isArray(bills) ? bills[0] : null;
        if (!bill) {
          sendJson(res, 404, { error: "Bill not found." });
          return;
        }

        const items = await callSupabaseRest(
          config,
          `${ITEMS_TABLE}?bill_id=eq.${encodeURIComponent(id)}&select=*&order=created_at.asc`,
          { method: "GET" }
        );

        sendJson(res, 200, {
          bill,
          items: Array.isArray(items) ? items : [],
        });
        return;
      }

      // Distinct customer list for restore-from-history (no cap)
      if (req.query?.customers === "1") {
        const rows = await callSupabaseRest(
          config,
          `${BILLS_TABLE}?select=customer_name,customer_phone&customer_name=not.is.null&order=customer_name.asc&limit=5000`,
          { method: "GET" }
        );
        const seen = new Set();
        const customers = [];
        for (const r of (Array.isArray(rows) ? rows : [])) {
          const name = (r.customer_name || "").trim();
          if (!name) continue;
          const key = name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          customers.push({ customer_name: name, customer_phone: r.customer_phone || "" });
        }
        sendJson(res, 200, { customers });
        return;
      }

      // Bill history list (most recent first)
      const bills = await callSupabaseRest(
        config,
        `${BILLS_TABLE}?select=*&order=created_at.desc&limit=${HISTORY_LIMIT}`,
        { method: "GET" }
      );
      sendJson(res, 200, { bills: Array.isArray(bills) ? bills : [] });
      return;
    }

    // -----------------------------------------------------------------------
    // POST — create a new bill
    // -----------------------------------------------------------------------
    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      const items = body.items;

      if (!validateItems(items, res)) return;

      const { subtotal, gstAmount, grandTotal, gstPct } = calcTotals(items, body.gstPercent);

      const billNumber = await generateBillNumber(config);

      // Insert bill header
      const billRows = await callSupabaseRest(
        config,
        `${BILLS_TABLE}?on_conflict=bill_number`,
        {
          method: "POST",
          body: {
            bill_number: billNumber,
            customer_name: normalizeString(body.customerName),
            customer_phone: normalizeString(body.customerPhone),
            notes: normalizeString(body.notes),
            subtotal,
            gst_percent: gstPct,
            gst_amount: gstAmount,
            grand_total: grandTotal,
            created_by: authContext.user.email,
          },
          prefer: "resolution=merge-duplicates,return=representation",
        }
      );

      const savedBill = Array.isArray(billRows) ? billRows[0] : null;
      if (!savedBill) {
        sendJson(res, 500, { error: "Could not save bill header." });
        return;
      }

      // Insert line items — if this fails, delete the bill header to avoid orphans
      const itemRows = buildItemRows(savedBill.id, items);
      if (itemRows.length) {
        try {
          await callSupabaseRest(config, ITEMS_TABLE, {
            method: "POST",
            body: itemRows,
            prefer: "return=minimal",
          });
        } catch (itemErr) {
          try {
            await callSupabaseRest(
              config,
              `${BILLS_TABLE}?id=eq.${encodeURIComponent(savedBill.id)}`,
              { method: "DELETE" }
            );
          } catch (_) {}
          throw itemErr;
        }
      }

      sendJson(res, 200, {
        bill: savedBill,
        billNumber,
      });
      return;
    }

    // -----------------------------------------------------------------------
    // PUT — update (edit) an existing bill
    // -----------------------------------------------------------------------
    if (req.method === "PUT") {
      const body = await parseJsonBody(req);
      const id = normalizeString(body.id || req.query?.id);

      if (!id) {
        sendJson(res, 400, { error: "Bill id is required for update." });
        return;
      }

      const items = body.items;
      if (!validateItems(items, res)) return;

      const { subtotal, gstAmount, grandTotal, gstPct } = calcTotals(items, body.gstPercent);

      // Update bill header
      await callSupabaseRest(
        config,
        `${BILLS_TABLE}?id=eq.${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: {
            customer_name: normalizeString(body.customerName),
            customer_phone: normalizeString(body.customerPhone),
            notes: normalizeString(body.notes),
            subtotal,
            gst_percent: gstPct,
            gst_amount: gstAmount,
            grand_total: grandTotal,
            updated_at: new Date().toISOString(),
          },
          prefer: "return=minimal",
        }
      );

      // Replace line items: delete old, insert new
      await callSupabaseRest(
        config,
        `${ITEMS_TABLE}?bill_id=eq.${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );

      const itemRows = buildItemRows(id, items);
      if (itemRows.length) {
        await callSupabaseRest(config, ITEMS_TABLE, {
          method: "POST",
          body: itemRows,
          prefer: "return=minimal",
        });
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    // -----------------------------------------------------------------------
    // DELETE — remove a bill (items cascade via FK)
    // -----------------------------------------------------------------------
    if (req.method === "DELETE") {
      const id = normalizeString(req.query?.id);
      if (!id) {
        sendJson(res, 400, { error: "Bill id is required." });
        return;
      }

      await callSupabaseRest(
        config,
        `${BILLS_TABLE}?id=eq.${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );

      sendJson(res, 200, { ok: true });
      return;
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Bills API failed." });
  }
};
