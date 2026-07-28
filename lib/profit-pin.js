/**
 * Profit PIN storage, verification and unlock tokens.
 *
 * The PIN hash lives in the `app_settings` table and is only ever compared on
 * the server. A successful unlock issues a short-lived signed token that rides
 * in an httpOnly cookie, which /api/profit requires before it will return any
 * figures — so knowing the page URL, or clearing browser storage, gets you
 * nothing.
 */
const crypto = require("crypto");
const { callSupabaseRest } = require("./supabase-server");

const SETTINGS_TABLE = "app_settings";
const PIN_KEY = "profit_pin";
const FAIL_KEY = "profit_pin_fails";

const PBKDF2_ITERATIONS = 210000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = "sha256";

const UNLOCK_COOKIE = "am-profit-unlock";
const UNLOCK_TTL_SECONDS = 60 * 60 * 8; // a working day, then re-enter it

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const MIN_PIN_LENGTH = 4;
const MAX_PIN_LENGTH = 12;

// ---------------------------------------------------------------------------
// Settings rows
// ---------------------------------------------------------------------------

async function readSetting(config, key) {
  const rows = await callSupabaseRest(
    config,
    `${SETTINGS_TABLE}?key=eq.${encodeURIComponent(key)}&select=value&limit=1`
  );
  return Array.isArray(rows) && rows.length ? rows[0].value || "" : "";
}

async function writeSetting(config, key, value) {
  await callSupabaseRest(config, `${SETTINGS_TABLE}?on_conflict=key`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: [{ key, value: String(value), updated_at: new Date().toISOString() }],
  });
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(pin, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST)
    .toString("hex");
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

function verifyPin(pin, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;

  const expected = Buffer.from(parts[3], "hex");
  if (!expected.length) return false;

  const actual = crypto.pbkdf2Sync(
    pin,
    parts[2],
    iterations,
    expected.length,
    PBKDF2_DIGEST
  );
  // Lengths match by construction, so this only guards content.
  return crypto.timingSafeEqual(actual, expected);
}

function validatePinFormat(pin) {
  const value = String(pin == null ? "" : pin).trim();
  if (value.length < MIN_PIN_LENGTH) {
    return { ok: false, error: `PIN must be at least ${MIN_PIN_LENGTH} characters.` };
  }
  if (value.length > MAX_PIN_LENGTH) {
    return { ok: false, error: `PIN must be at most ${MAX_PIN_LENGTH} characters.` };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Unlock tokens — "<expiry>.<hmac>", signed with the service-role key
// ---------------------------------------------------------------------------

function signingSecret(config) {
  // Never leaves the server, and rotating the key invalidates outstanding
  // unlocks, which is the behaviour we want anyway.
  return config.serviceRoleKey || "";
}

function issueUnlockToken(config, email) {
  const expiresAt = Date.now() + UNLOCK_TTL_SECONDS * 1000;
  const payload = `${expiresAt}.${email || ""}`;
  const mac = crypto
    .createHmac("sha256", signingSecret(config))
    .update(payload)
    .digest("hex");
  return `${expiresAt}.${mac}`;
}

function isUnlockTokenValid(config, token, email) {
  const raw = String(token || "");
  const dot = raw.indexOf(".");
  if (dot < 1) return false;

  const expiresAt = parseInt(raw.slice(0, dot), 10);
  const mac = raw.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  const expected = crypto
    .createHmac("sha256", signingSecret(config))
    .update(`${expiresAt}.${email || ""}`)
    .digest("hex");

  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Lockout — a shared PIN is short, so guessing has to be made expensive
// ---------------------------------------------------------------------------

async function readFailState(config) {
  try {
    const raw = await readSetting(config, FAIL_KEY);
    if (!raw) return { count: 0, lockedUntil: 0 };
    const parsed = JSON.parse(raw);
    return {
      count: parseInt(parsed.count, 10) || 0,
      lockedUntil: parseInt(parsed.lockedUntil, 10) || 0,
    };
  } catch (_) {
    return { count: 0, lockedUntil: 0 };
  }
}

async function recordFailure(config) {
  const state = await readFailState(config);
  const count = state.count + 1;
  const lockedUntil = count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0;
  await writeSetting(config, FAIL_KEY, JSON.stringify({ count, lockedUntil }));
  return { count, lockedUntil, remaining: Math.max(0, MAX_FAILURES - count) };
}

async function clearFailures(config) {
  await writeSetting(config, FAIL_KEY, JSON.stringify({ count: 0, lockedUntil: 0 }));
}

/** Minutes left on an active lockout, or 0 when not locked out. */
async function lockoutMinutesRemaining(config) {
  const state = await readFailState(config);
  if (!state.lockedUntil || state.lockedUntil <= Date.now()) return 0;
  return Math.ceil((state.lockedUntil - Date.now()) / 60000);
}

// ---------------------------------------------------------------------------

async function getStoredPinHash(config) {
  return readSetting(config, PIN_KEY);
}

async function setPin(config, pin) {
  await writeSetting(config, PIN_KEY, hashPin(pin));
  await clearFailures(config);
}

module.exports = {
  FAIL_KEY,
  MAX_FAILURES,
  MIN_PIN_LENGTH,
  PIN_KEY,
  SETTINGS_TABLE,
  UNLOCK_COOKIE,
  UNLOCK_TTL_SECONDS,
  clearFailures,
  getStoredPinHash,
  hashPin,
  isUnlockTokenValid,
  issueUnlockToken,
  lockoutMinutesRemaining,
  readFailState,
  recordFailure,
  setPin,
  validatePinFormat,
  verifyPin,
};
