const {
  allowMethods,
  callSupabaseAuth,
  getRequestOrigin,
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

  const origin = getRequestOrigin(req);
  const emailRedirectTo = origin ? `${origin}/index.html?auth_action=verified` : undefined;

  try {
    const payload = await callSupabaseAuth(config, "/auth/v1/signup", {
      method: "POST",
      body: {
        email,
        password,
        ...(emailRedirectTo
          ? {
              options: {
                emailRedirectTo,
              },
              email_redirect_to: emailRedirectTo,
            }
          : {}),
      },
    });

    const hasSession = Boolean(payload?.access_token && payload?.user?.email);

    if (hasSession) {
      const roleInfo = await getRoleInfo(config, payload.user.email);
      setAuthCookies(res, payload.access_token, payload.refresh_token);

      sendJson(res, 200, {
        user: {
          id: payload.user.id,
          email: normalizeEmail(payload.user.email),
          role: roleInfo.role,
        },
      });
      return;
    }

    sendJson(res, 200, {
      requiresEmailVerification: true,
      message: "Account created. Verify email if confirmation is enabled.",
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Could not create account." });
  }
};
