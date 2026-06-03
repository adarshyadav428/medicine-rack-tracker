const {
  allowMethods,
  callSupabaseRest,
  getServerConfig,
  normalizeEmail,
  normalizeString,
  parseJsonBody,
  requireAuthContext,
  sendJson,
} = require("../lib/supabase-server");

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
    const email = normalizeEmail(body.email);
    const role = normalizeString(body.role).toLowerCase();
    const status = normalizeString(body.status).toLowerCase();

    if (!email || (role !== "admin" && role !== "employee") || (status !== "active" && status !== "inactive")) {
      sendJson(res, 400, { error: "Provide valid email, role, and status." });
      return;
    }

    await callSupabaseRest(config, `${config.roleTable}?on_conflict=email`, {
      method: "POST",
      body: {
        email,
        role,
        is_active: status === "active",
      },
      prefer: "resolution=merge-duplicates,return=minimal",
    });

    sendJson(res, 200, {
      ok: true,
      message: `Saved ${email} as ${role} (${status}).`,
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Access API failed." });
  }
};
