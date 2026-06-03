const {
  allowMethods,
  callSupabaseAuth,
  getRequestOrigin,
  getServerConfig,
  normalizeEmail,
  parseJsonBody,
  sendJson,
} = require("../../lib/supabase-server");

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

  if (!email) {
    sendJson(res, 400, { error: "Email is required." });
    return;
  }

  const origin = getRequestOrigin(req);
  const redirectTo = origin ? `${origin}/index.html?auth_action=recovery` : undefined;

  try {
    await callSupabaseAuth(config, "/auth/v1/recover", {
      method: "POST",
      body: {
        email,
        ...(redirectTo ? { redirect_to: redirectTo, email_redirect_to: redirectTo } : {}),
      },
    });

    sendJson(res, 200, {
      message: "Password reset link sent. Check your email.",
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Could not send password reset email." });
  }
};
