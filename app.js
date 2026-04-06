const STORAGE_KEY = "medicineRackTracker.v1";
const SYNC_CONFIG_KEY = "medicineRackTracker.sync.v1";

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
    subscription: null,
  },
};

const elements = {
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
  importInput: document.getElementById("import-input"),
  clearAllButton: document.getElementById("clear-all-button"),
  summary: document.getElementById("summary"),
  listContainer: document.getElementById("list-container"),
  rowTemplate: document.getElementById("medicine-row-template"),
  syncEnabled: document.getElementById("sync-enabled"),
  syncUrl: document.getElementById("sync-url"),
  syncAnonKey: document.getElementById("sync-anon-key"),
  syncTable: document.getElementById("sync-table"),
  syncSaveButton: document.getElementById("sync-save-button"),
  syncDisableButton: document.getElementById("sync-disable-button"),
  syncStatus: document.getElementById("sync-status"),
  authEmail: document.getElementById("auth-email"),
  authPassword: document.getElementById("auth-password"),
  authLoginButton: document.getElementById("auth-login-button"),
  authSignupButton: document.getElementById("auth-signup-button"),
  authLogoutButton: document.getElementById("auth-logout-button"),
  authStatus: document.getElementById("auth-status"),
  currentUser: document.getElementById("current-user"),
  adminAccessPanel: document.getElementById("admin-access-panel"),
  accessEmail: document.getElementById("access-email"),
  accessRole: document.getElementById("access-role"),
  accessSaveButton: document.getElementById("access-save-button"),
  accessStatus: document.getElementById("access-status"),
};

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

function formatTimestamp(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "Unknown time";
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

function normalizeKey(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pickValueByKnownKeys(record, keyCandidates) {
  if (!record || typeof record !== "object") {
    return "";
  }

  const normalizedCandidates = keyCandidates.map(normalizeKey);

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

  const header = rows[0].map((cell) => normalizeString(cell));
  if (!header.some(Boolean)) {
    return [];
  }

  return rows.slice(1).map((row) => {
    const obj = {};
    header.forEach((columnName, index) => {
      if (columnName) {
        obj[columnName] = row[index];
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

  const candidateArrays = [parsed.items, parsed.data, parsed.rows, parsed.values, parsed.records];
  for (const candidate of candidateArrays) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function convertImportRowsToItems(rows) {
  const medicineKeys = [
    "medicineName",
    "medicine",
    "name",
    "medicine_name",
    "drug",
    "tablet",
    "item",
  ];

  const locationKeys = [
    "location",
    "rack",
    "place",
    "rackPlace",
    "rack_place",
    "storage",
    "position",
    "shelf",
  ];

  const quantityKeys = ["quantity", "qty", "count", "stock", "units", "balance"];
  const expiryKeys = [
    "expiryDate",
    "expiry",
    "expire",
    "expdate",
    "expiry_date",
    "expireson",
    "bestbefore",
  ];

  let objectRows = rows;

  if (rows.length && Array.isArray(rows[0])) {
    objectRows = arrayRowsToObjects(rows);
  }

  return objectRows
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

function getExpiryStatus(expiryDate) {
  const normalizedDate = normalizeDateOnly(expiryDate);
  if (!normalizedDate) {
    return {
      kind: "none",
      label: "No expiry date set",
    };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const target = new Date(`${normalizedDate}T00:00:00`);
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
    label: `Expiry: ${normalizedDate}`,
  };
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
  const defaultConfig = window.APP_SYNC_CONFIG || {};
  return {
    enabled: Boolean(defaultConfig.enabled),
    projectUrl: normalizeString(defaultConfig.projectUrl),
    anonKey: normalizeString(defaultConfig.anonKey),
    tableName: normalizeString(defaultConfig.tableName) || "medicines",
    roleTable: normalizeString(defaultConfig.roleTable) || "user_roles",
    adminEmails: Array.isArray(defaultConfig.adminEmails)
      ? defaultConfig.adminEmails.map((e) => normalizeString(e).toLowerCase()).filter(Boolean)
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
    const parsedEnabled = parsed.enabled;
    const hasExplicitEnabled = typeof parsedEnabled === "boolean";

    return {
      enabled: hasExplicitEnabled ? parsedEnabled : fallback.enabled,
      projectUrl: normalizeString(parsed.projectUrl) || fallback.projectUrl,
      anonKey: normalizeString(parsed.anonKey) || fallback.anonKey,
      tableName: normalizeString(parsed.tableName) || fallback.tableName,
      roleTable: normalizeString(parsed.roleTable) || fallback.roleTable,
      adminEmails: Array.isArray(parsed.adminEmails)
        ? parsed.adminEmails.map((e) => normalizeString(e).toLowerCase()).filter(Boolean)
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

function showFormError(message = "") {
  elements.formError.textContent = message;
}

function setSyncStatus(message, tone = "") {
  elements.syncStatus.textContent = message;
  elements.syncStatus.classList.remove("is-ok", "is-warn", "is-error", "is-info");
  if (tone) {
    elements.syncStatus.classList.add(tone);
  }
}

function setAuthStatus(message, tone = "") {
  elements.authStatus.textContent = message;
  elements.authStatus.classList.remove("is-ok", "is-warn", "is-error", "is-info");
  if (tone) {
    elements.authStatus.classList.add(tone);
  }
}

function setAccessStatus(message, tone = "") {
  elements.accessStatus.textContent = message;
  elements.accessStatus.classList.remove("is-ok", "is-warn", "is-error", "is-info");
  if (tone) {
    elements.accessStatus.classList.add(tone);
  }
}

function hydrateSyncInputsFromState() {
  elements.syncEnabled.checked = state.sync.enabled;
  elements.syncUrl.value = state.sync.projectUrl;
  elements.syncAnonKey.value = state.sync.anonKey;
  elements.syncTable.value = state.sync.tableName || "medicines";
}

function resetForm() {
  elements.form.reset();
  state.editingId = null;
  elements.cancelEditButton.classList.add("hidden");
  elements.saveButton.textContent = "Save Medicine";
  showFormError();
  elements.medicineName.focus();
}

function beginEdit(itemId) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  state.editingId = itemId;
  elements.medicineName.value = item.medicineName;
  elements.location.value = item.location;
  elements.quantity.value = item.quantity ?? "";
  elements.expiryDate.value = item.expiryDate || "";
  elements.cancelEditButton.classList.remove("hidden");
  elements.saveButton.textContent = "Update Medicine";
  showFormError();
  elements.medicineName.focus();
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

function canDeleteRecords() {
  return !isCloudSyncActive() || isAdmin();
}

function canImportClearRecords() {
  return !isCloudSyncActive() || isAdmin();
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
  const existingRows = await fetchCloudItems();
  if (existingRows.length) {
    const existingIds = existingRows.map((item) => item.id);
    const { error: deleteError } = await state.sync.client
      .from(state.sync.tableName)
      .delete()
      .in("id", existingIds);

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

function syncStateToLocalCache() {
  saveLocalItems(state.items);
}

function getFilteredAndSortedItems() {
  const search = state.searchTerm.toLowerCase();

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

function applyRoleBasedUi() {
  const cloudWithoutAuth = isCloudSyncActive() && !isAuthenticated();
  const disableWrite = cloudWithoutAuth;
  const disableDanger = cloudWithoutAuth || !canDeleteRecords();
  const disableImportClear = cloudWithoutAuth || !canImportClearRecords();

  elements.saveButton.disabled = disableWrite;
  elements.cancelEditButton.disabled = disableWrite;
  elements.importButton.disabled = disableImportClear;
  elements.clearAllButton.disabled = disableImportClear;

  elements.adminAccessPanel.classList.toggle("hidden", !isAdmin());

  if (isCloudSyncActive() && !isAuthenticated()) {
    setAuthStatus("Cloud mode is active. Please login to access data.", "is-warn");
  }

  if (disableDanger) {
    elements.clearAllButton.title = isAdmin() || !isCloudSyncActive()
      ? ""
      : "Only admin can clear all records.";
  } else {
    elements.clearAllButton.title = "";
  }
}

function renderList(itemsToRender) {
  elements.listContainer.textContent = "";

  if (!itemsToRender.length) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "empty-state";
    emptyMessage.textContent = state.items.length
      ? "No results match your search."
      : "Start by adding your first medicine and location.";
    elements.listContainer.appendChild(emptyMessage);
    return;
  }

  const fragment = document.createDocumentFragment();

  itemsToRender.forEach((item) => {
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

    row.querySelector(".action-edit").addEventListener("click", () => beginEdit(item.id));

    const deleteButton = row.querySelector(".action-delete");
    if (!canDeleteRecords()) {
      deleteButton.disabled = true;
      deleteButton.title = "Only admin can delete records.";
    } else {
      deleteButton.addEventListener("click", () => {
        handleDeleteItem(item.id);
      });
    }

    if (state.editingId === item.id) {
      card.style.borderColor = "rgba(19, 111, 99, 0.8)";
      card.style.boxShadow = "0 0 0 2px rgba(19, 111, 99, 0.18)";
    }

    fragment.appendChild(row);
  });

  elements.listContainer.appendChild(fragment);
}

function render() {
  const itemsToRender = getFilteredAndSortedItems();
  renderSummary(itemsToRender.length);
  renderList(itemsToRender);
  applyRoleBasedUi();
}

async function handleDeleteItem(itemId) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  if (!canDeleteRecords()) {
    window.alert("Only admin can delete records in cloud mode.");
    return;
  }

  const confirmed = window.confirm(`Delete \"${item.medicineName}\" from the list?`);
  if (!confirmed) {
    return;
  }

  try {
    if (isCloudSyncActive()) {
      await deleteCloudItem(itemId);
    }

    state.items = state.items.filter((entry) => entry.id !== itemId);
    syncStateToLocalCache();

    if (state.editingId === itemId) {
      resetForm();
    }

    render();
  } catch (error) {
    window.alert(`Delete failed: ${error.message || "Unknown error"}`);
  }
}

async function handleFormSubmit(event) {
  event.preventDefault();

  if (isCloudSyncActive() && !isAuthenticated()) {
    showFormError("Please login to add or edit records in cloud mode.");
    return;
  }

  const medicineName = normalizeString(elements.medicineName.value);
  const location = normalizeString(elements.location.value);
  const rawQuantity = normalizeString(elements.quantity.value);
  const parsedQuantity = normalizePositiveInteger(rawQuantity);
  const expiryDate = normalizeDateOnly(elements.expiryDate.value);

  if (!medicineName || !location) {
    showFormError("Medicine name and rack/place are required.");
    return;
  }

  if (rawQuantity && parsedQuantity === null) {
    showFormError("Quantity must be a non-negative whole number.");
    return;
  }

  const now = new Date().toISOString();

  try {
    if (state.editingId) {
      const existing = state.items.find((item) => item.id === state.editingId);
      if (!existing) {
        showFormError("The selected medicine no longer exists.");
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

    syncStateToLocalCache();
    resetForm();
    render();
  } catch (error) {
    showFormError(`Save failed: ${error.message || "Unknown error"}`);
  }
}

function handleExport() {
  const payload = {
    exportedAt: new Date().toISOString(),
    schema: 3,
    items: state.items,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "medicine-rack-tracker-export.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function replaceAllItems(newItems) {
  if (isCloudSyncActive()) {
    if (!canImportClearRecords()) {
      throw new Error("Only admin can import/clear data in cloud mode.");
    }
    if (!isAuthenticated()) {
      throw new Error("Please login to import/clear data in cloud mode.");
    }
    await replaceAllCloudItems(newItems);
  }

  state.items = [...newItems];
  syncStateToLocalCache();
  resetForm();
  render();
}

function handleImportFile(file) {
  if (!file) {
    return;
  }

  const reader = new FileReader();

  reader.onload = async () => {
    try {
      const parsed = JSON.parse(String(reader.result || ""));

      const importedRows = extractImportRows(parsed);
      if (!importedRows.length) {
        throw new Error("Invalid format");
      }

      const normalized = convertImportRowsToItems(importedRows);
      if (!normalized.length) {
        window.alert(
          "Import worked, but no rows matched medicine + location columns. Rename your sheet columns to values like Medicine Name and Rack/Place, then try again."
        );
        return;
      }

      await replaceAllItems(normalized);
      window.alert(`Imported ${normalized.length} medicine record${normalized.length === 1 ? "" : "s"}.`);
    } catch (error) {
      window.alert(error.message || "Could not import file. Please choose a valid JSON export.");
    } finally {
      elements.importInput.value = "";
    }
  };

  reader.readAsText(file);
}

async function handleClearAll() {
  if (!state.items.length) {
    return;
  }

  const confirmed = window.confirm(
    "Clear all medicines? This cannot be undone unless you exported a backup."
  );

  if (!confirmed) {
    return;
  }

  try {
    await replaceAllItems([]);
  } catch (error) {
    window.alert(`Could not clear records: ${error.message || "Unknown error"}`);
  }
}

function parseSyncInputs() {
  return {
    enabled: elements.syncEnabled.checked,
    projectUrl: normalizeString(elements.syncUrl.value),
    anonKey: normalizeString(elements.syncAnonKey.value),
    tableName: normalizeString(elements.syncTable.value) || "medicines",
  };
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
    .select("role")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data && normalizeString(data.role)) {
    return normalizeString(data.role).toLowerCase();
  }

  return "employee";
}

async function refreshItemsFromCloud() {
  if (!isCloudSyncActive() || !isAuthenticated()) {
    state.items = isCloudSyncActive() ? [] : loadLocalItems();
    render();
    return;
  }

  try {
    state.items = await fetchCloudItems();
    syncStateToLocalCache();
    render();
  } catch (error) {
    setSyncStatus(`Could not load cloud data: ${error.message || "Unknown error"}`, "is-error");
  }
}

async function handleAuthSession(session) {
  state.auth.user = session?.user || null;

  if (!state.auth.user) {
    state.auth.role = "guest";
    elements.currentUser.textContent = "";
    stopRealtimeSync();
    if (isCloudSyncActive()) {
      state.items = [];
      setAuthStatus("Signed out. Login required for cloud data access.", "is-warn");
    } else {
      setAuthStatus("Signed out. Local mode is available.", "is-info");
    }
    render();
    return;
  }

  try {
    state.auth.role = await getRoleForCurrentUser();
    elements.currentUser.textContent = `Signed in as ${state.auth.user.email} (${state.auth.role})`;
    setAuthStatus("Login successful.", "is-ok");
    await refreshItemsFromCloud();
    startRealtimeSync();
  } catch (error) {
    state.auth.role = "employee";
    setAuthStatus(
      `Signed in, but role lookup failed (${error.message || "Unknown"}). Defaulting to employee access.`,
      "is-warn"
    );
    await refreshItemsFromCloud();
    startRealtimeSync();
  }
}

function ensureAuthListener() {
  if (!isCloudSyncActive() || state.auth.subscription) {
    return;
  }

  const { data } = state.sync.client.auth.onAuthStateChange((event, session) => {
    handleAuthSession(session);
  });

  state.auth.subscription = data.subscription;
}

async function loginUser() {
  if (!isCloudSyncActive()) {
    setAuthStatus("Enable cloud sync first, then login.", "is-warn");
    return;
  }

  const email = normalizeString(elements.authEmail.value);
  const password = normalizeString(elements.authPassword.value);
  if (!email || !password) {
    setAuthStatus("Enter email and password.", "is-error");
    return;
  }

  const { error } = await state.sync.client.auth.signInWithPassword({ email, password });
  if (error) {
    setAuthStatus(`Login failed: ${error.message}`, "is-error");
    return;
  }

  setAuthStatus("Login request successful.", "is-ok");
}

async function signupUser() {
  if (!isCloudSyncActive()) {
    setAuthStatus("Enable cloud sync first, then create account.", "is-warn");
    return;
  }

  const email = normalizeString(elements.authEmail.value);
  const password = normalizeString(elements.authPassword.value);
  if (!email || !password) {
    setAuthStatus("Enter email and password.", "is-error");
    return;
  }

  const { error } = await state.sync.client.auth.signUp({ email, password });
  if (error) {
    setAuthStatus(`Signup failed: ${error.message}`, "is-error");
    return;
  }

  setAuthStatus("Account created. If email confirmation is enabled, verify email then login.", "is-info");
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
}

async function saveUserRoleByAdmin() {
  if (!isCloudSyncActive() || !isAuthenticated()) {
    setAccessStatus("Login first.", "is-error");
    return;
  }

  if (!isAdmin()) {
    setAccessStatus("Only admin can assign roles.", "is-error");
    return;
  }

  const email = normalizeString(elements.accessEmail.value).toLowerCase();
  const role = normalizeString(elements.accessRole.value).toLowerCase();

  if (!email || (role !== "admin" && role !== "employee")) {
    setAccessStatus("Provide a valid email and role.", "is-error");
    return;
  }

  const { error } = await state.sync.client
    .from(state.sync.roleTable)
    .upsert({ email, role }, { onConflict: "email" });

  if (error) {
    setAccessStatus(`Could not save role: ${error.message}`, "is-error");
    return;
  }

  setAccessStatus(`Saved role ${role} for ${email}.`, "is-ok");
}

async function enableCloudSyncFromInputs() {
  const config = parseSyncInputs();

  if (!config.enabled) {
    disableCloudSync();
    return;
  }

  if (!config.projectUrl || !config.anonKey) {
    setSyncStatus("Enter Supabase Project URL and Anon Key first.", "is-error");
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

    ensureAuthListener();
    const { data, error } = await state.sync.client.auth.getSession();
    if (error) {
      throw error;
    }

    saveSyncConfig();
    setSyncStatus("Cloud sync enabled. Please login to access cloud records.", "is-ok");
    await handleAuthSession(data.session);
  } catch (error) {
    state.sync.client = null;
    state.sync.enabled = false;
    saveSyncConfig();
    setSyncStatus(`Cloud sync failed: ${error.message || "Unknown error"}`, "is-error");
  }
}

function disableCloudSync() {
  state.sync.enabled = false;
  state.sync.client = null;
  if (state.auth.subscription) {
    state.auth.subscription.unsubscribe();
    state.auth.subscription = null;
  }
  stopRealtimeSync();

  state.auth.user = null;
  state.auth.role = "guest";
  elements.syncEnabled.checked = false;
  saveSyncConfig();
  state.items = loadLocalItems();
  setSyncStatus("Cloud sync disabled. Running in local browser storage mode.", "is-warn");
  setAuthStatus("Not signed in.", "is-info");
  elements.currentUser.textContent = "";
  render();
}

async function restoreSyncOnStartup() {
  const persisted = loadSyncConfig();
  state.sync = {
    ...state.sync,
    ...persisted,
    client: null,
  };
  hydrateSyncInputsFromState();

  if (!state.sync.enabled) {
    state.items = loadLocalItems();
    setSyncStatus("Sync mode: Local browser storage.", "is-warn");
    setAuthStatus("Not signed in.", "is-info");
    return;
  }

  try {
    state.sync.client = createCloudClient(state.sync.projectUrl, state.sync.anonKey);
    ensureAuthListener();
    const { data, error } = await state.sync.client.auth.getSession();
    if (error) {
      throw error;
    }

    setSyncStatus("Cloud sync is active.", "is-ok");
    await handleAuthSession(data.session);
  } catch (error) {
    state.sync.client = null;
    state.sync.enabled = false;
    saveSyncConfig();
    state.items = loadLocalItems();
    setSyncStatus(
      `Cloud sync could not start (${error.message || "Unknown error"}). Using local mode.`,
      "is-warn"
    );
    setAuthStatus("Not signed in.", "is-info");
  }
}

function wireEvents() {
  elements.form.addEventListener("submit", (event) => {
    handleFormSubmit(event);
  });

  elements.cancelEditButton.addEventListener("click", resetForm);

  elements.searchInput.addEventListener("input", (event) => {
    state.searchTerm = normalizeString(event.target.value);
    render();
  });

  elements.sortSelect.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    render();
  });

  elements.exportButton.addEventListener("click", handleExport);
  elements.importButton.addEventListener("click", () => elements.importInput.click());
  elements.importInput.addEventListener("change", (event) => {
    handleImportFile(event.target.files?.[0]);
  });
  elements.clearAllButton.addEventListener("click", () => {
    handleClearAll();
  });

  elements.syncSaveButton.addEventListener("click", () => {
    enableCloudSyncFromInputs();
  });

  elements.syncDisableButton.addEventListener("click", disableCloudSync);

  elements.authLoginButton.addEventListener("click", () => {
    loginUser();
  });

  elements.authSignupButton.addEventListener("click", () => {
    signupUser();
  });

  elements.authLogoutButton.addEventListener("click", () => {
    logoutUser();
  });

  elements.accessSaveButton.addEventListener("click", () => {
    saveUserRoleByAdmin();
  });
}

async function init() {
  state.sortBy = elements.sortSelect.value;
  wireEvents();
  await restoreSyncOnStartup();
  render();
}

init();
