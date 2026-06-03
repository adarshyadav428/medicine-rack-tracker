const {
  allowMethods,
  clearAuthCookies,
  getRoleInfo,
  getServerConfig,
  getSessionUser,
  normalizeEmail,
  sendJson,
} = require("../../lib/supabase-server");

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["GET"])) {
    return;
  }

  const config = getServerConfig();
  if (!config.enabled) {
    sendJson(res, 200, {
      authenticated: false,
      configEnabled: false,
    });
    return;
  }

  try {
    const session = await getSessionUser(req, res, config);
    if (!session?.user?.email) {
      sendJson(res, 200, {
        authenticated: false,
        configEnabled: true,
      });
      return;
    }

    const roleInfo = await getRoleInfo(config, session.user.email);
    if (!roleInfo.isActive || roleInfo.role === "inactive") {
      clearAuthCookies(res);
      sendJson(res, 403, {
        authenticated: false,
        error: "Account is inactive. Contact admin.",
      });
      return;
    }

    sendJson(res, 200, {
      authenticated: true,
      configEnabled: true,
      user: {
        id: session.user.id,
        email: normalizeEmail(session.user.email),
        role: roleInfo.role,
      },
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Session check failed." });
  }
};
