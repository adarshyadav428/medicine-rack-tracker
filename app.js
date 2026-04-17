const STORAGE_KEY = "medicineRackTracker.v1";
const SYNC_CONFIG_KEY = "medicineRackTracker.sync.v1";
const LOW_STOCK_THRESHOLD = 10;
const IMPORT_BATCH_SIZE = 500;
const SUSPICIOUS_REFRESH_CAP = 1000;
const LARGE_SHRINK_MIN_DROP = 250;

const currentPage = document.body.dataset.page || "home";
const allowedPages = new Set(["index.html", "dashboard.html", "access.html"]);

const state = {
  items: [],
  searchTerm: "",
  sortBy: "recent",
  statusFilter: "all",
  editingId: null,
  sync: {
    enabled: false,
    tableName: "medicines",
    roleTable: "user_roles",
    adminEmails: [],
    realtimeChannel: null,
  },
  auth: {
    user: null,
    role: "guest",
    pendingRedirectAfterLogin: false,
    passwordRecoveryMode: false,
    pendingNotice: "",
  },
};

const elements = {
  headerUser: document.getElementById("header-user"),
  headerLogout: document.getElementById("header-logout"),

  authEmail: document.getElementById("auth-email"),
  authPassword: document.getElementById("auth-password"),
  authLoginButton: document.getElementById("auth-login-button"),
  authSignupButton: document.getElementById("auth-signup-button"),
  authForgotButton: document.getElementById("auth-forgot-button"),
  authResendVerifyButton: document.getElementById("auth-resend-verify-button"),
  authLogoutButton: document.getElementById("auth-logout-button"),
  authStatus: document.getElementById("auth-status"),
  currentUser: document.getElementById("current-user"),
  resetPanel: document.getElementById("reset-panel"),
  resetPassword: document.getElementById("reset-password"),
  resetPasswordConfirm: document.getElementById("reset-password-confirm"),
  resetPasswordButton: document.getElementById("reset-password-button"),
  resetCancelButton: document.getElementById("reset-cancel-button"),

  dashboardStatus: document.getElementById("dashboard-status"),
  metricTotal: document.getElementById("metric-total"),
  metricLowStock: document.getElementById("metric-low-stock"),
  metricExpiring: document.getElementById("metric-expiring"),
  metricExpired: document.getElementById("metric-expired"),

  formPanel: document.getElementById("medicine-form-panel"),
  form: document.getElementById("medicine-form"),
  medicineName: document.getElementById("medicine-name"),
  location: document.getElementById("medicine-location"),
  quantity: document.getElementById("medicine-quantity"),
  expiryDate: document.getElementById("medicine-expiry"),
  saveButton: document.getElementById("save-button"),
  cancelEditButton: document.getElementById("cancel-edit-button"),
  formError: document.getElementById("form-error"),

  searchInput: document.getElementById("search-input"),
  statusFilterSelect: document.getElementById("status-filter-select"),
  sortSelect: document.getElementById("sort-select"),
  clearFiltersButton: document.getElementById("clear-filters-button"),
  exportButton: document.getElementById("export-button"),
  importButton: document.getElementById("import-button"),
  clearAllButton: document.getElementById("clear-all-button"),
  importInput: document.getElementById("import-input"),
  summary: document.getElementById("summary"),
  listContainer: document.getElementById("list-container"),
  rowTemplate: document.getElementById("medicine-row-template"),

  adminAccessPanel: document.getElementById("admin-access-panel"),
  accessEmail: document.getElementById("access-email"),
  accessRole: document.getElementById("access-role"),
  accessStatusSelect: document.getElementById("access-status"),
  accessSaveButton: document.getElementById("access-save-button"),
  accessFeedback: document.getElementById("access-feedback"),

  syncPanel: document.getElementById("sync-panel"),
  syncEnabled: document.getElementById("sync-enabled"),
  syncUrl: document.getElementById("sync-url"),
  syncAnonKey: document.getElementById("sync-anon-key"),
  syncTable: document.getElementById("sync-table"),
  syncSaveButton: document.getElementById("sync-save-button"),
  syncDisableButton: document.getElementById("sync-disable-button"),
  syncStatus: document.getElementById("sync-status"),
};

function safeListen(element, eventName, handler) {
  if (element) {
    element.addEventListener(eventName, handler);
  }
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizePositiveInteger(value) {
  const cleaned = normalizeString(value);
  if (!cleaned) {
    return null;
  }

  const parsed = Number.parseInt(cleaned, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function normalizeDateOnly(value) {
  const cleaned = normalizeString(value);
  if (!cleaned) {
    return "";
  }

  const date = new Date(cleaned);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const rand = Math.floor(Math.random() * 16);
    const val = ch === "x" ? rand : (rand & 0x3) | 0x8;
    return val.toString(16);
  });
}

function normalizeItem(item) {
  return {
    id: normalizeString(item.id) || createId(),
    medicineName: normalizeString(item.medicineName),
    location: normalizeString(item.location),
    quantity: normalizePositiveInteger(item.quantity),
    expiryDate: normalizeDateOnly(item.expiryDate),
    createdAt: normalizeString(item.createdAt) || new Date().toISOString(),
    updatedAt: normalizeString(item.updatedAt) || new Date().toISOString(),
  };
}

function formatTimestamp(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "Unknown time";
  }
}

function setStatus(element, message, tone = "") {
  if (!element) {
    return;
  }

  element.textContent = message || "";
  element.classList.remove("is-ok", "is-warn", "is-error", "is-info");
  if (tone) {
    element.classList.add(tone);
  }
}

function setAuthStatus(message, tone = "") {
  setStatus(elements.authStatus, message, tone);
}

function setSyncStatus(message, tone = "") {
  setStatus(elements.syncStatus, message, tone);
}

function setAccessStatus(message, tone = "") {
  setStatus(elements.accessFeedback, message, tone);
}

function setDashboardStatus(message, tone = "") {
  setStatus(elements.dashboardStatus, message, tone);
}

function resolvePageTarget(rawTarget) {
  const target = normalizeString(rawTarget);
  if (!target) {
    return null;
  }

  const pathOnly = target.split("?")[0];
  if (!allowedPages.has(pathOnly)) {
    return null;
  }

  return target;
}

function getCurrentFileName() {
  const pathname = window.location.pathname || "/index.html";
  const fileName = pathname.split("/").pop();
  return fileName || "index.html";
}

function getNextDestination() {
  const params = new URLSearchParams(window.location.search);
  const target = resolvePageTarget(params.get("next"));
  return target || "dashboard.html";
}

function setPasswordRecoveryMode(enabled) {
  state.auth.passwordRecoveryMode = Boolean(enabled);

  if (!enabled) {
    if (elements.resetPassword) {
      elements.resetPassword.value = "";
    }

    if (elements.resetPasswordConfirm) {
      elements.resetPasswordConfirm.value = "";
    }
  }

  if (elements.resetPanel) {
    elements.resetPanel.classList.toggle("hidden", !state.auth.passwordRecoveryMode);
  }
}

function clearAuthArtifactsFromUrl() {
  const url = new URL(window.location.href);
  const keysToRemove = [
    "auth_action",
    "token_hash",
    "token",
    "type",
    "error",
    "error_code",
    "error_description",
    "access_token",
    "refresh_token",
    "expires_in",
    "expires_at",
    "provider_token",
    "provider_refresh_token",
  ];

  keysToRemove.forEach((key) => {
    url.searchParams.delete(key);
  });

  const search = url.searchParams.toString();
  const nextUrl = `${url.pathname}${search ? `?${search}` : ""}`;
  window.history.replaceState({}, document.title, nextUrl);
}

async function processAuthCallbackFromUrl() {
  if (currentPage !== "home" && currentPage !== "access") {
    return;
  }

  const query = new URLSearchParams(window.location.search);
  const tokenHash = normalizeString(query.get("token_hash"));
  const token = normalizeString(query.get("token"));
  const queryType = normalizeString(query.get("type")).toLowerCase();
  const authAction = normalizeString(query.get("auth_action")).toLowerCase();
  const authError = normalizeString(query.get("error_description") || query.get("error"));

  const hash = (window.location.hash || "").replace(/^#/, "");
  const hashParams = new URLSearchParams(hash);
  const accessToken = normalizeString(hashParams.get("access_token"));
  const refreshToken = normalizeString(hashParams.get("refresh_token"));
  const hashType = normalizeString(hashParams.get("type")).toLowerCase();

  let shouldCleanUrl = false;

  if (authError) {
    state.auth.pendingNotice = `Auth link error: ${authError}`;
    shouldCleanUrl = true;
  }

  if ((tokenHash || token) && queryType) {
    try {
      const payload = await requestApi("/api/auth/verify", {
        method: "POST",
        body: {
          tokenHash,
          token,
          type: queryType,
        },
      });

      if (payload.user) {
        state.auth.user = payload.user;
        state.auth.role = normalizeString(payload.user.role).toLowerCase() || "employee";
      }

      if (queryType === "recovery") {
        setPasswordRecoveryMode(true);
        state.auth.pendingNotice = "Reset link verified. Set your new password below.";
      } else {
        state.auth.pendingNotice = "Email verified successfully. You can login now.";
      }

      shouldCleanUrl = true;
    } catch (error) {
      state.auth.pendingNotice = `Verification failed: ${error.message || "Unknown error"}`;
      shouldCleanUrl = true;
    }
  }

  if (accessToken) {
    try {
      const payload = await requestApi("/api/auth/session", {
        method: "POST",
        body: {
          accessToken,
          refreshToken,
        },
      });

      if (payload.user) {
        state.auth.user = payload.user;
        state.auth.role = normalizeString(payload.user.role).toLowerCase() || "employee";
      }

      if (hashType === "recovery") {
        setPasswordRecoveryMode(true);
        state.auth.pendingNotice = "Reset link verified. Set your new password below.";
      } else if (!state.auth.pendingNotice) {
        state.auth.pendingNotice = "Email verification completed.";
      }

      shouldCleanUrl = true;
    } catch (error) {
      state.auth.pendingNotice = `Session setup failed: ${error.message || "Unknown error"}`;
      shouldCleanUrl = true;
    }
  }

  if (authAction === "recovery") {
    setPasswordRecoveryMode(true);
    if (!state.auth.pendingNotice) {
      state.auth.pendingNotice = "Use the form below to set a new password.";
    }
    shouldCleanUrl = true;
  }

  if (authAction === "verified") {
    if (!state.auth.pendingNotice) {
      state.auth.pendingNotice = "Email verified successfully. You can login now.";
    }
    shouldCleanUrl = true;
  }

  if (shouldCleanUrl) {
    clearAuthArtifactsFromUrl();
  }
}

function applyPendingAuthNotice() {
  if (!state.auth.pendingNotice) {
    return;
  }

  const tone = state.auth.pendingNotice.toLowerCase().includes("failed")
    ? "is-error"
    : state.auth.pendingNotice.toLowerCase().includes("error")
      ? "is-error"
      : "is-info";

  setAuthStatus(state.auth.pendingNotice, tone);
  state.auth.pendingNotice = "";
}

function goTo(targetPath) {
  const target = resolvePageTarget(targetPath);
  if (!target) {
    return;
  }

  const currentFile = getCurrentFileName();
  const targetFile = target.split("?")[0];
  if (currentFile === targetFile && !target.includes("?")) {
    return;
  }

  document.body.classList.add("is-leaving");
  window.setTimeout(() => {
    window.location.href = target;
  }, 220);
}

function setupPageTransitions() {
  requestAnimationFrame(() => {
    document.body.classList.add("is-ready");
  });

  document.querySelectorAll("a[data-nav]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const href = link.getAttribute("href");
      const target = resolvePageTarget(href);
      if (!target) {
        return;
      }

      event.preventDefault();
      goTo(target);
    });
  });
}

function isCloudSyncActive() {
  return Boolean(state.sync.enabled);
}

function isAuthenticated() {
  return Boolean(state.auth.user);
}

function isAdmin() {
  return state.auth.role === "admin";
}

function canViewRecords() {
  return Boolean(isCloudSyncActive() && isAuthenticated());
}

function canWriteRecords() {
  return Boolean(canViewRecords() && isAdmin());
}

function canManageAccess() {
  return Boolean(isCloudSyncActive() && isAuthenticated() && isAdmin());
}

function loadLocalItems() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map(normalizeItem).filter((item) => item.medicineName && item.location);
  } catch {
    return [];
  }
}

function saveLocalItems(items = state.items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

async function loadRuntimeConfig() {
  if (!window.APP_SYNC_CONFIG_PROMISE) {
    return;
  }

  try {
    const runtimeConfig = await window.APP_SYNC_CONFIG_PROMISE;
    if (runtimeConfig && typeof runtimeConfig === "object") {
      window.APP_SYNC_CONFIG = {
        ...(window.APP_SYNC_CONFIG || {}),
        ...runtimeConfig,
      };
    }
  } catch (error) {
    console.error("Runtime sync config load failed", error);
  }
}

function getDefaultSyncConfig() {
  const defaults = window.APP_SYNC_CONFIG || {};
  return {
    enabled: Boolean(defaults.enabled),
    tableName: normalizeString(defaults.tableName) || "medicines",
    roleTable: normalizeString(defaults.roleTable) || "user_roles",
    adminEmails: Array.isArray(defaults.adminEmails)
      ? defaults.adminEmails.map((entry) => normalizeString(entry).toLowerCase()).filter(Boolean)
      : [],
  };
}

function loadSyncConfig() {
  const fallback = getDefaultSyncConfig();
  return {
    ...fallback,
    enabled: Boolean(fallback.enabled),
  };
}

function saveSyncConfig() {
  localStorage.setItem(
    SYNC_CONFIG_KEY,
    JSON.stringify({
      enabled: state.sync.enabled,
      tableName: state.sync.tableName,
      roleTable: state.sync.roleTable,
      adminEmails: state.sync.adminEmails,
    })
  );
}

function hydrateSyncInputs() {
  const envManaged = true;

  if (elements.syncEnabled) {
    elements.syncEnabled.checked = state.sync.enabled;
    elements.syncEnabled.disabled = envManaged;
  }
  if (elements.syncUrl) {
    elements.syncUrl.value = "";
    elements.syncUrl.placeholder = "Configured securely on backend";
    elements.syncUrl.readOnly = true;
  }
  if (elements.syncAnonKey) {
    elements.syncAnonKey.value = "";
    elements.syncAnonKey.placeholder = "Stored securely on backend";
    elements.syncAnonKey.readOnly = true;
  }
  if (elements.syncTable) {
    elements.syncTable.value = state.sync.tableName || "medicines";
    elements.syncTable.readOnly = true;
  }
  if (elements.syncSaveButton) {
    elements.syncSaveButton.disabled = envManaged;
  }
  if (elements.syncDisableButton) {
    elements.syncDisableButton.disabled = envManaged;
  }

  setSyncStatus(
    state.sync.enabled
      ? "Supabase is connected through backend API routes."
      : "Backend sync is not configured yet.",
    state.sync.enabled ? "is-info" : "is-warn"
  );
}

function toCloudRow(item) {
  return {
    id: item.id,
    medicine_name: item.medicineName,
    location: item.location,
    quantity: item.quantity,
    expiry_date: item.expiryDate || null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
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

async function requestApi(path, options = {}) {
  const method = options.method || "GET";
  const hasBody = options.body !== undefined;
  const cache = options.cache || (method === "GET" ? "no-store" : undefined);

  const response = await fetch(path, {
    method,
    cache,
    credentials: "include",
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }
  }

  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }

  return payload;
}

function stopRealtimeSync() {
  if (!state.sync.realtimeChannel) {
    return;
  }

  window.clearInterval(state.sync.realtimeChannel);
  state.sync.realtimeChannel = null;
}

function startRealtimeSync() {
  if (!isCloudSyncActive() || !isAuthenticated()) {
    return;
  }

  if (state.sync.realtimeChannel) {
    return;
  }

  state.sync.realtimeChannel = window.setInterval(() => {
    refreshItemsFromCloud();
  }, 15000);
}

async function fetchCloudItems() {
  const payload = await requestApi(`/api/medicines?ts=${Date.now()}`, { method: "GET" });
  const data = Array.isArray(payload.items) ? payload.items : [];

  if (typeof payload.count === "number" && payload.count !== data.length) {
    setSyncStatus(
      `Refresh mismatch: API reported ${payload.count} rows but returned ${data.length}.`,
      "is-warn"
    );
  }

  return data
    .map(normalizeItem)
    .filter((item) => item.medicineName && item.location);
}

async function upsertCloudItem(item) {
  const payload = await requestApi("/api/medicines", {
    method: "POST",
    body: {
      item,
    },
  });

  return normalizeItem(payload.item || item);
}

async function deleteCloudItem(itemId) {
  await requestApi(`/api/medicines?id=${encodeURIComponent(itemId)}`, {
    method: "DELETE",
  });
}

async function replaceAllCloudItems(newItems) {
  if (!newItems.length) {
    await requestApi("/api/medicines", {
      method: "POST",
      body: {
        items: [],
        mode: "replace",
      },
    });
    return;
  }

  for (let start = 0; start < newItems.length; start += IMPORT_BATCH_SIZE) {
    const chunk = newItems.slice(start, start + IMPORT_BATCH_SIZE);
    const importedCount = Math.min(start + chunk.length, newItems.length);

    setDashboardStatus(`Importing ${importedCount} of ${newItems.length} medicines...`, "is-info");

    await requestApi("/api/medicines", {
      method: "POST",
      body: {
        items: chunk,
        mode: start === 0 ? "replace" : "append",
      },
    });
  }
}

async function getRoleForCurrentUser() {
  if (!isAuthenticated()) {
    return "guest";
  }

  const directRole = normalizeString(state.auth.user.role).toLowerCase();
  if (directRole) {
    return directRole;
  }

  const payload = await requestApi("/api/auth/me", { method: "GET" });
  if (!payload.authenticated || !payload.user) {
    return "guest";
  }

  state.auth.user = payload.user;

  return normalizeString(payload.user.role).toLowerCase() || "employee";
}

async function refreshItemsFromCloud() {
  if (!isCloudSyncActive() || !isAuthenticated()) {
    state.items = [];
    renderPage();
    return;
  }

  try {
    const cloudItems = await fetchCloudItems();
    const localCount = state.items.length;
    const droppedBy = localCount - cloudItems.length;
    const hugeShrink =
      localCount > SUSPICIOUS_REFRESH_CAP &&
      cloudItems.length > 0 &&
      cloudItems.length < localCount &&
      droppedBy >= LARGE_SHRINK_MIN_DROP;

    if (cloudItems.length === SUSPICIOUS_REFRESH_CAP && localCount > cloudItems.length) {
      setDashboardStatus(
        `Cloud refresh returned only ${cloudItems.length} of ${localCount} cached medicines. Keeping the full imported list.`,
        "is-warn"
      );
      setSyncStatus(
        `Cloud refresh looks capped at ${cloudItems.length} rows. Redeploy the API changes if this persists.`,
        "is-warn"
      );
      return;
    }

    if (hugeShrink) {
      setDashboardStatus(
        `Cloud refresh dropped from ${localCount} to ${cloudItems.length}. Keeping the larger cached list to prevent data loss.`,
        "is-warn"
      );
      setSyncStatus(
        "Large refresh shrink detected. This usually means API paging/caching still needs attention.",
        "is-warn"
      );
      return;
    }

    state.items = cloudItems;
    saveLocalItems(state.items);
    renderPage();
  } catch (error) {
    setSyncStatus(`Could not load cloud data: ${error.message || "Unknown error"}`, "is-error");
  }
}

function renderHeaderSession() {
  if (elements.headerUser) {
    if (isAuthenticated()) {
      elements.headerUser.textContent = `${state.auth.user.email} (${state.auth.role})`;
    } else {
      elements.headerUser.textContent = "Not signed in";
    }
  }

  if (elements.headerLogout) {
    elements.headerLogout.classList.toggle("hidden", !isAuthenticated());
  }

  if (elements.currentUser) {
    if (isAuthenticated()) {
      elements.currentUser.textContent = `Signed in as ${state.auth.user.email} (${state.auth.role})`;
    } else {
      elements.currentUser.textContent = "";
    }
  }
}

function enforcePageGuard() {
  if (currentPage === "dashboard" && !canViewRecords()) {
    goTo("index.html?next=dashboard.html");
    return false;
  }

  if (currentPage === "access") {
    if (!isCloudSyncActive() || !isAuthenticated()) {
      goTo("index.html?next=access.html");
      return false;
    }

    if (!isAdmin()) {
      goTo("dashboard.html");
      return false;
    }
  }

  return true;
}

async function handleAuthSession(session, source = "session") {
  state.auth.user = session?.user
    ? {
        ...session.user,
        email: normalizeString(session.user.email),
        role: normalizeString(session.user.role).toLowerCase(),
      }
    : null;

  if (state.auth.user && !state.auth.user.email) {
    state.auth.user = null;
  }

  if (!state.auth.user) {
    state.auth.role = "guest";
    stopRealtimeSync();
    state.items = [];
    renderHeaderSession();

    if (isCloudSyncActive()) {
      setAuthStatus("Login required to access medicine data.", "is-warn");
    } else {
      setAuthStatus("Cloud sync unavailable. Configure environment variables first.", "is-error");
    }

    if (!enforcePageGuard()) {
      return;
    }

    renderPage();
    return;
  }

  try {
    state.auth.role = await getRoleForCurrentUser();

    if (state.auth.role === "inactive") {
      setAuthStatus("Account is inactive. Contact admin.", "is-error");
      try {
        await requestApi("/api/auth/logout", { method: "POST" });
      } catch {
        // Ignore logout cleanup errors for inactive users.
      }
      return;
    }

    renderHeaderSession();
    setAuthStatus("Login successful.", "is-ok");

    if (currentPage === "home") {
      const shouldRedirect = source === "signed-in" || source === "startup" || state.auth.pendingRedirectAfterLogin;
      if (shouldRedirect) {
        state.auth.pendingRedirectAfterLogin = false;
        goTo(getNextDestination());
        return;
      }
    }

    if (isCloudSyncActive()) {
      await refreshItemsFromCloud();
      startRealtimeSync();
    }

    if (!enforcePageGuard()) {
      return;
    }

    renderPage();
  } catch (error) {
    state.auth.role = "employee";
    renderHeaderSession();
    setAuthStatus(`Role lookup warning: ${error.message || "Unknown error"}`, "is-warn");
    if (!enforcePageGuard()) {
      return;
    }
    renderPage();
  }
}

function ensureAuthListener() {
  return;
}

function disableCloudSync() {
  state.sync.enabled = false;

  stopRealtimeSync();

  state.auth.user = null;
  state.auth.role = "guest";
  state.items = [];

  saveSyncConfig();
  hydrateSyncInputs();
  renderHeaderSession();
  setSyncStatus("Cloud sync disabled. Sign in is required to view data.", "is-warn");
  setAuthStatus("Sign in unavailable while cloud sync is disabled.", "is-warn");

  if (!enforcePageGuard()) {
    return;
  }

  renderPage();
}

function parseSyncInputs() {
  const defaults = getDefaultSyncConfig();
  return {
    enabled: Boolean(defaults.enabled),
    tableName: defaults.tableName || "medicines",
  };
}

async function enableCloudSyncFromInputs() {
  await loadRuntimeConfig();
  await restoreSyncOnStartup();
}

async function restoreSyncOnStartup() {
  const persisted = loadSyncConfig();
  const defaults = getDefaultSyncConfig();
  state.sync = {
    ...state.sync,
    ...persisted,
    ...defaults,
    enabled: Boolean(defaults.enabled),
  };

  hydrateSyncInputs();

  if (!state.sync.enabled) {
    state.items = [];
    setSyncStatus("Cloud sync unavailable. Configure environment variables and redeploy.", "is-error");
    setAuthStatus("Please sign in to access medicine data.", "is-warn");
    renderHeaderSession();

    if (!enforcePageGuard()) {
      return;
    }

    renderPage();
    return;
  }

  state.items = loadLocalItems();

  try {
    ensureAuthListener();

    const session = await requestApi("/api/auth/me", { method: "GET" });
    setSyncStatus("Cloud sync connected through backend.", "is-ok");

    if (session.authenticated && session.user) {
      await handleAuthSession({ user: session.user }, "startup");
      return;
    }

    await handleAuthSession(null, "startup");
  } catch (error) {
    state.sync.enabled = false;
    saveSyncConfig();
    state.items = [];
    setSyncStatus(
      `Cloud sync startup failed (${error.message || "Unknown"}). Login required once connection is fixed.`,
      "is-error"
    );
    setAuthStatus("Please sign in to access medicine data.", "is-warn");

    await handleAuthSession(null, "session");
  }
}

function getExpiryStatus(expiryDate) {
  const normalized = normalizeDateOnly(expiryDate);
  if (!normalized) {
    return { kind: "none", label: "No expiry date set" };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const target = new Date(`${normalized}T00:00:00`);
  const diffMs = target.getTime() - today.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (days < 0) {
    return {
      kind: "expired",
      label: `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`,
    };
  }

  if (days <= 30) {
    return {
      kind: "expiring",
      label: `Expiring in ${days} day${days === 1 ? "" : "s"}`,
    };
  }

  return {
    kind: "safe",
    label: `Expiry: ${normalized}`,
  };
}

function getFilteredAndSortedItems() {
  const search = normalizeString(state.searchTerm).toLowerCase();
  const statusFilter = normalizeString(state.statusFilter) || "all";

  const filtered = state.items.filter((item) => {
    if (!search) {
      return matchesStatusFilter(item, statusFilter);
    }

    const searchMatch = (
      item.medicineName.toLowerCase().includes(search) ||
      item.location.toLowerCase().includes(search)
    );

    if (!searchMatch) {
      return false;
    }

    return matchesStatusFilter(item, statusFilter);
  });

  const sorted = [...filtered];
  switch (state.sortBy) {
    case "name-asc":
      sorted.sort((a, b) => a.medicineName.localeCompare(b.medicineName));
      break;
    case "name-desc":
      sorted.sort((a, b) => b.medicineName.localeCompare(a.medicineName));
      break;
    case "location-asc":
      sorted.sort((a, b) => a.location.localeCompare(b.location));
      break;
    case "location-desc":
      sorted.sort((a, b) => b.location.localeCompare(a.location));
      break;
    case "recent":
    default:
      sorted.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      break;
  }

  return sorted;
}

function isLowStock(item) {
  return typeof item.quantity === "number" && item.quantity <= LOW_STOCK_THRESHOLD;
}

function matchesStatusFilter(item, filter) {
  const expiryKind = getExpiryStatus(item.expiryDate).kind;

  switch (filter) {
    case "low-stock":
      return isLowStock(item);
    case "expiring":
      return expiryKind === "expiring";
    case "expired":
      return expiryKind === "expired";
    case "no-expiry":
      return expiryKind === "none";
    case "all":
    default:
      return true;
  }
}

function renderSummary(visibleCount) {
  if (!elements.summary) {
    return;
  }

  const totalCount = state.items.length;
  if (!totalCount) {
    elements.summary.textContent = "No medicines saved yet.";
    return;
  }

  if (visibleCount === totalCount && state.statusFilter === "all") {
    elements.summary.textContent = `${totalCount} medicine${totalCount > 1 ? "s" : ""} stored.`;
    return;
  }

  const filterName = normalizeString(state.statusFilter) || "all";
  const suffix = filterName === "all" ? "" : ` (${filterName.replace("-", " ")})`;
  elements.summary.textContent = `Showing ${visibleCount} of ${totalCount} medicine${totalCount > 1 ? "s" : ""}${suffix}.`;
}

function renderMetrics(items) {
  if (elements.metricTotal) {
    elements.metricTotal.textContent = String(items.length);
  }

  const lowStock = items.filter((item) => isLowStock(item)).length;
  const expiring = items.filter((item) => getExpiryStatus(item.expiryDate).kind === "expiring").length;
  const expired = items.filter((item) => getExpiryStatus(item.expiryDate).kind === "expired").length;

  if (elements.metricExpiring) {
    elements.metricExpiring.textContent = String(expiring);
  }

  if (elements.metricExpired) {
    elements.metricExpired.textContent = String(expired);
  }

  if (elements.metricLowStock) {
    elements.metricLowStock.textContent = String(lowStock);
  }
}

function renderMedicineList(itemsToRender) {
  if (!elements.listContainer) {
    return;
  }

  elements.listContainer.textContent = "";

  if (!itemsToRender.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = state.items.length
      ? "No medicines match your search."
      : "Start by adding your first medicine and rack location.";
    elements.listContainer.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  itemsToRender.forEach((item) => {
    if (!elements.rowTemplate) {
      return;
    }

    const row = elements.rowTemplate.content.cloneNode(true);
    const card = row.querySelector(".medicine-card");
    const expiry = getExpiryStatus(item.expiryDate);
    const quantityText = item.quantity === null ? "Qty: not set" : `Qty: ${item.quantity}`;
    const lowStockLabel = isLowStock(item) ? " | Low stock" : "";

    row.querySelector(".medicine-name").textContent = item.medicineName;
    row.querySelector(".medicine-location").textContent = item.location;
    row.querySelector(".medicine-extra").textContent = `${quantityText} | ${expiry.label}${lowStockLabel}`;
    row.querySelector(".medicine-meta").textContent = `Updated: ${formatTimestamp(item.updatedAt)}`;

    card.classList.remove("is-expiring", "is-expired", "is-safe", "is-low-stock");
    if (expiry.kind === "expired") {
      card.classList.add("is-expired");
    } else if (expiry.kind === "expiring") {
      card.classList.add("is-expiring");
    } else if (expiry.kind === "safe") {
      card.classList.add("is-safe");
    }

    if (isLowStock(item)) {
      card.classList.add("is-low-stock");
    }

    const editButton = row.querySelector(".action-edit");
    if (!canWriteRecords()) {
      editButton.disabled = true;
      editButton.title = "Only admin can edit records.";
    } else {
      editButton.addEventListener("click", () => beginEdit(item.id));
    }

    const deleteButton = row.querySelector(".action-delete");
    if (!canWriteRecords()) {
      deleteButton.disabled = true;
      deleteButton.title = "Only admin can delete records.";
    } else {
      deleteButton.addEventListener("click", () => {
        handleDeleteItem(item.id);
      });
    }

    const copyLocationButton = row.querySelector(".action-copy-location");
    copyLocationButton?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.location);
        setDashboardStatus(`Copied location for ${item.medicineName}.`, "is-ok");
      } catch {
        setDashboardStatus(`Could not copy location for ${item.medicineName}.`, "is-warn");
      }
    });

    fragment.appendChild(row);
  });

  elements.listContainer.appendChild(fragment);
}

function beginEdit(itemId) {
  if (!elements.form) {
    return;
  }

  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  state.editingId = item.id;
  if (elements.medicineName) elements.medicineName.value = item.medicineName;
  if (elements.location) elements.location.value = item.location;
  if (elements.quantity) elements.quantity.value = item.quantity ?? "";
  if (elements.expiryDate) elements.expiryDate.value = item.expiryDate || "";

  if (elements.cancelEditButton) {
    elements.cancelEditButton.classList.remove("hidden");
  }

  if (elements.saveButton) {
    elements.saveButton.textContent = "Update Medicine";
  }

  setStatus(elements.formError, "", "");
  elements.medicineName?.focus();
}

function resetFormState() {
  if (elements.form) {
    elements.form.reset();
  }

  state.editingId = null;

  if (elements.cancelEditButton) {
    elements.cancelEditButton.classList.add("hidden");
  }

  if (elements.saveButton) {
    elements.saveButton.textContent = "Save Medicine";
  }

  setStatus(elements.formError, "", "");
}

function renderDashboardPage() {
  if (currentPage !== "dashboard") {
    return;
  }

  if (!canViewRecords()) {
    renderMetrics([]);
    renderSummary(0);
    renderMedicineList([]);

    if (elements.formPanel) {
      elements.formPanel.classList.add("hidden");
    }

    if (elements.exportButton) {
      elements.exportButton.disabled = true;
    }
    if (elements.importButton) {
      elements.importButton.disabled = true;
    }

    if (elements.clearAllButton) {
      elements.clearAllButton.disabled = true;
    }

    setDashboardStatus(
      !isCloudSyncActive()
        ? "Cloud connection unavailable. Contact admin."
        : "Please login to view medicine data.",
      "is-warn"
    );
    return;
  }

  const itemsToRender = getFilteredAndSortedItems();
  renderMetrics(state.items);
  renderSummary(itemsToRender.length);
  renderMedicineList(itemsToRender);

  if (elements.exportButton) {
    elements.exportButton.disabled = false;
  }

  if (elements.formPanel) {
    elements.formPanel.classList.toggle("hidden", !canWriteRecords());
  }

  if (elements.importButton) {
    elements.importButton.disabled = !canWriteRecords();
  }

  if (elements.clearAllButton) {
    elements.clearAllButton.disabled = !canWriteRecords();
  }

  setDashboardStatus(
    canWriteRecords() ? "Admin mode: full inventory controls active." : "Employee mode: view and search only.",
    canWriteRecords() ? "is-ok" : "is-info"
  );
}

function renderAccessPage() {
  if (currentPage !== "access") {
    return;
  }

  const adminView = canManageAccess();

  if (elements.adminAccessPanel) {
    elements.adminAccessPanel.classList.toggle("hidden", !adminView);
  }

  if (elements.syncPanel) {
    elements.syncPanel.classList.toggle("hidden", !adminView);
  }

  if (!adminView) {
    if (!isCloudSyncActive()) {
      setAccessStatus("Cloud connection unavailable. Access controls are locked.", "is-warn");
    } else if (!isAuthenticated()) {
      setAccessStatus("Login required.", "is-warn");
    } else {
      setAccessStatus("Only admin can manage user access.", "is-warn");
    }
  }
}

function renderAuthPage() {
  if (currentPage !== "home" && currentPage !== "access") {
    return;
  }

  if (elements.resetPanel) {
    elements.resetPanel.classList.toggle("hidden", !state.auth.passwordRecoveryMode);
  }
}

function renderPage() {
  renderHeaderSession();
  renderAuthPage();
  renderDashboardPage();
  renderAccessPage();
}

async function handleDeleteItem(itemId) {
  const target = state.items.find((item) => item.id === itemId);
  if (!target) {
    return;
  }

  if (!canWriteRecords()) {
    window.alert("Only admin can delete records.");
    return;
  }

  const confirmed = window.confirm(`Delete \"${target.medicineName}\" from inventory?`);
  if (!confirmed) {
    return;
  }

  try {
    if (isCloudSyncActive()) {
      await deleteCloudItem(itemId);
    }

    state.items = state.items.filter((item) => item.id !== itemId);
    saveLocalItems(state.items);

    if (state.editingId === itemId) {
      resetFormState();
    }

    renderPage();
  } catch (error) {
    window.alert(`Delete failed: ${error.message || "Unknown error"}`);
  }
}

async function handleFormSubmit(event) {
  event.preventDefault();

  if (!canWriteRecords()) {
    setStatus(elements.formError, "Only admin can change records.", "is-warn");
    return;
  }

  const medicineName = normalizeString(elements.medicineName?.value);
  const location = normalizeString(elements.location?.value);
  const rawQuantity = normalizeString(elements.quantity?.value);
  const parsedQuantity = normalizePositiveInteger(rawQuantity);
  const expiryDate = normalizeDateOnly(elements.expiryDate?.value);

  if (!medicineName || !location) {
    setStatus(elements.formError, "Medicine name and rack/place are required.", "is-error");
    return;
  }

  if (rawQuantity && parsedQuantity === null) {
    setStatus(elements.formError, "Quantity must be a non-negative whole number.", "is-error");
    return;
  }

  const now = new Date().toISOString();

  try {
    if (state.editingId) {
      const existing = state.items.find((item) => item.id === state.editingId);
      if (!existing) {
        setStatus(elements.formError, "Selected medicine no longer exists.", "is-error");
        return;
      }

      const updated = normalizeItem({
        ...existing,
        medicineName,
        location,
        quantity: parsedQuantity,
        expiryDate,
        updatedAt: now,
      });

      const finalItem = isCloudSyncActive() ? await upsertCloudItem(updated) : updated;
      state.items = state.items.map((item) => (item.id === finalItem.id ? finalItem : item));
    } else {
      const newItem = normalizeItem({
        id: createId(),
        medicineName,
        location,
        quantity: parsedQuantity,
        expiryDate,
        createdAt: now,
        updatedAt: now,
      });

      const finalItem = isCloudSyncActive() ? await upsertCloudItem(newItem) : newItem;
      state.items.unshift(finalItem);
    }

    saveLocalItems(state.items);
    resetFormState();
    renderPage();
  } catch (error) {
    setStatus(elements.formError, `Save failed: ${error.message || "Unknown error"}`, "is-error");
  }
}

function handleExport() {
  if (!canViewRecords()) {
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    schema: 4,
    items: state.items,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "adarsh-medicals-inventory-export.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function replaceAllItems(newItems) {
  if (isCloudSyncActive()) {
    if (!isAuthenticated()) {
      throw new Error("Login required for cloud import/clear.");
    }

    if (!canWriteRecords()) {
      throw new Error("Only admin can import or clear records.");
    }

    await replaceAllCloudItems(newItems);
  }

  state.items = [...newItems];
  saveLocalItems(state.items);
  resetFormState();
  renderPage();
}

function normalizeKey(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pickValueByKnownKeys(record, candidates) {
  if (!record || typeof record !== "object") {
    return "";
  }

  const normalizedCandidates = candidates.map(normalizeKey);

  for (const [key, value] of Object.entries(record)) {
    if (normalizedCandidates.includes(normalizeKey(key))) {
      return normalizeString(value);
    }
  }

  return "";
}

function arrayRowsToObjects(rows) {
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) {
    return [];
  }

  const headers = rows[0].map((cell) => normalizeString(cell));
  if (!headers.some(Boolean)) {
    return [];
  }

  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((name, idx) => {
      if (name) {
        obj[name] = row[idx];
      }
    });
    return obj;
  });
}

function extractImportRows(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const candidates = [parsed.items, parsed.data, parsed.rows, parsed.values, parsed.records];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function convertImportRowsToItems(rows) {
  const medicineKeys = ["medicineName", "medicine", "name", "medicine_name", "drug", "tablet", "item"];
  const locationKeys = ["location", "rack", "place", "rackPlace", "rack_place", "storage", "position", "shelf"];
  const quantityKeys = ["quantity", "qty", "count", "stock", "units", "balance"];
  const expiryKeys = ["expiryDate", "expiry", "expire", "expdate", "expiry_date", "expireson", "bestbefore"];

  let rowsAsObjects = rows;
  if (rows.length && Array.isArray(rows[0])) {
    rowsAsObjects = arrayRowsToObjects(rows);
  }

  return rowsAsObjects
    .map((row) => {
      if (!row || typeof row !== "object") {
        return null;
      }

      if (row.medicineName && row.location) {
        return normalizeItem(row);
      }

      const medicineName = pickValueByKnownKeys(row, medicineKeys);
      const location = pickValueByKnownKeys(row, locationKeys);
      const quantity = pickValueByKnownKeys(row, quantityKeys);
      const expiryDate = pickValueByKnownKeys(row, expiryKeys);

      if (!medicineName || !location) {
        return null;
      }

      return normalizeItem({
        medicineName,
        location,
        quantity,
        expiryDate,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    })
    .filter(Boolean);
}

function handleImportFile(file) {
  if (!file) {
    return;
  }

  if (elements.importButton) {
    elements.importButton.disabled = true;
  }

  const reader = new FileReader();

  reader.onload = async () => {
    try {
      const parsed = JSON.parse(String(reader.result || ""));
      const rows = extractImportRows(parsed);
      if (!rows.length) {
        throw new Error("Invalid JSON format for import.");
      }

      const normalized = convertImportRowsToItems(rows);
      if (!normalized.length) {
        throw new Error("No valid medicine rows found in file.");
      }

      setDashboardStatus(`Preparing to import ${normalized.length} medicines...`, "is-info");
      await replaceAllItems(normalized);
      setDashboardStatus(`Imported ${normalized.length} medicine record${normalized.length === 1 ? "" : "s"}.`, "is-ok");
      window.alert(`Imported ${normalized.length} medicine record${normalized.length === 1 ? "" : "s"}.`);
    } catch (error) {
      window.alert(error.message || "Import failed.");
    } finally {
      if (elements.importButton) {
        elements.importButton.disabled = !canWriteRecords();
      }

      if (elements.importInput) {
        elements.importInput.value = "";
      }
    }
  };

  reader.readAsText(file);
}

async function handleClearAll() {
  if (!state.items.length) {
    return;
  }

  if (!canWriteRecords()) {
    window.alert("Only admin can clear records.");
    return;
  }

  const confirmed = window.confirm("Clear all medicines? This cannot be undone unless you exported backup.");
  if (!confirmed) {
    return;
  }

  try {
    await replaceAllItems([]);
  } catch (error) {
    window.alert(`Could not clear records: ${error.message || "Unknown error"}`);
  }
}

async function requestPasswordRecovery() {
  if (!isCloudSyncActive()) {
    setAuthStatus("Backend sync is not configured.", "is-warn");
    return;
  }

  const email = normalizeString(elements.authEmail?.value);
  if (!email) {
    setAuthStatus("Enter your email first to receive a reset link.", "is-error");
    return;
  }

  try {
    const payload = await requestApi("/api/auth/recover", {
      method: "POST",
      body: { email },
    });

    setAuthStatus(payload.message || "Password reset link sent. Check your email.", "is-info");
  } catch (error) {
    setAuthStatus(`Reset request failed: ${error.message || "Unknown error"}`, "is-error");
  }
}

async function resendVerificationEmail() {
  if (!isCloudSyncActive()) {
    setAuthStatus("Backend sync is not configured.", "is-warn");
    return;
  }

  const email = normalizeString(elements.authEmail?.value);
  if (!email) {
    setAuthStatus("Enter your email first to resend verification.", "is-error");
    return;
  }

  try {
    const payload = await requestApi("/api/auth/resend-verification", {
      method: "POST",
      body: { email },
    });

    setAuthStatus(payload.message || "Verification email sent.", "is-info");
  } catch (error) {
    setAuthStatus(`Resend failed: ${error.message || "Unknown error"}`, "is-error");
  }
}

async function updatePasswordFromRecovery() {
  if (!isCloudSyncActive()) {
    setAuthStatus("Backend sync is not configured.", "is-warn");
    return;
  }

  const password = normalizeString(elements.resetPassword?.value);
  const confirmPassword = normalizeString(elements.resetPasswordConfirm?.value);

  if (!password || password.length < 8) {
    setAuthStatus("New password must be at least 8 characters.", "is-error");
    return;
  }

  if (password !== confirmPassword) {
    setAuthStatus("Password and confirm password do not match.", "is-error");
    return;
  }

  try {
    const payload = await requestApi("/api/auth/update-password", {
      method: "POST",
      body: {
        password,
        confirmPassword,
      },
    });

    setPasswordRecoveryMode(false);
    setAuthStatus(payload.message || "Password updated successfully.", "is-ok");
  } catch (error) {
    setAuthStatus(`Password update failed: ${error.message || "Unknown error"}`, "is-error");
  }
}

function cancelPasswordRecoveryMode() {
  setPasswordRecoveryMode(false);
  setAuthStatus("Password reset canceled.", "is-info");
}

async function loginUser() {
  if (!isCloudSyncActive()) {
    setAuthStatus("Backend sync is not configured.", "is-warn");
    return;
  }

  const email = normalizeString(elements.authEmail?.value);
  const password = normalizeString(elements.authPassword?.value);

  if (!email || !password) {
    setAuthStatus("Enter email and password.", "is-error");
    return;
  }

  state.auth.pendingRedirectAfterLogin = true;

  try {
    const payload = await requestApi("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });

    setPasswordRecoveryMode(false);
    await handleAuthSession({ user: payload.user }, "signed-in");
    setAuthStatus("Login successful.", "is-ok");
  } catch (error) {
    state.auth.pendingRedirectAfterLogin = false;
    setAuthStatus(`Login failed: ${error.message || "Unknown error"}`, "is-error");
  }
}

async function signupUser() {
  if (!isCloudSyncActive()) {
    setAuthStatus("Backend sync is not configured.", "is-warn");
    return;
  }

  const email = normalizeString(elements.authEmail?.value);
  const password = normalizeString(elements.authPassword?.value);

  if (!email || !password) {
    setAuthStatus("Enter email and password.", "is-error");
    return;
  }

  try {
    const payload = await requestApi("/api/auth/signup", {
      method: "POST",
      body: { email, password },
    });

    if (payload.user) {
      setPasswordRecoveryMode(false);
      await handleAuthSession({ user: payload.user }, "signed-in");
      setAuthStatus("Account created and logged in.", "is-ok");
      return;
    }

    if (payload.requiresEmailVerification) {
      setAuthStatus(
        payload.message || "Account created. Check email to verify, then login.",
        "is-info"
      );
      return;
    }

    setAuthStatus(payload.message || "Account created.", "is-info");
  } catch (error) {
    setAuthStatus(`Create account failed: ${error.message || "Unknown error"}`, "is-error");
  }
}

async function logoutUser() {
  if (!isCloudSyncActive()) {
    setAuthStatus("Cloud sync is disabled.", "is-warn");
    return;
  }

  try {
    await requestApi("/api/auth/logout", { method: "POST" });
  } catch (error) {
    setAuthStatus(`Logout failed: ${error.message || "Unknown error"}`, "is-error");
    return;
  }

  setPasswordRecoveryMode(false);
  await handleAuthSession(null, "session");
  setAuthStatus("Logged out.", "is-info");
  goTo("index.html");
}

async function saveUserRoleByAdmin() {
  if (!isCloudSyncActive() || !isAuthenticated()) {
    setAccessStatus("Login required.", "is-error");
    return;
  }

  if (!isAdmin()) {
    setAccessStatus("Only admin can manage user access.", "is-error");
    return;
  }

  const email = normalizeString(elements.accessEmail?.value).toLowerCase();
  const role = normalizeString(elements.accessRole?.value).toLowerCase();
  const status = normalizeString(elements.accessStatusSelect?.value).toLowerCase();

  if (
    !email ||
    (role !== "admin" && role !== "employee") ||
    (status !== "active" && status !== "inactive")
  ) {
    setAccessStatus("Provide valid email, role, and status.", "is-error");
    return;
  }

  try {
    const payload = await requestApi("/api/access", {
      method: "POST",
      body: {
        email,
        role,
        status,
      },
    });

    setAccessStatus(payload.message || `Saved ${email} as ${role} (${status}).`, "is-ok");
  } catch (error) {
    setAccessStatus(`Could not save access: ${error.message || "Unknown error"}`, "is-error");
    return;
  }
}

function bindDashboardEvents() {
  safeListen(elements.form, "submit", (event) => {
    handleFormSubmit(event);
  });

  safeListen(elements.cancelEditButton, "click", () => {
    resetFormState();
    renderPage();
  });

  safeListen(elements.searchInput, "input", (event) => {
    state.searchTerm = normalizeString(event.target.value);
    renderPage();
  });

  safeListen(elements.statusFilterSelect, "change", (event) => {
    state.statusFilter = normalizeString(event.target.value) || "all";
    renderPage();
  });

  safeListen(elements.sortSelect, "change", (event) => {
    state.sortBy = normalizeString(event.target.value) || "recent";
    renderPage();
  });

  safeListen(elements.clearFiltersButton, "click", () => {
    state.searchTerm = "";
    state.statusFilter = "all";
    state.sortBy = "recent";
    if (elements.searchInput) {
      elements.searchInput.value = "";
    }
    if (elements.statusFilterSelect) {
      elements.statusFilterSelect.value = "all";
    }
    if (elements.sortSelect) {
      elements.sortSelect.value = "recent";
    }
    renderPage();
  });

  safeListen(elements.exportButton, "click", handleExport);

  safeListen(elements.importButton, "click", () => {
    elements.importInput?.click();
  });

  safeListen(elements.importInput, "change", (event) => {
    handleImportFile(event.target.files?.[0]);
  });

  safeListen(elements.clearAllButton, "click", () => {
    handleClearAll();
  });
}

function bindAuthEvents() {
  safeListen(elements.authLoginButton, "click", () => {
    loginUser();
  });

  safeListen(elements.authSignupButton, "click", () => {
    signupUser();
  });

  safeListen(elements.authForgotButton, "click", () => {
    requestPasswordRecovery();
  });

  safeListen(elements.authResendVerifyButton, "click", () => {
    resendVerificationEmail();
  });

  safeListen(elements.resetPasswordButton, "click", () => {
    updatePasswordFromRecovery();
  });

  safeListen(elements.resetCancelButton, "click", () => {
    cancelPasswordRecoveryMode();
  });

  safeListen(elements.authLogoutButton, "click", () => {
    logoutUser();
  });

  safeListen(elements.headerLogout, "click", () => {
    logoutUser();
  });
}

function bindAccessEvents() {
  safeListen(elements.accessSaveButton, "click", () => {
    saveUserRoleByAdmin();
  });

  safeListen(elements.syncSaveButton, "click", () => {
    enableCloudSyncFromInputs();
  });

  safeListen(elements.syncDisableButton, "click", () => {
    disableCloudSync();
  });
}

function bindAllEvents() {
  bindAuthEvents();
  bindDashboardEvents();
  bindAccessEvents();

  safeListen(document, "keydown", (event) => {
    if (currentPage !== "dashboard") {
      return;
    }

    if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const tagName = String(event.target?.tagName || "").toLowerCase();
      if (tagName === "input" || tagName === "textarea" || event.target?.isContentEditable) {
        return;
      }

      event.preventDefault();
      elements.searchInput?.focus();
    }
  });
}

async function init() {
  setupPageTransitions();
  bindAllEvents();

  state.sortBy = normalizeString(elements.sortSelect?.value) || "recent";
  state.statusFilter = normalizeString(elements.statusFilterSelect?.value) || "all";

  await loadRuntimeConfig();
  await processAuthCallbackFromUrl();
  await restoreSyncOnStartup();
  applyPendingAuthNotice();
  renderPage();
}

init();
