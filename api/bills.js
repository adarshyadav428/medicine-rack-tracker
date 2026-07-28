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
const PAGE_SIZE = 1000;

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
 *
 * Uses the highest sequence already issued today rather than the number of
 * bills, so deleting a bill can never hand its number to a later one.
 * `attempt` bumps the sequence further when a concurrent insert took it first.
 */
async function generateBillNumber(config, attempt = 0) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr =
    String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate());
  const prefix = `AM-${dateStr}-`;

  const encodedPrefix = encodeURIComponent(prefix);
  const rows = await callSupabaseRest(
    config,
    `${BILLS_TABLE}?bill_number=like.${encodedPrefix}*&select=bill_number`,
    { method: "GET" }
  );

  let maxSeq = 0;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const match = /-(\d+)$/.exec(String(row.bill_number || ""));
      if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10) || 0);
    }
  }

  const seq = String(maxSeq + 1 + attempt).padStart(3, "0");
  return `${prefix}${seq}`;
}

/**
 * Insert a bill header, retrying with a fresh number if the unique constraint
 * on bill_number collides — which happens when two tills save at the same
 * moment. Never merges on conflict, so an existing bill can never be
 * silently overwritten by a new one.
 */
async function insertBillHeader(config, headerBase) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const billNumber = await generateBillNumber(config, attempt);
    try {
      const rows = await callSupabaseRest(config, BILLS_TABLE, {
        method: "POST",
        body: { ...headerBase, bill_number: billNumber },
        prefer: "return=representation",
      });
      const savedBill = Array.isArray(rows) ? rows[0] : null;
      if (savedBill) return { savedBill, billNumber };
      lastError = new Error("Could not save bill header.");
    } catch (error) {
      lastError = error;
      if (!/duplicate|unique|conflict|23505/i.test(String(error.message || ""))) {
        throw error;
      }
      // Number was taken between our read and write — try the next one.
    }
  }

  throw lastError || new Error("Could not generate a unique bill number.");
}

function buildItemRows(billId, items) {
  return items.map((item, index) => {
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
      sort_order: index,
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

// ---------------------------------------------------------------------------
// Inventory — keep medicine stock in step with what has been billed
// ---------------------------------------------------------------------------

/** Accumulate a per-medicine change. Negative = sold, positive = returned. */
function addStockDelta(map, medicineId, deltaQty) {
  const id = normalizeString(medicineId);
  if (!id || !deltaQty) return;
  map.set(id, (map.get(id) || 0) + deltaQty);
}

/**
 * Apply accumulated stock changes. Best-effort by design: it runs after the
 * bill is already saved, so a stock write failing can never cost you a sale.
 * A medicine with unknown (null) stock is left alone rather than guessed at,
 * and stock never goes below zero.
 */
async function applyStockDeltas(config, deltaMap) {
  const ids = [...deltaMap.keys()].filter(Boolean);
  if (!ids.length) return;

  let rows = [];
  try {
    rows = await callSupabaseRest(
      config,
      `${config.tableName}?id=in.(${ids.map(encodeURIComponent).join(",")})&select=id,quantity`,
      { method: "GET" }
    );
  } catch {
    return; // Could not read current stock — leave it untouched.
  }

  const current = new Map();
  if (Array.isArray(rows)) {
    for (const row of rows) current.set(normalizeString(row.id), row.quantity);
  }

  for (const [id, delta] of deltaMap) {
    if (!current.has(id)) continue;                    // medicine deleted since
    const cur = current.get(id);
    if (cur === null || cur === undefined) continue;   // stock unknown — don't invent one
    const next = Math.max(0, Number(cur) + delta);
    if (next === Number(cur)) continue;
    try {
      await callSupabaseRest(
        config,
        `${config.tableName}?id=eq.${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: { quantity: next, updated_at: new Date().toISOString() },
          prefer: "return=minimal",
        }
      );
    } catch {
      // One medicine failing must not stop the rest.
    }
  }
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
          `${ITEMS_TABLE}?bill_id=eq.${encodeURIComponent(id)}&select=*&order=sort_order.asc,created_at.asc`,
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
        // Order by created_at desc so first occurrence per customer = most recent bill
        const rows = await callSupabaseRest(
          config,
          `${BILLS_TABLE}?select=customer_name,customer_phone&customer_name=not.is.null&order=created_at.desc&limit=5000`,
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

      // Bill history list (most recent first).
      //
      // Balance chaining and a customer's full history need every bill, not
      // just a recent window — a truncated list silently produces wrong
      // running balances. `?all=1` pages through the lot.
      if (req.query?.all === "1") {
        const all = [];
        let offset = 0;
        for (;;) {
          const page = await callSupabaseRest(
            config,
            `${BILLS_TABLE}?select=*&order=created_at.desc&limit=${PAGE_SIZE}&offset=${offset}`,
            { method: "GET" }
          );
          const batch = Array.isArray(page) ? page : [];
          all.push(...batch);
          if (batch.length < PAGE_SIZE) break;
          offset += PAGE_SIZE;
        }
        sendJson(res, 200, { bills: all });
        return;
      }

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
      const previousBalance = round2(toDecimalOrNull(body.previousBalance) ?? 0);
      const amountReceived = Math.max(0, round2(toDecimalOrNull(body.amountReceived) ?? 0));

      // Retries on a bill_number collision; never merges, so a live bill can
      // never be overwritten by a new one.
      const { savedBill, billNumber } = await insertBillHeader(config, {
        customer_name: normalizeString(body.customerName),
        customer_phone: normalizeString(body.customerPhone),
        notes: normalizeString(body.notes),
        subtotal,
        gst_percent: gstPct,
        gst_amount: gstAmount,
        grand_total: grandTotal,
        previous_balance: previousBalance,
        amount_received: amountReceived,
        balance_due: round2(previousBalance + grandTotal - amountReceived),
        created_by: authContext.user.email,
      });
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

      // Deduct the quantities just sold from inventory.
      const saleDeltas = new Map();
      for (const item of items) {
        addStockDelta(saleDeltas, item.medicineId, -(parseFloat(item.quantity) || 0));
      }
      await applyStockDeltas(config, saleDeltas);

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

      // Bulk ledger re-chain (Repair Balance): rewrite only the payment
      // columns on many bills at once, leaving their items untouched.
      if (Array.isArray(body.ledgerUpdates)) {
        let updated = 0;

        for (const entry of body.ledgerUpdates) {
          const billId = normalizeString(entry.id);
          if (!billId) continue;

          const prev = round2(toDecimalOrNull(entry.previousBalance) ?? 0);
          const recv = Math.max(0, round2(toDecimalOrNull(entry.amountReceived) ?? 0));
          const total = round2(toDecimalOrNull(entry.grandTotal) ?? 0);

          await callSupabaseRest(
            config,
            `${BILLS_TABLE}?id=eq.${encodeURIComponent(billId)}`,
            {
              method: "PATCH",
              body: {
                previous_balance: prev,
                amount_received: recv,
                balance_due: round2(prev + total - recv),
                updated_at: new Date().toISOString(),
              },
              prefer: "return=minimal",
            }
          );
          updated += 1;
        }

        sendJson(res, 200, { ok: true, updated });
        return;
      }

      const id = normalizeString(body.id || req.query?.id);

      if (!id) {
        sendJson(res, 400, { error: "Bill id is required for update." });
        return;
      }

      const items = body.items;
      if (!validateItems(items, res)) return;

      const { subtotal, gstAmount, grandTotal, gstPct } = calcTotals(items, body.gstPercent);
      const previousBalance = round2(toDecimalOrNull(body.previousBalance) ?? 0);
      const amountReceived = Math.max(0, round2(toDecimalOrNull(body.amountReceived) ?? 0));

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
            previous_balance: previousBalance,
            amount_received: amountReceived,
            balance_due: round2(previousBalance + grandTotal - amountReceived),
            updated_at: new Date().toISOString(),
          },
          prefer: "return=minimal",
        }
      );

      // Read the old items before replacing them: they are needed both to
      // restore stock and to put the bill back if the insert fails.
      const oldItems = await callSupabaseRest(
        config,
        `${ITEMS_TABLE}?bill_id=eq.${encodeURIComponent(id)}&select=*`,
        { method: "GET" }
      );

      await callSupabaseRest(
        config,
        `${ITEMS_TABLE}?bill_id=eq.${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );

      const itemRows = buildItemRows(id, items);
      if (itemRows.length) {
        try {
          await callSupabaseRest(config, ITEMS_TABLE, {
            method: "POST",
            body: itemRows,
            prefer: "return=minimal",
          });
        } catch (itemErr) {
          // Put the original items back rather than leaving an empty bill.
          if (Array.isArray(oldItems) && oldItems.length) {
            try {
              await callSupabaseRest(config, ITEMS_TABLE, {
                method: "POST",
                body: oldItems.map(({ id: _drop, created_at: _drop2, ...rest }) => rest),
                prefer: "return=minimal",
              });
            } catch {
              // Restore failed too — surface the original error below.
            }
          }
          throw itemErr;
        }
      }

      // Net stock change: give back what the bill used to contain, take what
      // it contains now.
      const editDeltas = new Map();
      if (Array.isArray(oldItems)) {
        for (const old of oldItems) {
          addStockDelta(editDeltas, old.medicine_id, parseFloat(old.quantity) || 0);
        }
      }
      for (const item of items) {
        addStockDelta(editDeltas, item.medicineId, -(parseFloat(item.quantity) || 0));
      }
      await applyStockDeltas(config, editDeltas);

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

      // Read the items before the cascade removes them, so stock can go back.
      const deletedItems = await callSupabaseRest(
        config,
        `${ITEMS_TABLE}?bill_id=eq.${encodeURIComponent(id)}&select=medicine_id,quantity`,
        { method: "GET" }
      );

      await callSupabaseRest(
        config,
        `${BILLS_TABLE}?id=eq.${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );

      const restockDeltas = new Map();
      if (Array.isArray(deletedItems)) {
        for (const item of deletedItems) {
          addStockDelta(restockDeltas, item.medicine_id, parseFloat(item.quantity) || 0);
        }
      }
      await applyStockDeltas(config, restockDeltas);

      sendJson(res, 200, { ok: true });
      return;
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Bills API failed." });
  }
};
