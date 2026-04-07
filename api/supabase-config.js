module.exports = (req, res) => {
  const projectUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const tableName = process.env.SUPABASE_TABLE_NAME || "medicines";
  const roleTable = process.env.SUPABASE_ROLE_TABLE || "user_roles";
  const adminEmailsRaw = process.env.SUPABASE_ADMIN_EMAILS || "";

  const adminEmails = adminEmailsRaw
    .split(",")
    .map((email) => String(email || "").trim().toLowerCase())
    .filter(Boolean);

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    enabled: Boolean(projectUrl && anonKey),
    projectUrl,
    anonKey,
    tableName,
    roleTable,
    adminEmails,
  });
};
