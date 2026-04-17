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
} = require("../lib/supabase-server");

const READ_PAGE_SIZE = 1000;
const WRITE_BATCH_SIZE = 500;

async function fetchAllMedicineRows(config) {
  const allRows = [];
  let offset = 0;

  while (true) {
    const query = `${config.tableName}?select=*&order=updated_at.desc,id.desc&limit=${READ_PAGE_SIZE}&offset=${offset}`;
    const rows = await callSupabaseRest(
      config,
      query,
      {
        method: "GET",
      }
    );

    const batch = Array.isArray(rows) ? rows : [];
    allRows.push(...batch);

    if (batch.length < READ_PAGE_SIZE) {
      return allRows;
    }

    offset += READ_PAGE_SIZE;
  }
}

async function insertMedicineRowsInBatches(config, rows) {
  for (let start = 0; start < rows.length; start += WRITE_BATCH_SIZE) {
    const batch = rows.slice(start, start + WRITE_BATCH_SIZE);
    await callSupabaseRest(config, config.tableName, {
      method: "POST",
      body: batch,
      prefer: "return=minimal",
    });
  }
}

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

      res.setHeader("Cache-Control", "no-store");

      const rows = await fetchAllMedicineRows(config);

      const items = Array.isArray(rows)
        ? rows
            .map(fromCloudRow)
            .filter((item) => normalizeString(item.medicineName) && normalizeString(item.location))
        : [];

      sendJson(res, 200, { items, count: items.length, pageSize: READ_PAGE_SIZE });
      return;
    }

    if (req.method === "POST") {
      if (!(await requireAuthContext(req, res, config, { adminOnly: true }))) {
        return;
      }

      const body = await parseJsonBody(req);

      const items = Array.isArray(body?.items) ? body.items : null;
      if (items) {
        const mode = normalizeString(body?.mode).toLowerCase();

        if (mode !== "append") {
          await callSupabaseRest(config, `${config.tableName}?id=not.is.null`, {
            method: "DELETE",
          });
        }

        const rowsForReplace = items
          .map((item) => toCloudRow(item))
          .filter((row) => normalizeString(row.medicine_name) && normalizeString(row.location));

        if (rowsForReplace.length) {
          await insertMedicineRowsInBatches(config, rowsForReplace);
        }

        sendJson(res, 200, { ok: true, count: rowsForReplace.length, mode: mode || "replace" });
        return;
      }

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
