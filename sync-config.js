window.APP_SYNC_CONFIG = {
  enabled: false,
  projectUrl: "",
  anonKey: "",
  tableName: "medicines",
  roleTable: "user_roles",
  adminEmails: [],
};

window.APP_SYNC_CONFIG_PROMISE = fetch("/api/supabase-config", {
  cache: "no-store",
})
  .then((response) => {
    if (!response.ok) {
      throw new Error(`Config request failed with status ${response.status}`);
    }
    return response.json();
  })
  .then((runtimeConfig) => {
    window.APP_SYNC_CONFIG = {
      ...window.APP_SYNC_CONFIG,
      ...runtimeConfig,
    };
    return window.APP_SYNC_CONFIG;
  })
  .catch((error) => {
    console.warn("Using fallback config. Runtime env config unavailable:", error.message);
    return window.APP_SYNC_CONFIG;
  });
