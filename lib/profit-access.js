"use strict";

// The primary account is established by supabase-rbac-setup.sql. Other admins
// do not inherit confidential profit access or permission to manage its PIN.
const DEFAULT_OWNER = "adarshyadavazm123@gmail.com";

function canAccessProfit(user) {
  const owner = String(process.env.PROFIT_OWNER_EMAIL || DEFAULT_OWNER).trim().toLowerCase();
  return !!user && user.role === "admin" && String(user.email || "").trim().toLowerCase() === owner;
}

function requireProfitOwner(auth, res) {
  if (canAccessProfit(auth && auth.user)) return true;
  res.statusCode = 403;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({
    error: "Only the business owner can access profit.",
    code: "PROFIT_OWNER_REQUIRED",
  }));
  return false;
}

module.exports = { canAccessProfit, requireProfitOwner };
