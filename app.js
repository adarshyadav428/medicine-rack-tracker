const STORAGE_KEY = "medicineRackTracker.v1";

const state = {
  items: [],
  searchTerm: "",
  sortBy: "recent",
  editingId: null,
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
};

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function loadItems() {
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

function saveItems() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
}

function showFormError(message = "") {
  elements.formError.textContent = message;
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

function removeItem(itemId) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  const confirmed = window.confirm(`Delete \"${item.medicineName}\" from the list?`);
  if (!confirmed) {
    return;
  }

  state.items = state.items.filter((entry) => entry.id !== itemId);
  saveItems();

  if (state.editingId === itemId) {
    resetForm();
  }

  render();
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
    row.querySelector(".action-delete").addEventListener("click", () => removeItem(item.id));

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
}

function handleFormSubmit(event) {
  event.preventDefault();

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

  if (state.editingId) {
    state.items = state.items.map((item) => {
      if (item.id !== state.editingId) {
        return item;
      }

      return {
        ...item,
        medicineName,
        location,
        quantity: parsedQuantity,
        expiryDate,
        updatedAt: now,
      };
    });
  } else {
    state.items.unshift({
      id: createId(),
      medicineName,
      location,
      quantity: parsedQuantity,
      expiryDate,
      createdAt: now,
      updatedAt: now,
    });
  }

  saveItems();
  resetForm();
  render();
}

function handleExport() {
  const payload = {
    exportedAt: new Date().toISOString(),
    schema: 1,
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

function handleImportFile(file) {
  if (!file) {
    return;
  }

  const reader = new FileReader();

  reader.onload = () => {
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

      state.items = normalized;
      saveItems();
      resetForm();
      render();
      window.alert(`Imported ${normalized.length} medicine record${normalized.length === 1 ? "" : "s"}.`);
    } catch {
      window.alert("Could not import file. Please choose a valid JSON export.");
    } finally {
      elements.importInput.value = "";
    }
  };

  reader.readAsText(file);
}

function handleClearAll() {
  if (!state.items.length) {
    return;
  }

  const confirmed = window.confirm(
    "Clear all medicines from this browser? This cannot be undone unless you exported a backup."
  );

  if (!confirmed) {
    return;
  }

  state.items = [];
  saveItems();
  resetForm();
  render();
}

function wireEvents() {
  elements.form.addEventListener("submit", handleFormSubmit);
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
  elements.clearAllButton.addEventListener("click", handleClearAll);
}

function init() {
  state.items = loadItems();
  state.sortBy = elements.sortSelect.value;
  wireEvents();
  render();
}

init();
