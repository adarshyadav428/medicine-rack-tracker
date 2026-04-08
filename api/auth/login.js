const {
  allowMethods,
  callSupabaseAuth,
  clearAuthCookies,
  getRoleInfo,
  getServerConfig,
  normalizeEmail,
  normalizeString,
  parseJsonBody,
  sendJson,
  setAuthCookies,
} = require("../_lib/supabase-server");

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["POST"])) {
    return;
  }

  const config = getServerConfig();
  if (!config.enabled) {
    sendJson(res, 503, { error: "Server environment variables are not configured." });
    return;
  }

  const body = await parseJsonBody(req);
  const email = normalizeEmail(body.email);
  const password = normalizeString(body.password);

  if (!email || !password) {
    sendJson(res, 400, { error: "Email and password are required." });
    return;
  }

  try {
    const session = await callSupabaseAuth(config, "/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email, password },
    });

    if (!session?.access_token || !session?.user?.email) {
      sendJson(res, 401, { error: "Login failed." });
      return;
    }

    const roleInfo = await getRoleInfo(config, session.user.email);
    if (!roleInfo.isActive || roleInfo.role === "inactive") {
      clearAuthCookies(res);
      sendJson(res, 403, { error: "Account is inactive. Contact admin." });
      return;
    }

    setAuthCookies(res, session.access_token, session.refresh_token);
    sendJson(res, 200, {
      user: {
        id: session.user.id,
        email: normalizeEmail(session.user.email),
        role: roleInfo.role,
      },
    });
  } catch (error) {
    sendJson(res, 401, { error: error.message || "Invalid login credentials." });
  }
};
