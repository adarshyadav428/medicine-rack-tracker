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
  const redirectTo = origin ? `${origin}/index.html?auth_action=verified` : undefined;

  try {
    await callSupabaseAuth(config, "/auth/v1/resend", {
      method: "POST",
      body: {
        type: "signup",
        email,
        ...(redirectTo ? { email_redirect_to: redirectTo } : {}),
      },
    });

    sendJson(res, 200, {
      message: "Verification email sent. Please check your inbox.",
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Could not resend verification email." });
  }
};
