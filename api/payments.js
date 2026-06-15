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

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["GET", "POST"])) return;

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

      const rows = await callSupabaseRest(
        config,
        `${TABLE}?customer_name=eq.${encodeURIComponent(customer)}&order=created_at.desc&limit=500`,
        { method: "GET" }
      );

      sendJson(res, 200, { payments: Array.isArray(rows) ? rows : [] });
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
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Payments API failed." });
  }
};
