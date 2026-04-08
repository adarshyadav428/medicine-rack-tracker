const {
  allowMethods,
  callSupabaseRest,
  getServerConfig,
  normalizeString,
  parseJsonBody,
  requireAuthContext,
  sendJson,
  toCloudRow,
} = require("../_lib/supabase-server");

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["POST"])) {
    return;
  }

  const config = getServerConfig();

  try {
    if (!(await requireAuthContext(req, res, config, { adminOnly: true }))) {
      return;
    }

    const body = await parseJsonBody(req);
    const items = Array.isArray(body?.items) ? body.items : null;

    if (!items) {
      sendJson(res, 400, { error: "Items array is required." });
      return;
    }

    await callSupabaseRest(config, `${config.tableName}?id=not.is.null`, {
      method: "DELETE",
    });

    const rows = items
      .map((item) => toCloudRow(item))
      .filter((row) => normalizeString(row.medicine_name) && normalizeString(row.location));

    if (rows.length) {
      await callSupabaseRest(config, config.tableName, {
        method: "POST",
        body: rows,
        prefer: "return=minimal",
      });
    }

    sendJson(res, 200, { ok: true, count: rows.length });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Replace API failed." });
  }
};
