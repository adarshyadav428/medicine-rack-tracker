/**
 * api/auth.js — Consolidated auth router (replaces api/auth/*.js)
 *
 * All /api/auth/* routes are rewritten here via vercel.json rewrites.
 * Routes on the last segment of req.url:
 *   POST  /api/auth/login
 *   POST  /api/auth/logout
 *   GET   /api/auth/me
 *   POST  /api/auth/recover
 *   POST  /api/auth/resend-verification
 *   POST  /api/auth/session
 *   POST  /api/auth/signup
 *   POST  /api/auth/update-password
 *   POST  /api/auth/verify
 */
const {
  allowMethods,
  callSupabaseAuth,
  clearAuthCookies,
  fetchUserByAccessToken,
  getRequestOrigin,
  getRoleInfo,
  getServerConfig,
  getSessionUser,
  normalizeEmail,
  normalizeString,
  parseJsonBody,
  sendJson,
  setAuthCookies,
} = require("../lib/supabase-server");

// ── helpers ───────────────────────────────────────────────────────────────

function getAction(req) {
  // req.url is e.g. "/api/auth/login" or "/api/auth/resend-verification"
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

async function readResponseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

// ── route handlers ────────────────────────────────────────────────────────

async function handleLogin(req, res, config) {
  if (!allowMethods(req, res, ["POST"])) return;
  const body = await parseJsonBody(req);
  const email    = normalizeEmail(body.email);
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
}

async function handleLogout(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  clearAuthCookies(res);
  sendJson(res, 200, { ok: true });
}

async function handleMe(req, res, config) {
  if (!allowMethods(req, res, ["GET"])) return;

  if (!config.enabled) {
    sendJson(res, 200, { authenticated: false, configEnabled: false });
    return;
  }

  try {
    const session = await getSessionUser(req, res, config);
    if (!session?.user?.email) {
      sendJson(res, 200, { authenticated: false, configEnabled: true });
      return;
    }

    const roleInfo = await getRoleInfo(config, session.user.email);
    if (!roleInfo.isActive || roleInfo.role === "inactive") {
      clearAuthCookies(res);
      sendJson(res, 403, { authenticated: false, error: "Account is inactive. Contact admin." });
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
}

async function handleRecover(req, res, config) {
  if (!allowMethods(req, res, ["POST"])) return;
  const body  = await parseJsonBody(req);
  const email = normalizeEmail(body.email);

  if (!email) {
    sendJson(res, 400, { error: "Email is required." });
    return;
  }

  const origin     = getRequestOrigin(req);
  const redirectTo = origin ? `${origin}/index.html?auth_action=recovery` : undefined;

  try {
    await callSupabaseAuth(config, "/auth/v1/recover", {
      method: "POST",
      body: {
        email,
        ...(redirectTo ? { redirect_to: redirectTo, email_redirect_to: redirectTo } : {}),
      },
    });
    sendJson(res, 200, { message: "Password reset link sent. Check your email." });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Could not send password reset email." });
  }
}

async function handleResendVerification(req, res, config) {
  if (!allowMethods(req, res, ["POST"])) return;
  const body  = await parseJsonBody(req);
  const email = normalizeEmail(body.email);

  if (!email) {
    sendJson(res, 400, { error: "Email is required." });
    return;
  }

  const origin     = getRequestOrigin(req);
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
    sendJson(res, 200, { message: "Verification email sent. Please check your inbox." });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Could not resend verification email." });
  }
}

async function handleSession(req, res, config) {
  if (!allowMethods(req, res, ["POST"])) return;
  const body         = await parseJsonBody(req);
  const accessToken  = normalizeString(body.accessToken);
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
}

async function handleSignup(req, res, config) {
  if (!allowMethods(req, res, ["POST"])) return;
  const body     = await parseJsonBody(req);
  const email    = normalizeEmail(body.email);
  const password = normalizeString(body.password);

  if (!email || !password) {
    sendJson(res, 400, { error: "Email and password are required." });
    return;
  }

  const origin         = getRequestOrigin(req);
  const emailRedirectTo = origin ? `${origin}/index.html?auth_action=verified` : undefined;

  try {
    const payload = await callSupabaseAuth(config, "/auth/v1/signup", {
      method: "POST",
      body: {
        email,
        password,
        ...(emailRedirectTo
          ? { options: { emailRedirectTo }, email_redirect_to: emailRedirectTo }
          : {}),
      },
    });

    if (payload?.access_token && payload?.user?.email) {
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
}

async function handleUpdatePassword(req, res, config) {
  if (!allowMethods(req, res, ["POST"])) return;
  const session = await getSessionUser(req, res, config);
  if (!session?.user?.email || !session?.accessToken) {
    sendJson(res, 401, { error: "Login required to update password." });
    return;
  }

  const body            = await parseJsonBody(req);
  const password        = normalizeString(body.password);
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

    sendJson(res, 200, { ok: true, message: "Password updated successfully." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Password update failed." });
  }
}

async function handleVerify(req, res, config) {
  if (!allowMethods(req, res, ["POST"])) return;
  const ALLOWED_TYPES = new Set(["signup", "recovery", "magiclink", "invite", "email_change"]);

  const body      = await parseJsonBody(req);
  const tokenHash = normalizeString(body.tokenHash);
  const token     = normalizeString(body.token);
  const type      = normalizeString(body.type).toLowerCase();

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
      sendJson(res, 200, { verified: true, action: type, message: "Email verification completed." });
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
}

// ── main router ───────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const config = getServerConfig();
  const action = getAction(req);

  // Routes that don't need config.enabled check
  if (action === "logout") return handleLogout(req, res);
  if (action === "me")     return handleMe(req, res, config);

  // All remaining routes require backend to be configured
  if (!config.enabled) {
    sendJson(res, 503, { error: "Server environment variables are not configured." });
    return;
  }

  switch (action) {
    case "login":                return handleLogin(req, res, config);
    case "recover":              return handleRecover(req, res, config);
    case "resend-verification":  return handleResendVerification(req, res, config);
    case "session":              return handleSession(req, res, config);
    case "signup":               return handleSignup(req, res, config);
    case "update-password":      return handleUpdatePassword(req, res, config);
    case "verify":               return handleVerify(req, res, config);
    default:
      sendJson(res, 404, { error: `Unknown auth action: ${action}` });
  }
};
