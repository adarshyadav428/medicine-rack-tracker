const DEFAULT_TABLE_NAME = "medicines";
const DEFAULT_ROLE_TABLE = "user_roles";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function sanitizeTableName(value) {
  const cleaned = normalizeString(value);
  if (!cleaned) {
    return "";
  }

  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned) ? cleaned : "";
}

function getServerConfig() {
  const projectUrl = normalizeString(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ""
  );
  const anonKey = normalizeString(
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
  );
  const serviceRoleKey = normalizeString(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

  const tableName = sanitizeTableName(process.env.SUPABASE_TABLE_NAME) || DEFAULT_TABLE_NAME;
  const roleTable = sanitizeTableName(process.env.SUPABASE_ROLE_TABLE) || DEFAULT_ROLE_TABLE;

  const adminEmails = normalizeString(process.env.SUPABASE_ADMIN_EMAILS || "")
    .split(",")
    .map((entry) => normalizeEmail(entry))
    .filter(Boolean);

  return {
    enabled: Boolean(projectUrl && anonKey && serviceRoleKey),
    projectUrl,
    anonKey,
    serviceRoleKey,
    tableName,
    roleTable,
    adminEmails,
  };
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) {
    return true;
  }

  res.setHeader("Allow", methods.join(", "));
  sendJson(res, 405, { error: `Method ${req.method} not allowed.` });
  return false;
}

function parseCookies(req) {
  const raw = req.headers?.cookie || "";
  if (!raw) {
    return {};
  }

  return raw.split(";").reduce((acc, chunk) => {
    const [keyPart, ...valueParts] = chunk.split("=");
    const key = normalizeString(keyPart);
    if (!key) {
      return acc;
    }

    const value = valueParts.join("=");
    acc[key] = decodeURIComponent(value || "");
    return acc;
  }, {});
}

function getCookie(req, name) {
  const cookies = parseCookies(req);
  return cookies[name] || "";
}

function appendSetCookies(res, cookies) {
  const existing = res.getHeader("Set-Cookie");
  const existingArray = existing ? (Array.isArray(existing) ? existing : [String(existing)]) : [];
  res.setHeader("Set-Cookie", [...existingArray, ...cookies]);
}

function cookieSecuritySuffix() {
  return process.env.NODE_ENV === "development" ? "" : "; Secure";
}

function createCookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${cookieSecuritySuffix()}`;
}

function setAuthCookies(res, accessToken, refreshToken) {
  const cookies = [];

  if (accessToken) {
    cookies.push(createCookie("sb-access-token", accessToken, 60 * 60 * 24 * 7));
  }

  if (refreshToken) {
    cookies.push(createCookie("sb-refresh-token", refreshToken, 60 * 60 * 24 * 30));
  }

  if (cookies.length) {
    appendSetCookies(res, cookies);
  }
}

function clearAuthCookies(res) {
  appendSetCookies(res, [
    createCookie("sb-access-token", "", 0),
    createCookie("sb-refresh-token", "", 0),
  ]);
}

async function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

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

function extractErrorMessage(payload, fallback) {
  return (
    normalizeString(payload?.error_description) ||
    normalizeString(payload?.msg) ||
    normalizeString(payload?.message) ||
    normalizeString(payload?.error) ||
    fallback
  );
}

async function callSupabaseAuth(config, path, options = {}) {
  const key = config.anonKey || config.serviceRoleKey;
  if (!config.projectUrl || !key) {
    throw new Error("Supabase auth environment variables are missing.");
  }

  const method = options.method || "GET";
  const hasBody = options.body !== undefined;

  const response = await fetch(`${config.projectUrl}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  const payload = await readResponseJson(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Auth request failed (${response.status}).`));
  }

  return payload;
}

async function callSupabaseRest(config, path, options = {}) {
  if (!config.projectUrl || !config.serviceRoleKey) {
    throw new Error("Supabase service role environment variables are missing.");
  }

  const method = options.method || "GET";
  const hasBody = options.body !== undefined;

  const response = await fetch(`${config.projectUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(options.prefer ? { Prefer: options.prefer } : {}),
      ...(options.headers || {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  const payload = await readResponseJson(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Database request failed (${response.status}).`));
  }

  return payload;
}

async function fetchUserByAccessToken(config, accessToken) {
  const key = config.anonKey || config.serviceRoleKey;
  if (!accessToken || !key) {
    return null;
  }

  const response = await fetch(`${config.projectUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 401 || response.status === 403) {
    return null;
  }

  const payload = await readResponseJson(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Session lookup failed (${response.status}).`));
  }

  return payload;
}

async function refreshSession(config, refreshToken) {
  if (!refreshToken) {
    return null;
  }

  try {
    const payload = await callSupabaseAuth(config, "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: {
        refresh_token: refreshToken,
      },
    });

    if (!payload?.access_token) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

async function getSessionUser(req, res, config) {
  let accessToken = getCookie(req, "sb-access-token");
  let refreshToken = getCookie(req, "sb-refresh-token");

  let user = await fetchUserByAccessToken(config, accessToken);
  if (user) {
    return { user, accessToken, refreshToken };
  }

  const refreshed = await refreshSession(config, refreshToken);
  if (!refreshed?.access_token) {
    return null;
  }

  accessToken = refreshed.access_token;
  refreshToken = refreshed.refresh_token || refreshToken;
  setAuthCookies(res, accessToken, refreshToken);

  user = refreshed.user || (await fetchUserByAccessToken(config, accessToken));
  if (!user) {
    return null;
  }

  return { user, accessToken, refreshToken };
}

async function getRoleInfo(config, email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return { role: "employee", isActive: true };
  }

  if (config.adminEmails.includes(normalizedEmail)) {
    return { role: "admin", isActive: true };
  }

  const path = `${config.roleTable}?select=role,is_active&email=eq.${encodeURIComponent(
    normalizedEmail
  )}&limit=1`;

  const rows = await callSupabaseRest(config, path, { method: "GET" });
  const row = Array.isArray(rows) ? rows[0] : null;

  if (row && row.is_active === false) {
    return { role: "inactive", isActive: false };
  }

  if (row && normalizeString(row.role)) {
    return {
      role: normalizeString(row.role).toLowerCase(),
      isActive: row.is_active !== false,
    };
  }

  return { role: "employee", isActive: true };
}

async function requireAuthContext(req, res, config, options = {}) {
  if (!config.enabled) {
    sendJson(res, 503, { error: "Server environment variables are not configured." });
    return null;
  }

  const session = await getSessionUser(req, res, config);
  if (!session?.user?.email) {
    sendJson(res, 401, { error: "Login required." });
    return null;
  }

  const roleInfo = await getRoleInfo(config, session.user.email);
  if (!roleInfo.isActive || roleInfo.role === "inactive") {
    clearAuthCookies(res);
    sendJson(res, 403, { error: "Account is inactive. Contact admin." });
    return null;
  }

  if (options.adminOnly && roleInfo.role !== "admin") {
    sendJson(res, 403, { error: "Admin access required." });
    return null;
  }

  return {
    user: {
      id: normalizeString(session.user.id),
      email: normalizeEmail(session.user.email),
      role: roleInfo.role,
    },
  };
}

function toCloudRow(item) {
  return {
    id: normalizeString(item.id),
    medicine_name: normalizeString(item.medicineName),
    location: normalizeString(item.location),
    quantity:
      item.quantity === null || item.quantity === undefined || item.quantity === ""
        ? null
        : Number.parseInt(String(item.quantity), 10),
    expiry_date: normalizeString(item.expiryDate) || null,
    created_at: normalizeString(item.createdAt) || new Date().toISOString(),
    updated_at: normalizeString(item.updatedAt) || new Date().toISOString(),
  };
}

function fromCloudRow(row) {
  return {
    id: row.id,
    medicineName: row.medicine_name,
    location: row.location,
    quantity: row.quantity,
    expiryDate: row.expiry_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  allowMethods,
  callSupabaseAuth,
  callSupabaseRest,
  clearAuthCookies,
  fromCloudRow,
  getRoleInfo,
  getServerConfig,
  getSessionUser,
  normalizeEmail,
  normalizeString,
  parseJsonBody,
  requireAuthContext,
  sendJson,
  setAuthCookies,
  toCloudRow,
};
