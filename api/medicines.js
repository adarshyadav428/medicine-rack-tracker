const {
  allowMethods,
  callSupabaseRest,
  fromCloudRow,
  getServerConfig,
  normalizeString,
  parseJsonBody,
  requireAuthContext,
  sendJson,
  toCloudRow,
} = require("./_lib/supabase-server");

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["GET", "POST", "DELETE"])) {
    return;
  }

  const config = getServerConfig();

  try {
    if (req.method === "GET") {
      if (!(await requireAuthContext(req, res, config))) {
        return;
      }

      const rows = await callSupabaseRest(
        config,
        `${config.tableName}?select=*&order=updated_at.desc`,
        { method: "GET" }
      );

      const items = Array.isArray(rows)
        ? rows
            .map(fromCloudRow)
            .filter((item) => normalizeString(item.medicineName) && normalizeString(item.location))
        : [];

      sendJson(res, 200, { items });
      return;
    }

    if (req.method === "POST") {
      if (!(await requireAuthContext(req, res, config, { adminOnly: true }))) {
        return;
      }

      const body = await parseJsonBody(req);
      const rawItem = body?.item;
      if (!rawItem || typeof rawItem !== "object") {
        sendJson(res, 400, { error: "Medicine item is required." });
        return;
      }

      const row = toCloudRow(rawItem);
      if (!normalizeString(row.medicine_name) || !normalizeString(row.location)) {
        sendJson(res, 400, { error: "Medicine name and location are required." });
        return;
      }

      const rows = await callSupabaseRest(config, `${config.tableName}?on_conflict=id`, {
        method: "POST",
        body: row,
        prefer: "resolution=merge-duplicates,return=representation",
      });

      const savedRow = Array.isArray(rows) ? rows[0] : null;
      if (!savedRow) {
        sendJson(res, 500, { error: "Could not save medicine." });
        return;
      }

      sendJson(res, 200, { item: fromCloudRow(savedRow) });
      return;
    }

    if (req.method === "DELETE") {
      if (!(await requireAuthContext(req, res, config, { adminOnly: true }))) {
        return;
      }

      const id = normalizeString(req.query?.id);
      if (!id) {
        sendJson(res, 400, { error: "Medicine id is required." });
        return;
      }

      await callSupabaseRest(config, `${config.tableName}?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
      });

      sendJson(res, 200, { ok: true });
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Medicine API failed." });
  }
};
