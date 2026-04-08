const {
  allowMethods,
  clearAuthCookies,
  sendJson,
} = require("../../lib/supabase-server");

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["POST"])) {
    return;
  }

  clearAuthCookies(res);
  sendJson(res, 200, { ok: true });
};
