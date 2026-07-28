const {
  allowMethods,
  callSupabaseRest,
  getServerConfig,
  normalizeString,
  parseJsonBody,
  requireAuthContext,
  sendJson,
} = require("../lib/supabase-server");

const CUSTOMERS_TABLE = "customers";
const BILLS_TABLE = "bills";
const PAYMENTS_TABLE = "payments";
const PAGE_SIZE = 1000;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toNum(val) {
  const n = parseFloat(val);
  return Number.isNaN(n) ? 0 : n;
}

/** Customers, bills and payments are all matched on the trimmed lowercase name. */
function nameKey(name) {
  return normalizeString(name).toLowerCase();
}

/** Page through a table so large histories are never silently truncated. */
async function fetchAll(config, table, select, order) {
  const all = [];
  let offset = 0;

  for (;;) {
    const rows = await callSupabaseRest(
      config,
      `${table}?select=${select}&order=${order}&limit=${PAGE_SIZE}&offset=${offset}`,
      { method: "GET" }
    );
    const batch = Array.isArray(rows) ? rows : [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return all;
    offset += PAGE_SIZE;
  }
}

/**
 * Derive every customer's balance from their bills and payments.
 *
 *   balance = opening_balance
 *           + Σ (grand_total - amount_received)
 *           - Σ (payments)
 *
 * Nothing is read from a stored running total, so a corrected bill or a
 * deleted payment is reflected the moment it changes.
 */
async function buildCustomerList(config) {
  const [customers, bills, payments] = await Promise.all([
    fetchAll(config, CUSTOMERS_TABLE, "*", "name.asc"),
    fetchAll(
      config,
      BILLS_TABLE,
      "id,bill_number,customer_name,customer_phone,grand_total,amount_received,created_at",
      "created_at.asc"
    ),
    fetchAll(config, PAYMENTS_TABLE, "id,customer_name,amount,created_at", "created_at.asc")
      .catch(() => []),
  ]);

  const byKey = new Map();

  for (const customer of customers) {
    byKey.set(normalizeString(customer.name_key) || nameKey(customer.name), {
      id: customer.id,
      name: normalizeString(customer.name),
      phone: normalizeString(customer.phone),
      openingBalance: round2(toNum(customer.opening_balance)),
      billCount: 0,
      totalBilled: 0,
      totalReceived: 0,
      paymentCount: 0,
      totalPayments: 0,
      lastActivityAt: null,
    });
  }

  // A bill or payment for someone not in the customers table still needs to be
  // visible, so create an implicit entry rather than dropping their money.
  function ensure(key, name, phone) {
    if (!key) return null;
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: null,
        name: normalizeString(name),
        phone: normalizeString(phone),
        openingBalance: 0,
        billCount: 0,
        totalBilled: 0,
        totalReceived: 0,
        paymentCount: 0,
        totalPayments: 0,
        lastActivityAt: null,
        unsaved: true,
      });
    }
    return byKey.get(key);
  }

  function noteActivity(entry, when) {
    if (!when) return;
    if (!entry.lastActivityAt || String(when) > String(entry.lastActivityAt)) {
      entry.lastActivityAt = when;
    }
  }

  for (const bill of bills) {
    const key = nameKey(bill.customer_name);
    if (!key) continue; // walk-in
    const entry = ensure(key, bill.customer_name, bill.customer_phone);
    entry.billCount += 1;
    entry.totalBilled += Math.ceil(toNum(bill.grand_total));
    entry.totalReceived += toNum(bill.amount_received);
    if (!entry.phone && normalizeString(bill.customer_phone)) {
      entry.phone = normalizeString(bill.customer_phone);
    }
    noteActivity(entry, bill.created_at);
  }

  for (const payment of payments) {
    const key = nameKey(payment.customer_name);
    if (!key) continue;
    const entry = ensure(key, payment.customer_name, "");
    entry.paymentCount += 1;
    entry.totalPayments += toNum(payment.amount);
    noteActivity(entry, payment.created_at);
  }

  return [...byKey.values()]
    .map((entry) => ({
      ...entry,
      totalBilled: round2(entry.totalBilled),
      totalReceived: round2(entry.totalReceived),
      totalPayments: round2(entry.totalPayments),
      balance: round2(
        entry.openingBalance + entry.totalBilled - entry.totalReceived - entry.totalPayments
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["GET", "POST", "PUT", "DELETE"])) return;

  const config = getServerConfig();

  try {
    const authContext = await requireAuthContext(req, res, config, { adminOnly: true });
    if (!authContext) return;

    res.setHeader("Cache-Control", "no-store");

    // -----------------------------------------------------------------------
    // GET — the customer list with derived balances
    // -----------------------------------------------------------------------
    if (req.method === "GET") {
      sendJson(res, 200, { customers: await buildCustomerList(config) });
      return;
    }

    // -----------------------------------------------------------------------
    // POST — create or update a customer (upsert on name)
    // -----------------------------------------------------------------------
    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      const name = normalizeString(body.name);

      if (!name) {
        sendJson(res, 400, { error: "Customer name is required." });
        return;
      }

      const row = {
        name,
        name_key: nameKey(name),
        phone: normalizeString(body.phone),
        created_by: authContext.user.email,
        updated_at: new Date().toISOString(),
      };

      // Only touch the opening balance when the caller actually sent one, so a
      // plain phone-number edit can never silently zero it.
      if (body.openingBalance !== undefined && body.openingBalance !== null && body.openingBalance !== "") {
        row.opening_balance = round2(toNum(body.openingBalance));
      }

      const rows = await callSupabaseRest(config, `${CUSTOMERS_TABLE}?on_conflict=name_key`, {
        method: "POST",
        body: row,
        prefer: "resolution=merge-duplicates,return=representation",
      });

      const saved = Array.isArray(rows) ? rows[0] : null;
      if (!saved) {
        sendJson(res, 500, { error: "Could not save the customer." });
        return;
      }

      sendJson(res, 200, { customer: saved });
      return;
    }

    // -----------------------------------------------------------------------
    // PUT — bulk import (used once, to bring localStorage balances into the DB)
    // -----------------------------------------------------------------------
    if (req.method === "PUT") {
      const body = await parseJsonBody(req);
      const list = Array.isArray(body.customers) ? body.customers : [];

      if (!list.length) {
        sendJson(res, 400, { error: "No customers supplied to import." });
        return;
      }

      const rows = [];
      const seen = new Set();

      for (const entry of list) {
        const name = normalizeString(entry.name);
        const key = nameKey(name);
        if (!key || seen.has(key)) continue; // last-wins would be arbitrary; keep first
        seen.add(key);
        rows.push({
          name,
          name_key: key,
          phone: normalizeString(entry.phone),
          opening_balance: round2(toNum(entry.openingBalance)),
          created_by: authContext.user.email,
          updated_at: new Date().toISOString(),
        });
      }

      if (!rows.length) {
        sendJson(res, 400, { error: "None of the supplied customers had a usable name." });
        return;
      }

      await callSupabaseRest(config, `${CUSTOMERS_TABLE}?on_conflict=name_key`, {
        method: "POST",
        body: rows,
        prefer: "resolution=merge-duplicates,return=minimal",
      });

      sendJson(res, 200, { ok: true, imported: rows.length });
      return;
    }

    // -----------------------------------------------------------------------
    // DELETE — remove a saved customer (their bills and payments are untouched)
    // -----------------------------------------------------------------------
    if (req.method === "DELETE") {
      const id = normalizeString(req.query?.id);
      const name = normalizeString(req.query?.name);

      if (!id && !name) {
        sendJson(res, 400, { error: "Customer id or name is required." });
        return;
      }

      const filter = id
        ? `id=eq.${encodeURIComponent(id)}`
        : `name_key=eq.${encodeURIComponent(nameKey(name))}`;

      await callSupabaseRest(config, `${CUSTOMERS_TABLE}?${filter}`, { method: "DELETE" });

      sendJson(res, 200, { ok: true });
      return;
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Customers API failed." });
  }
};
