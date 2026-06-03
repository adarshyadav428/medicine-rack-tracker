module.exports = (req, res) => {
  const tableName = process.env.SUPABASE_TABLE_NAME || "medicines";
  const roleTable = process.env.SUPABASE_ROLE_TABLE || "user_roles";

  const projectUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    enabled: Boolean(projectUrl && anonKey && serviceRoleKey),
    backendManaged: true,
    tableName,
    roleTable,
  });
};
