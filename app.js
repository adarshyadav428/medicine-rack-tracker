const STORAGE_KEY = "medicineRackTracker.v1";
const SYNC_CONFIG_KEY = "medicineRackTracker.sync.v1";

const currentPage = document.body.dataset.page || "home";
const allowedPages = new Set(["index.html", "dashboard.html", "access.html"]);

const state = {
  items: [],
  searchTerm: "",
  sortBy: "recent",
  editingId: null,
  sync: {
    enabled: false,
    projectUrl: "",
    anonKey: "",
    tableName: "medicines",
    roleTable: "user_roles",
    adminEmails: [],
    client: null,
    realtimeChannel: null,
  },
  auth: {
    user: null,
    role: "guest",
    authSubscription: null,
    pendingRedirectAfterLogin: false,
  },
};

const elements = {
  headerUser: document.getElementById("header-user"),
  headerLogout: document.getElementById("header-logout"),

  authEmail: document.getElementById("auth-email"),
  authPassword: document.getElementById("auth-password"),
  authLoginButton: document.getElementById("auth-login-button"),
  authSignupButton: document.getElementById("auth-signup-button"),
  authLogoutButton: document.getElementById("auth-logout-button"),
  authStatus: document.getElementById("auth-status"),
  currentUser: document.getElementById("current-user"),

  dashboardStatus: document.getElementById("dashboard-status"),
  metricTotal: document.getElementById("metric-total"),
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
  sortSelect: document.getElementById("sort-select"),
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
  return Boolean(state.sync.enabled && state.sync.client);
}

function isAuthenticated() {
  return Boolean(state.auth.user);
}

function isAdmin() {
  return state.auth.role === "admin";
}

function canViewRecords() {
  return !isCloudSyncActive() || isAuthenticated();
}

function canWriteRecords() {
  return !isCloudSyncActive() || isAdmin();
}

function canManageAccess() {
  return !isCloudSyncActive() || isAdmin();
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

function getDefaultSyncConfig() {
  const defaults = window.APP_SYNC_CONFIG || {};
  return {
    enabled: Boolean(defaults.enabled),
    projectUrl: normalizeString(defaults.projectUrl),
    anonKey: normalizeString(defaults.anonKey),
    tableName: normalizeString(defaults.tableName) || "medicines",
    roleTable: normalizeString(defaults.roleTable) || "user_roles",
    adminEmails: Array.isArray(defaults.adminEmails)
      ? defaults.adminEmails.map((entry) => normalizeString(entry).toLowerCase()).filter(Boolean)
      : [],
  };
}

function loadSyncConfig() {
  const fallback = getDefaultSyncConfig();
  const raw = localStorage.getItem(SYNC_CONFIG_KEY);
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw);
    const hasEnabled = typeof parsed.enabled === "boolean";
    return {
      enabled: hasEnabled ? parsed.enabled : fallback.enabled,
      projectUrl: normalizeString(parsed.projectUrl) || fallback.projectUrl,
      anonKey: normalizeString(parsed.anonKey) || fallback.anonKey,
      tableName: normalizeString(parsed.tableName) || fallback.tableName,
      roleTable: normalizeString(parsed.roleTable) || fallback.roleTable,
      adminEmails: Array.isArray(parsed.adminEmails)
        ? parsed.adminEmails.map((entry) => normalizeString(entry).toLowerCase()).filter(Boolean)
        : fallback.adminEmails,
    };
  } catch {
    return fallback;
  }
}

function saveSyncConfig() {
  localStorage.setItem(
    SYNC_CONFIG_KEY,
    JSON.stringify({
      enabled: state.sync.enabled,
      projectUrl: state.sync.projectUrl,
      anonKey: state.sync.anonKey,
      tableName: state.sync.tableName,
      roleTable: state.sync.roleTable,
      adminEmails: state.sync.adminEmails,
    })
  );
}

function hydrateSyncInputs() {
  if (elements.syncEnabled) {
    elements.syncEnabled.checked = state.sync.enabled;
  }
  if (elements.syncUrl) {
    elements.syncUrl.value = state.sync.projectUrl;
  }
  if (elements.syncAnonKey) {
    elements.syncAnonKey.value = state.sync.anonKey;
  }
  if (elements.syncTable) {
    elements.syncTable.value = state.sync.tableName || "medicines";
  }
}

function ensureSupabaseAvailable() {
  return Boolean(window.supabase && typeof window.supabase.createClient === "function");
}

function createCloudClient(projectUrl, anonKey) {
  if (!ensureSupabaseAvailable()) {
    throw new Error("Supabase SDK not loaded.");
  }

  return window.supabase.createClient(projectUrl, anonKey);
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

function stopRealtimeSync() {
  if (!state.sync.client || !state.sync.realtimeChannel) {
    return;
  }

  state.sync.client.removeChannel(state.sync.realtimeChannel);
  state.sync.realtimeChannel = null;
}

function startRealtimeSync() {
  if (!isCloudSyncActive() || !isAuthenticated()) {
    return;
  }

  if (state.sync.realtimeChannel) {
    return;
  }

  const channelName = `medicines-live-${Date.now()}`;
  state.sync.realtimeChannel = state.sync.client
    .channel(channelName)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: state.sync.tableName },
      async () => {
        await refreshItemsFromCloud();
      }
    )
    .subscribe();
}

async function fetchCloudItems() {
  const { data, error } = await state.sync.client
    .from(state.sync.tableName)
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data
    .map(fromCloudRow)
    .map(normalizeItem)
    .filter((item) => item.medicineName && item.location);
}

async function upsertCloudItem(item) {
  const row = toCloudRow(item);
  const { data, error } = await state.sync.client
    .from(state.sync.tableName)
    .upsert(row)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return normalizeItem(fromCloudRow(data));
}

async function deleteCloudItem(itemId) {
  const { error } = await state.sync.client.from(state.sync.tableName).delete().eq("id", itemId);
  if (error) {
    throw error;
  }
}

async function replaceAllCloudItems(newItems) {
  const existing = await fetchCloudItems();
  if (existing.length) {
    const ids = existing.map((item) => item.id);
    const { error: deleteError } = await state.sync.client
      .from(state.sync.tableName)
      .delete()
      .in("id", ids);

    if (deleteError) {
      throw deleteError;
    }
  }

  if (newItems.length) {
    const rows = newItems.map(toCloudRow);
    const { error: insertError } = await state.sync.client.from(state.sync.tableName).insert(rows);
    if (insertError) {
      throw insertError;
    }
  }
}

async function getRoleForCurrentUser() {
  if (!isAuthenticated()) {
    return "guest";
  }

  const email = normalizeString(state.auth.user.email).toLowerCase();

  if (state.sync.adminEmails.includes(email)) {
    return "admin";
  }

  const { data, error } = await state.sync.client
    .from(state.sync.roleTable)
    .select("role, is_active")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data && data.is_active === false) {
    return "inactive";
  }

  if (data && normalizeString(data.role)) {
    return normalizeString(data.role).toLowerCase();
  }

  return "employee";
}

async function refreshItemsFromCloud() {
  if (!isCloudSyncActive() || !isAuthenticated()) {
    state.items = isCloudSyncActive() ? [] : loadLocalItems();
    renderPage();
    return;
  }

  try {
    state.items = await fetchCloudItems();
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

  if (currentPage === "access" && isCloudSyncActive()) {
    if (!isAuthenticated()) {
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
  state.auth.user = session?.user || null;

  if (!state.auth.user) {
    state.auth.role = "guest";
    stopRealtimeSync();
    state.items = isCloudSyncActive() ? [] : loadLocalItems();
    renderHeaderSession();

    if (isCloudSyncActive()) {
      setAuthStatus("Login required to access cloud data.", "is-warn");
    } else {
      setAuthStatus("Not signed in. Local mode active.", "is-info");
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
      await state.sync.client.auth.signOut();
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
  if (!isCloudSyncActive() || state.auth.authSubscription) {
    return;
  }

  const { data } = state.sync.client.auth.onAuthStateChange((event, session) => {
    const source = event === "SIGNED_IN" ? "signed-in" : "session";
    handleAuthSession(session, source);
  });

  state.auth.authSubscription = data.subscription;
}

function disableCloudSync() {
  state.sync.enabled = false;
  state.sync.client = null;

  if (state.auth.authSubscription) {
    state.auth.authSubscription.unsubscribe();
    state.auth.authSubscription = null;
  }

  stopRealtimeSync();

  state.auth.user = null;
  state.auth.role = "guest";
  state.items = loadLocalItems();

  saveSyncConfig();
  hydrateSyncInputs();
  renderHeaderSession();
  setSyncStatus("Cloud sync disabled. Local storage mode active.", "is-warn");
  setAuthStatus("Not signed in. Local mode active.", "is-info");

  if (!enforcePageGuard()) {
    return;
  }

  renderPage();
}

function parseSyncInputs() {
  return {
    enabled: elements.syncEnabled ? elements.syncEnabled.checked : false,
    projectUrl: normalizeString(elements.syncUrl?.value),
    anonKey: normalizeString(elements.syncAnonKey?.value),
    tableName: normalizeString(elements.syncTable?.value) || "medicines",
  };
}

async function enableCloudSyncFromInputs() {
  const config = parseSyncInputs();

  if (!config.enabled) {
    disableCloudSync();
    return;
  }

  if (!config.projectUrl || !config.anonKey) {
    setSyncStatus("Supabase URL and Anon Key are required.", "is-error");
    return;
  }

  try {
    const defaults = getDefaultSyncConfig();
    state.sync = {
      ...state.sync,
      ...config,
      roleTable: defaults.roleTable,
      adminEmails: defaults.adminEmails,
      client: createCloudClient(config.projectUrl, config.anonKey),
      enabled: true,
    };

    saveSyncConfig();
    hydrateSyncInputs();
    setSyncStatus("Cloud sync enabled. Login required.", "is-ok");

    ensureAuthListener();
    const { data, error } = await state.sync.client.auth.getSession();
    if (error) {
      throw error;
    }

    await handleAuthSession(data.session, "startup");
  } catch (error) {
    state.sync.enabled = false;
    state.sync.client = null;
    saveSyncConfig();
    setSyncStatus(`Cloud sync failed: ${error.message || "Unknown error"}`, "is-error");
  }
}

async function restoreSyncOnStartup() {
  const persisted = loadSyncConfig();
  state.sync = {
    ...state.sync,
    ...persisted,
    client: null,
  };

  hydrateSyncInputs();

  if (!state.sync.enabled || !state.sync.projectUrl || !state.sync.anonKey) {
    state.items = loadLocalItems();
    setSyncStatus("Local mode active.", "is-info");
    renderHeaderSession();

    if (!enforcePageGuard()) {
      return;
    }

    renderPage();
    return;
  }

  try {
    state.sync.client = createCloudClient(state.sync.projectUrl, state.sync.anonKey);
    ensureAuthListener();

    const { data, error } = await state.sync.client.auth.getSession();
    if (error) {
      throw error;
    }

    setSyncStatus("Cloud sync connected.", "is-ok");
    await handleAuthSession(data.session, "startup");
  } catch (error) {
    state.sync.enabled = false;
    state.sync.client = null;
    saveSyncConfig();
    state.items = loadLocalItems();
    setSyncStatus(
      `Cloud sync startup failed (${error.message || "Unknown"}). Local mode active.`,
      "is-warn"
    );

    if (!enforcePageGuard()) {
      return;
    }

    renderPage();
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

  const filtered = state.items.filter((item) => {
    if (!search) {
      return true;
    }

    return (
      item.medicineName.toLowerCase().includes(search) ||
      item.location.toLowerCase().includes(search)
    );
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

function renderSummary(visibleCount) {
  if (!elements.summary) {
    return;
  }

  const totalCount = state.items.length;
  if (!totalCount) {
    elements.summary.textContent = "No medicines saved yet.";
    return;
  }

  if (visibleCount === totalCount) {
    elements.summary.textContent = `${totalCount} medicine${totalCount > 1 ? "s" : ""} stored.`;
    return;
  }

  elements.summary.textContent = `Showing ${visibleCount} of ${totalCount} medicine${totalCount > 1 ? "s" : ""}.`;
}

function renderMetrics(items) {
  if (elements.metricTotal) {
    elements.metricTotal.textContent = String(items.length);
  }

  const expiring = items.filter((item) => getExpiryStatus(item.expiryDate).kind === "expiring").length;
  const expired = items.filter((item) => getExpiryStatus(item.expiryDate).kind === "expired").length;

  if (elements.metricExpiring) {
    elements.metricExpiring.textContent = String(expiring);
  }

  if (elements.metricExpired) {
    elements.metricExpired.textContent = String(expired);
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

    row.querySelector(".medicine-name").textContent = item.medicineName;
    row.querySelector(".medicine-location").textContent = item.location;
    row.querySelector(".medicine-extra").textContent = `${quantityText} | ${expiry.label}`;
    row.querySelector(".medicine-meta").textContent = `Updated: ${formatTimestamp(item.updatedAt)}`;

    card.classList.remove("is-expiring", "is-expired", "is-safe");
    if (expiry.kind === "expired") {
      card.classList.add("is-expired");
    } else if (expiry.kind === "expiring") {
      card.classList.add("is-expiring");
    } else if (expiry.kind === "safe") {
      card.classList.add("is-safe");
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
    setDashboardStatus("Please login to view medicine data.", "is-warn");
    return;
  }

  const itemsToRender = getFilteredAndSortedItems();
  renderMetrics(state.items);
  renderSummary(itemsToRender.length);
  renderMedicineList(itemsToRender);

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
    setAccessStatus("Only admin can manage user access.", "is-warn");
  }
}

function renderPage() {
  renderHeaderSession();
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

      await replaceAllItems(normalized);
      window.alert(`Imported ${normalized.length} medicine record${normalized.length === 1 ? "" : "s"}.`);
    } catch (error) {
      window.alert(error.message || "Import failed.");
    } finally {
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

async function loginUser() {
  if (!isCloudSyncActive()) {
    setAuthStatus("Enable cloud sync first.", "is-warn");
    return;
  }

  const email = normalizeString(elements.authEmail?.value);
  const password = normalizeString(elements.authPassword?.value);

  if (!email || !password) {
    setAuthStatus("Enter email and password.", "is-error");
    return;
  }

  state.auth.pendingRedirectAfterLogin = true;

  const { error } = await state.sync.client.auth.signInWithPassword({ email, password });
  if (error) {
    state.auth.pendingRedirectAfterLogin = false;
    setAuthStatus(`Login failed: ${error.message}`, "is-error");
    return;
  }

  setAuthStatus("Login successful.", "is-ok");
}

async function signupUser() {
  if (!isCloudSyncActive()) {
    setAuthStatus("Enable cloud sync first.", "is-warn");
    return;
  }

  const email = normalizeString(elements.authEmail?.value);
  const password = normalizeString(elements.authPassword?.value);

  if (!email || !password) {
    setAuthStatus("Enter email and password.", "is-error");
    return;
  }

  const { error } = await state.sync.client.auth.signUp({ email, password });
  if (error) {
    setAuthStatus(`Create account failed: ${error.message}`, "is-error");
    return;
  }

  setAuthStatus("Account created. Verify email if confirmation is enabled.", "is-info");
}

async function logoutUser() {
  if (!isCloudSyncActive()) {
    setAuthStatus("Cloud sync is disabled.", "is-warn");
    return;
  }

  const { error } = await state.sync.client.auth.signOut();
  if (error) {
    setAuthStatus(`Logout failed: ${error.message}`, "is-error");
    return;
  }

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

  const { error } = await state.sync.client
    .from(state.sync.roleTable)
    .upsert({ email, role, is_active: status === "active" }, { onConflict: "email" });

  if (error) {
    setAccessStatus(`Could not save access: ${error.message}`, "is-error");
    return;
  }

  setAccessStatus(`Saved ${email} as ${role} (${status}).`, "is-ok");
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

  safeListen(elements.sortSelect, "change", (event) => {
    state.sortBy = normalizeString(event.target.value) || "recent";
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
}

async function init() {
  setupPageTransitions();
  bindAllEvents();

  state.sortBy = normalizeString(elements.sortSelect?.value) || "recent";

  await restoreSyncOnStartup();
  renderPage();
}

init();
