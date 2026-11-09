/**
 * Profit PIN: status, unlock, and change.
 *
 *   GET                          -> { isSet, unlocked, lockedOutMinutes }
 *   POST { pin }                 -> unlock (sets the unlock cookie)
 *   POST { pin, confirm }        -> first-time setup, when no PIN exists yet
 *   PUT  { currentPin, newPin }  -> change an existing PIN
 *   DELETE                       -> lock this session again
 *
 * Every route requires the configured owner account with an active admin role.
 * The PIN is a second gate for that owner.
 */
const {
  allowMethods,
  appendSetCookies,
  createCookie,
  getCookie,
  getServerConfig,
  parseJsonBody,
  requireAuthContext,
  sendJson,
} = require("../lib/supabase-server");

const {
  UNLOCK_COOKIE,
  UNLOCK_TTL_SECONDS,
  clearFailures,
  getStoredPinHash,
  isUnlockTokenValid,
  issueUnlockToken,
  lockoutMinutesRemaining,
  recordFailure,
  setPin,
  validatePinFormat,
  verifyPin,
} = require("../lib/profit-pin");
const {requireProfitOwner} = require("../lib/profit-access");

function setUnlockCookie(res, token) {
  appendSetCookies(res, [createCookie(UNLOCK_COOKIE, token, UNLOCK_TTL_SECONDS)]);
}

function clearUnlockCookie(res) {
  appendSetCookies(res, [createCookie(UNLOCK_COOKIE, "", 0)]);
}

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["GET", "POST", "PUT", "DELETE"])) return;

  const config = getServerConfig();

  try {
    const authContext = await requireAuthContext(req, res, config, { adminOnly: true });
    if (!authContext) return;
    if (!requireProfitOwner(authContext,res)) return;
    res.setHeader("Cache-Control","no-store");

    const email = authContext.user.email;
    const storedHash = await getStoredPinHash(config);

    // -- status ------------------------------------------------------------
    if (req.method === "GET") {
      const unlocked = Boolean(
        storedHash && isUnlockTokenValid(config, getCookie(req, UNLOCK_COOKIE), email)
      );
      sendJson(res, 200, {
        isSet: Boolean(storedHash),
        unlocked,
        lockedOutMinutes: await lockoutMinutesRemaining(config),
      });
      return;
    }

    // -- lock again --------------------------------------------------------
    if (req.method === "DELETE") {
      clearUnlockCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }

    const body = await parseJsonBody(req);

    // -- change an existing PIN -------------------------------------------
    if (req.method === "PUT") {
      if (!storedHash) {
        sendJson(res, 400, { error: "No PIN is set yet." });
        return;
      }

      const locked = await lockoutMinutesRemaining(config);
      if (locked) {
        sendJson(res, 429, {
          error: `Too many wrong attempts. Try again in ${locked} minute(s).`,
        });
        return;
      }

      if (!verifyPin(String(body.currentPin || "").trim(), storedHash)) {
        const fail = await recordFailure(config);
        sendJson(res, 401, {
          error: fail.lockedUntil
            ? "Too many wrong attempts. Locked for 15 minutes."
            : `Current PIN is incorrect. ${fail.remaining} attempt(s) left.`,
        });
        return;
      }

      const check = validatePinFormat(body.newPin);
      if (!check.ok) {
        sendJson(res, 400, { error: check.error });
        return;
      }

      await setPin(config, check.value);
      setUnlockCookie(res, issueUnlockToken(config, email));
      sendJson(res, 200, { ok: true, isSet: true, unlocked: true });
      return;
    }

    // -- POST: first-time setup, or unlock ---------------------------------
    const check = validatePinFormat(body.pin);
    if (!check.ok) {
      sendJson(res, 400, { error: check.error });
      return;
    }

    if (!storedHash) {
      // Setup. Confirmation is checked here as well as in the browser so a
      // typo cannot be locked in by a direct API call.
      if (String(body.confirm == null ? body.pin : body.confirm).trim() !== check.value) {
        sendJson(res, 400, { error: "PINs do not match." });
        return;
      }
      await setPin(config, check.value);
      setUnlockCookie(res, issueUnlockToken(config, email));
      sendJson(res, 200, { ok: true, isSet: true, unlocked: true });
      return;
    }

    const locked = await lockoutMinutesRemaining(config);
    if (locked) {
      sendJson(res, 429, {
        error: `Too many wrong attempts. Try again in ${locked} minute(s).`,
      });
      return;
    }

    if (!verifyPin(check.value, storedHash)) {
      const fail = await recordFailure(config);
      sendJson(res, 401, {
        error: fail.lockedUntil
          ? "Too many wrong attempts. Locked for 15 minutes."
          : `Incorrect PIN. ${fail.remaining} attempt(s) left.`,
      });
      return;
    }

    await clearFailures(config);
    setUnlockCookie(res, issueUnlockToken(config, email));
    sendJson(res, 200, { ok: true, isSet: true, unlocked: true });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Profit PIN request failed." });
  }
};
