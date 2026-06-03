const {
  allowMethods,
  getServerConfig,
  getSessionUser,
  normalizeString,
  parseJsonBody,
  sendJson,
} = require("../../lib/supabase-server");

async function readResponseJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["POST"])) {
    return;
  }

  const config = getServerConfig();
  if (!config.enabled) {
    sendJson(res, 503, { error: "Server environment variables are not configured." });
    return;
  }

  const session = await getSessionUser(req, res, config);
  if (!session?.user?.email || !session?.accessToken) {
    sendJson(res, 401, { error: "Login required to update password." });
    return;
  }

  const body = await parseJsonBody(req);
  const password = normalizeString(body.password);
  const confirmPassword = normalizeString(body.confirmPassword);

  if (!password || password.length < 8) {
    sendJson(res, 400, { error: "Password must be at least 8 characters." });
    return;
  }

  if (confirmPassword && password !== confirmPassword) {
    sendJson(res, 400, { error: "Password and confirm password do not match." });
    return;
  }

  try {
    const response = await fetch(`${config.projectUrl}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        apikey: config.anonKey || config.serviceRoleKey,
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({ password }),
    });

    const payload = await readResponseJson(response);
    if (!response.ok) {
      const message =
        normalizeString(payload.error_description) ||
        normalizeString(payload.msg) ||
        normalizeString(payload.message) ||
        normalizeString(payload.error) ||
        `Could not update password (${response.status}).`;
      sendJson(res, response.status, { error: message });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      message: "Password updated successfully.",
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Password update failed." });
  }
};
