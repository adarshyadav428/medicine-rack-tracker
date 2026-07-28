const {
  allowMethods,
  callSupabaseRest,
  getServerConfig,
  normalizeString,
  parseJsonBody,
  requireAuthContext,
  sendJson,
} = require("../lib/supabase-server");

const TABLE = "payments";
const PAGE_SIZE = 1000;

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["GET", "POST", "DELETE"])) return;

  const config = getServerConfig();

  try {
    const authContext = await requireAuthContext(req, res, config, { adminOnly: true });
    if (!authContext) return;

    res.setHeader("Cache-Control", "no-store");

    if (req.method === "GET") {
      const customer = normalizeString(req.query?.customer);
      if (!customer) {
        sendJson(res, 400, { error: "customer is required." });
        return;
      }

      // Balances match customers case-insensitively, so the history must too —
      // otherwise a name typed with different case shows a balance that counts
      // payments the customer's history does not list.
      // ilike casts the net wide (its wildcards can only over-match); the exact
      // normalized comparison below narrows it back.
      const rows = [];
      let offset = 0;
      for (;;) {
        const page = await callSupabaseRest(
          config,
          `${TABLE}?customer_name=ilike.${encodeURIComponent(customer)}` +
            `&order=created_at.desc&limit=${PAGE_SIZE}&offset=${offset}`,
          { method: "GET" }
        );
        const batch = Array.isArray(page) ? page : [];
        rows.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }

      const wanted = customer.trim().toLowerCase();
      const payments = rows.filter(
        (row) => normalizeString(row.customer_name).toLowerCase() === wanted
      );

      sendJson(res, 200, { payments });
      return;
    }

    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      const customerName = normalizeString(body?.customer_name);
      const amount = parseFloat(body?.amount);

      if (!customerName) {
        sendJson(res, 400, { error: "customer_name is required." });
        return;
      }
      if (isNaN(amount) || amount <= 0) {
        sendJson(res, 400, { error: "amount must be a positive number." });
        return;
      }

      const rows = await callSupabaseRest(config, TABLE, {
        method: "POST",
        body: {
          customer_name: customerName,
          customer_phone: normalizeString(body?.customer_phone) || null,
          amount,
          note: normalizeString(body?.note) || null,
          created_by: authContext.user.email,
        },
        prefer: "return=representation",
      });

      const saved = Array.isArray(rows) ? rows[0] : null;
      if (!saved) {
        sendJson(res, 500, { error: "Could not save payment." });
        return;
      }

      sendJson(res, 200, { payment: saved });
      return;
    }

    // A mistyped amount would otherwise be permanent, since the only other
    // way to correct it is doctoring the customer's opening balance.
    if (req.method === "DELETE") {
      const id = normalizeString(req.query?.id);
      if (!id) {
        sendJson(res, 400, { error: "Payment id is required." });
        return;
      }

      await callSupabaseRest(config, `${TABLE}?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
      });

      sendJson(res, 200, { ok: true });
      return;
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Payments API failed." });
  }
};
