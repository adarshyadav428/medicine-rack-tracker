const {
  allowMethods,
  clearAuthCookies,
  fetchUserByAccessToken,
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
  const accessToken = normalizeString(body.accessToken);
  const refreshToken = normalizeString(body.refreshToken);

  if (!accessToken) {
    sendJson(res, 400, { error: "Access token is required." });
    return;
  }

  try {
    const user = await fetchUserByAccessToken(config, accessToken);
    if (!user?.email) {
      clearAuthCookies(res);
      sendJson(res, 401, { error: "Invalid or expired session token." });
      return;
    }

    const roleInfo = await getRoleInfo(config, user.email);
    if (!roleInfo.isActive || roleInfo.role === "inactive") {
      clearAuthCookies(res);
      sendJson(res, 403, { error: "Account is inactive. Contact admin." });
      return;
    }

    setAuthCookies(res, accessToken, refreshToken);

    sendJson(res, 200, {
      authenticated: true,
      user: {
        id: user.id,
        email: normalizeEmail(user.email),
        role: roleInfo.role,
      },
    });
  } catch (error) {
    clearAuthCookies(res);
    sendJson(res, 400, { error: error.message || "Could not establish session." });
  }
};
