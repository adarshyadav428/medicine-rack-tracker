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

const ALLOWED_TYPES = new Set(["signup", "recovery", "magiclink", "invite", "email_change"]);

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
  const tokenHash = normalizeString(body.tokenHash);
  const token = normalizeString(body.token);
  const type = normalizeString(body.type).toLowerCase();

  if (!ALLOWED_TYPES.has(type)) {
    sendJson(res, 400, { error: "Invalid verification type." });
    return;
  }

  if (!tokenHash && !token) {
    sendJson(res, 400, { error: "Verification token is required." });
    return;
  }

  try {
    const payload = await callSupabaseAuth(config, "/auth/v1/verify", {
      method: "POST",
      body: tokenHash ? { type, token_hash: tokenHash } : { type, token },
    });

    if (payload?.access_token && payload?.refresh_token) {
      setAuthCookies(res, payload.access_token, payload.refresh_token);
    }

    if (!payload?.user?.email) {
      sendJson(res, 200, {
        verified: true,
        action: type,
        message: "Email verification completed.",
      });
      return;
    }

    const roleInfo = await getRoleInfo(config, payload.user.email);
    if (!roleInfo.isActive || roleInfo.role === "inactive") {
      clearAuthCookies(res);
      sendJson(res, 403, { error: "Account is inactive. Contact admin." });
      return;
    }

    sendJson(res, 200, {
      verified: true,
      action: type,
      user: {
        id: payload.user.id,
        email: normalizeEmail(payload.user.email),
        role: roleInfo.role,
      },
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Email verification failed." });
  }
};
