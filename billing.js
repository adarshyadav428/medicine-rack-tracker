/**
 * billing.js — Billing page logic for Adarsh Medicals
 *
 * Depends on app.js globals: state, isAdmin, isAuthenticated, isCloudSyncActive,
 * requestApi, goTo, normalizeString, setStatus
 *
 * Loaded only on billing.html (data-page="billing").
 */
(function () {
  "use strict";

  if (document.body.dataset.page !== "billing") {
    return;
  }

  // -------------------------------------------------------------------------
  // Billing state
  // -------------------------------------------------------------------------
  var bState = {
    lineItems: [],        // current bill being composed
    nextRowId: 1,         // internal DOM key counter
    currentBillId: null,  // null = new bill, uuid string = editing existing
    currentBillNumber: null,
    billHistory: [],
    initialized: false,
    currentCustomerIdx: null,   // index into saved-customers array, or null
    currentCustomerBalance: 0,  // cached previous balance of selected customer
    balanceCarriedForward: false, // true after first Save Bill; prevents double-add on re-save
    editOriginalGrandTotal: null,  // grand_total of the bill when loaded for editing
    editOriginalReceived: null,    // received amount stored when that bill was first saved
    editOriginalPrevBalance: null, // opening balance (prev balance snapshot) when loaded for editing
    customerLastPrices: {},        // { medicineName.toLowerCase(): { sellPrice, markupPercent } }
    customerLastPricesFor: null,   // lowercase customer name these prices belong to
  };

  // -------------------------------------------------------------------------
  // DOM references
  // -------------------------------------------------------------------------
  var bEl = {
    status:           document.getElementById("billing-status"),
    billFormSection:  document.getElementById("bill-form-section"),
    billNumberPreview:document.getElementById("bill-number-preview"),
    billDateValue:    document.getElementById("bill-date-value"),
    customerName:     document.getElementById("bill-customer-name"),
    customerPhone:    document.getElementById("bill-customer-phone"),
    notes:            document.getElementById("bill-notes"),
    search:           document.getElementById("billing-search"),
    dropdown:         document.getElementById("billing-search-dropdown"),
    itemsEmpty:       document.getElementById("bill-items-empty"),
    itemsTableWrap:   document.getElementById("bill-items-table-wrap"),
    itemsTbody:       document.getElementById("bill-items-tbody"),
    purchasePriceTh:  document.getElementById("purchase-price-th"),
    gstPercent:       document.getElementById("bill-gst-percent"),
    subtotal:         document.getElementById("summary-subtotal"),
    gstAmount:        document.getElementById("summary-gst"),
    gstLabel:         document.getElementById("gst-label-text"),
    grandTotal:       document.getElementById("summary-grand-total"),
    itemsCount:       document.getElementById("summary-items-count"),
    saveBillButton:   document.getElementById("save-bill-button"),
    printBillButton:  document.getElementById("print-bill-button"),
    newBillButton:    document.getElementById("new-bill-button"),
    saveStatus:       document.getElementById("bill-save-status"),
    historyContainer:      document.getElementById("bill-history-container"),
    printArea:             document.getElementById("print-receipt-area"),
    savedCustomerSelect:   document.getElementById("bill-saved-customer-select"),
    saveCustomerBtn:       document.getElementById("bill-save-customer-btn"),
    repairBalanceBtn:      document.getElementById("bill-repair-balance-btn"),
    restoreCustomersBtn:   document.getElementById("bill-restore-customers-btn"),
    saveCustomerStatus:    document.getElementById("bill-save-customer-status"),
    importBillsBtn:        document.getElementById("import-bills-btn"),
    openingBalance:        document.getElementById("bill-opening-balance"),
    receivedAmount:        document.getElementById("bill-received-amount"),
    prevBalance:           document.getElementById("summary-prev-balance"),
    totalDue:              document.getElementById("summary-total-due"),
    balanceDue:            document.getElementById("summary-balance-due"),
    roundOffToggle:        document.getElementById("bill-roundoff-toggle"),
    roundOffRow:           document.getElementById("roundoff-summary-row"),
    roundOffAmount:        document.getElementById("summary-roundoff"),
    receiptModal:          document.getElementById("receipt-modal"),
    receiptModalBody:      document.getElementById("receipt-modal-body"),
    receiptModalRef:       document.getElementById("receipt-modal-ref"),
    receiptModalBackdrop:  document.getElementById("receipt-modal-backdrop"),
    receiptModalClose:     document.getElementById("receipt-modal-close-btn"),
    receiptModalPrint:     document.getElementById("receipt-modal-print-btn"),
    receiptModalShare:     document.getElementById("receipt-modal-share-btn"),
  };

  var modalBillData = null; // { billNumber, receiptHtml }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------
  function fmtMoney(val) {
    if (val === null || val === undefined) return "—";
    return "₹" + Number(val).toFixed(2);
  }

  function fmtDate(ts) {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
      });
    } catch (_) {
      return String(ts);
    }
  }

  function todayLong() {
    return new Date().toLocaleDateString("en-IN", {
      weekday: "long", day: "2-digit", month: "long", year: "numeric",
    });
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function setBillingStatus(msg, tone) {
    if (!bEl.status) return;
    bEl.status.textContent = msg || "";
    bEl.status.className = "status-message" + (tone ? " " + tone : "");
  }

  function setSaveStatus(msg, tone) {
    if (!bEl.saveStatus) return;
    bEl.saveStatus.textContent = msg || "";
    bEl.saveStatus.className = "status-message" + (tone ? " " + tone : "");
  }

  // -------------------------------------------------------------------------
  // Saved customers (localStorage)
  // -------------------------------------------------------------------------
  var CUSTOMERS_KEY = "medicineRackTracker.customers.v1";

  function loadSavedCustomers() {
    try { return JSON.parse(localStorage.getItem(CUSTOMERS_KEY) || "[]"); } catch (_) { return []; }
  }

  function persistSavedCustomers(list) {
    try { localStorage.setItem(CUSTOMERS_KEY, JSON.stringify(list)); } catch (_) {}
  }

  function renderCustomerSelect() {
    if (!bEl.savedCustomerSelect) return;
    var list = loadSavedCustomers();
    bEl.savedCustomerSelect.textContent = "";
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = list.length ? "— Select a saved customer —" : "— No saved customers yet —";
    bEl.savedCustomerSelect.appendChild(placeholder);
    list.forEach(function (c, i) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = c.name + (c.phone ? "  ·  " + c.phone : "");
      bEl.savedCustomerSelect.appendChild(opt);
    });
  }

  function onSavedCustomerChange() {
    var idx = parseInt(bEl.savedCustomerSelect ? bEl.savedCustomerSelect.value : "", 10);
    if (isNaN(idx)) {
      bState.currentCustomerIdx     = null;
      bState.currentCustomerBalance = 0;
      if (bEl.openingBalance) bEl.openingBalance.value = "";
      recalcPayment();
      return;
    }
    var list = loadSavedCustomers();
    var c = list[idx];
    if (!c) return;
    bState.currentCustomerIdx     = idx;
    bState.currentCustomerBalance = parseFloat(c.balance) || 0;
    if (bEl.customerName)   bEl.customerName.value   = c.name  || "";
    if (bEl.customerPhone)  bEl.customerPhone.value  = c.phone || "";
    if (bEl.openingBalance) bEl.openingBalance.value = bState.currentCustomerBalance || "";
    setSaveCustomerStatus("", "");
    loadCustomerLastPrices(c.name);
    recalcPayment();
  }

  function setSaveCustomerStatus(msg, tone) {
    if (!bEl.saveCustomerStatus) return;
    bEl.saveCustomerStatus.textContent = msg || "";
    bEl.saveCustomerStatus.className = "bill-save-customer-hint" + (tone ? " " + tone : "");
  }

  function saveCurrentCustomer() {
    var name    = normalizeString(bEl.customerName  ? bEl.customerName.value  : "");
    var phone   = normalizeString(bEl.customerPhone ? bEl.customerPhone.value : "");
    var balRaw  = bEl.openingBalance ? bEl.openingBalance.value : "";
    var balance = balRaw !== "" ? (parseFloat(balRaw) || 0) : 0;
    if (!name) {
      setSaveCustomerStatus("Enter a customer name first.", "is-warn");
      return;
    }
    var list = loadSavedCustomers();
    var idx = list.findIndex(function (c) {
      return c.name.toLowerCase() === name.toLowerCase();
    });
    if (idx >= 0) {
      list[idx].name  = name;
      list[idx].phone = phone;
      if (balRaw !== "") list[idx].balance = balance;
      bState.currentCustomerIdx     = idx;
      bState.currentCustomerBalance = list[idx].balance || 0;
      setSaveCustomerStatus("Customer updated.", "is-ok");
    } else {
      list.push({ name: name, phone: phone, balance: balance });
      bState.currentCustomerIdx     = list.length - 1;
      bState.currentCustomerBalance = balance;
      setSaveCustomerStatus("Customer saved.", "is-ok");
    }
    persistSavedCustomers(list);

    // Backfill missing am.billPrev snapshots for this customer's historical bills
    // so that viewing old bills from history always shows the correct Previous Balance
    // without relying on live inference every time.
    var finalBalance = (idx >= 0 ? list[idx].balance : list[list.length - 1].balance) || 0;
    if (finalBalance > 0) reconstructBillSnapshots(name, finalBalance);

    renderCustomerSelect();
    recalcPayment();
  }

  // Walk backwards through bill history for a customer and fill in any missing
  // am.billPrev.<id> localStorage snapshots, using currentBalance as the anchor.
  // Existing snapshots are never overwritten.
  function reconstructBillSnapshots(custName, currentBalance) {
    var cname = custName.toLowerCase();
    var balance = parseFloat(currentBalance) || 0;
    if (!bState.billHistory.length) return;
    var customerBills = bState.billHistory
      .filter(function (b) { return b.customer_name && b.customer_name.toLowerCase() === cname; })
      .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    if (!customerBills.length) return;
    var runningBal = balance;
    for (var i = 0; i < customerBills.length; i++) {
      var b = customerBills[i];
      var billRecv = parseFloat(localStorage.getItem("am.billRecv." + b.id) || "0") || 0;
      var prevBal  = round2(runningBal - Math.ceil(b.grand_total) + billRecv);
      if (localStorage.getItem("am.billPrev." + b.id) === null) {
        try { localStorage.setItem("am.billPrev." + b.id, String(Math.max(0, prevBal))); } catch (_e) {}
      }
      runningBal = prevBal;
    }
  }

  async function restoreCustomersFromHistory() {
    var btn = bEl.restoreCustomersBtn;
    if (btn) { btn.disabled = true; btn.textContent = "Restoring…"; }
    try {
      // Use dedicated customers endpoint (no cap) to get all-time unique customers
      var result = await requestApi("/api/bills?customers=1", { method: "GET" });
      var allCustomers = result.customers || [];

      var existing = loadSavedCustomers();
      var seen = new Set(existing.map(function (c) { return c.name.trim().toLowerCase(); }));
      var added = 0;

      allCustomers.forEach(function (c) {
        var name = (c.customer_name || "").trim();
        if (!name) return;
        var key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        existing.push({ name: name, phone: c.customer_phone || "", balance: 0 });
        added++;
      });

      persistSavedCustomers(existing);
      renderCustomerSelect();

      if (added > 0) {
        setSaveCustomerStatus(
          "✅ " + added + " customer(s) restored. Use Repair Balance to fix outstanding amounts.",
          "is-ok"
        );
      } else {
        setSaveCustomerStatus("All customers from history are already saved.", "is-ok");
      }
    } catch (err) {
      setSaveCustomerStatus("Could not restore: " + (err.message || "unknown error"), "is-warn");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Restore from History"; }
    }
  }

  // Re-chain all Previous Balance snapshots for a customer from their oldest bill
  // forward, then set the customer's stored running balance to the computed total.
  // The first bill's existing snapshot is used as the starting anchor (ground truth).
  // All subsequent bills have their snapshots overwritten with the correct value.
  function reconcileCustomerBalance() {
    var custName = normalizeString(bEl.customerName ? bEl.customerName.value : "");
    if (!custName) {
      setSaveCustomerStatus("Select or enter a customer name first.", "is-warn");
      return;
    }
    if (!bState.billHistory.length) {
      setSaveCustomerStatus("Bill history not loaded. Try again shortly.", "is-warn");
      return;
    }

    var cname = custName.toLowerCase();
    var customerBills = bState.billHistory
      .filter(function (b) { return b.customer_name && b.customer_name.toLowerCase() === cname; })
      .sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); }); // oldest first

    if (!customerBills.length) {
      setSaveCustomerStatus("No bills found for \"" + custName + "\".", "is-warn");
      return;
    }

    // Anchor: whatever is stored for the FIRST (oldest) bill — user should have
    // already corrected this if it was wrong (e.g. via Edit bill + change Opening Balance).
    var firstBill = customerBills[0];
    var startingBalance = parseFloat(localStorage.getItem("am.billPrev." + firstBill.id) || "0") || 0;

    // Walk forward: set each bill's snapshot, then advance by (grandTotal - received)
    var runningBalance = startingBalance;
    for (var i = 0; i < customerBills.length; i++) {
      var bill = customerBills[i];
      var grandTotal = Math.ceil(bill.grand_total);
      var received   = parseFloat(localStorage.getItem("am.billRecv." + bill.id) || "0") || 0;

      try { localStorage.setItem("am.billPrev." + bill.id, String(runningBalance)); } catch (_e) {}

      runningBalance = round2(runningBalance + grandTotal - received);
    }

    // Persist the corrected customer balance
    var custList = loadSavedCustomers();
    var cidx = bState.currentCustomerIdx;
    if (cidx === null || cidx === undefined) {
      cidx = custList.findIndex(function (c) { return c.name.toLowerCase() === cname; });
    }
    if (cidx >= 0) {
      custList[cidx].balance = runningBalance;
      persistSavedCustomers(custList);
      bState.currentCustomerIdx     = cidx;
      bState.currentCustomerBalance = runningBalance;
      renderCustomerSelect();
    }

    // Update the opening balance field:
    // — in edit mode: show the corrected snapshot for the bill being edited
    // — in new-bill mode: show the customer's running total (= prev balance for next bill)
    if (bState.currentBillId) {
      var thisBillPrev = parseFloat(localStorage.getItem("am.billPrev." + bState.currentBillId) || "0") || 0;
      bState.editOriginalPrevBalance = thisBillPrev;
      bState.currentCustomerBalance  = thisBillPrev;
      if (bEl.openingBalance) bEl.openingBalance.value = thisBillPrev > 0 ? String(thisBillPrev) : "";
    } else {
      if (bEl.openingBalance) bEl.openingBalance.value = runningBalance > 0 ? String(runningBalance) : "";
    }

    recalcPayment();
    setSaveCustomerStatus(
      "✅ " + customerBills.length + " bill(s) re-chained. Balance: ₹" + runningBalance,
      "is-ok"
    );
  }

  // Fetch and cache the last sell price for each medicine sold to a customer.
  // Fires async (fire-and-forget) so it never blocks the UI.
  function loadCustomerLastPrices(custName) {
    var cname = normalizeString(custName);
    if (!cname) {
      bState.customerLastPrices    = {};
      bState.customerLastPricesFor = null;
      return;
    }
    var key = cname.toLowerCase();
    if (bState.customerLastPricesFor === key) return; // already cached for this customer

    // Mark immediately so parallel calls don't fire duplicate requests
    bState.customerLastPricesFor = key;

    requestApi("/api/bills?lastprices=1&customer=" + encodeURIComponent(cname), { method: "GET" })
      .then(function (result) {
        // Only apply if the customer hasn't changed while the request was in flight
        if (bState.customerLastPricesFor === key) {
          bState.customerLastPrices = result.priceMap || {};
        }
      })
      .catch(function () {
        if (bState.customerLastPricesFor === key) {
          bState.customerLastPrices = {};
        }
      });
  }

  // -------------------------------------------------------------------------
  // Medicine Search (client-side, against state.items)
  // -------------------------------------------------------------------------
  var searchTimer          = null;
  var currentDropdownResults = [];
  var activeDropdownIdx    = -1;

  function setActiveDropdownItem(idx) {
    if (!bEl.dropdown) return;
    var items = bEl.dropdown.querySelectorAll(".medicine-dropdown-item:not(.medicine-dropdown-empty)");
    activeDropdownIdx = Math.max(-1, Math.min(idx, items.length - 1));
    items.forEach(function (el, i) {
      el.classList.toggle("medicine-dropdown-item--active", i === activeDropdownIdx);
      if (i === activeDropdownIdx) el.scrollIntoView({ block: "nearest" });
    });
  }

  function handleSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      var query = (bEl.search ? bEl.search.value : "").trim().toLowerCase();
      if (!query || query.length < 2) {
        hideDropdown();
        return;
      }
      var results = (state.items || [])
        .filter(function (item) {
          return item.medicineName.toLowerCase().includes(query);
        })
        .slice(0, 12);
      renderDropdown(results, query);
    }, 150);
  }

  function renderDropdown(results, query) {
    if (!bEl.dropdown) return;
    currentDropdownResults = results;
    activeDropdownIdx      = -1;
    bEl.dropdown.textContent = "";

    if (!results.length) {
      var noResult = document.createElement("div");
      noResult.className = "medicine-dropdown-item medicine-dropdown-empty";
      noResult.textContent = 'No medicines found for "' + query + '"';
      bEl.dropdown.appendChild(noResult);

      var addManualBtn = document.createElement("button");
      addManualBtn.type = "button";
      addManualBtn.className = "medicine-dropdown-add-manual";
      addManualBtn.textContent = "+ Add manually with custom details";
      addManualBtn.addEventListener("mousedown", function (e) {
        e.preventDefault();
        hideDropdown();
        showManualAddModal(bEl.search ? bEl.search.value.trim() : "");
      });
      bEl.dropdown.appendChild(addManualBtn);

      bEl.dropdown.classList.remove("hidden");
      return;
    }

    var frag = document.createDocumentFragment();

    results.forEach(function (item) {
      var el = document.createElement("div");
      el.className = "medicine-dropdown-item";
      el.setAttribute("role", "option");
      el.setAttribute("tabindex", "0");

      var purchase = item.purchasePrice !== null && item.purchasePrice !== undefined
        ? item.purchasePrice
        : (item.rate !== null && item.rate !== undefined ? item.rate : null);
      var sell = item.sellingPrice !== null && item.sellingPrice !== undefined
        ? item.sellingPrice
        : (item.sellPrice !== null && item.sellPrice !== undefined ? item.sellPrice : null);
      var stockLabel = item.quantity !== null && item.quantity !== undefined
        ? "Stock: " + item.quantity
        : "Stock: ?";

      var medicineLower = (item.medicineName || "").toLowerCase().trim();
      var lastPriceInfo = bState.customerLastPrices[medicineLower];

      var metaParts = [];
      if (item.location) metaParts.push("📍 " + item.location);
      if (item.mrp !== null && item.mrp !== undefined) metaParts.push("MRP: ₹" + item.mrp);
      if (purchase !== null) metaParts.push("Buy: ₹" + purchase);
      if (sell !== null) metaParts.push("Sell: ₹" + sell);
      metaParts.push(stockLabel);

      el.innerHTML =
        '<div class="medicine-dropdown-item-content">' +
          '<div class="medicine-dropdown-name-row">' +
            '<span class="medicine-dropdown-name">' + item.medicineName + "</span>" +
            (lastPriceInfo
              ? '<span class="medicine-last-price-badge">Last sold: ₹' + parseFloat(lastPriceInfo.sellPrice).toFixed(2) + '</span>'
              : "") +
          '</div>' +
          '<span class="medicine-dropdown-meta">' + metaParts.join(" · ") + "</span>" +
        '</div>' +
        '<button class="medicine-dropdown-edit-btn" type="button" title="Edit medicine in inventory">✏</button>';

      // Use mousedown so blur doesn't hide dropdown before click fires
      el.addEventListener("mousedown", function (e) {
        e.preventDefault();
        if (e.target.closest(".medicine-dropdown-edit-btn")) {
          hideDropdown();
          showMedicineEditModal(item);
          return;
        }
        addLineItem(item);
        hideDropdown();
      });
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          addLineItem(item);
          hideDropdown();
        }
      });

      frag.appendChild(el);
    });

    bEl.dropdown.appendChild(frag);
    bEl.dropdown.classList.remove("hidden");
  }

  function hideDropdown() {
    if (bEl.dropdown) bEl.dropdown.classList.add("hidden");
    activeDropdownIdx      = -1;
    currentDropdownResults = [];
  }

  // -------------------------------------------------------------------------
  // Manual-add medicine modal
  // -------------------------------------------------------------------------
  function showManualAddModal(prefillName) {
    var existing = document.getElementById("manual-add-overlay");
    if (existing) existing.parentNode.removeChild(existing);

    var overlay = document.createElement("div");
    overlay.id = "manual-add-overlay";
    overlay.className = "manual-add-overlay";
    overlay.innerHTML = [
      '<div class="manual-add-modal">',
        '<div class="manual-add-header">',
          '<h3>Add New Medicine</h3>',
          '<button class="manual-add-close" id="manual-add-close" type="button" aria-label="Close">✕</button>',
        '</div>',
        '<div class="manual-add-body">',
          '<p class="manual-add-hint">Medicine will be saved to your inventory and added to this bill.</p>',
          '<div class="manual-add-fields">',
            '<div class="manual-add-field manual-add-field--wide">',
              '<label for="manual-name">Medicine Name *</label>',
              '<input type="text" id="manual-name" autocomplete="off" maxlength="200" placeholder="e.g. Paracetamol 500mg Tab" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-mrp">MRP (&#8377;) *</label>',
              '<input type="number" id="manual-mrp" min="0" step="0.01" placeholder="0.00" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-purchase">Purchase Price (&#8377;) *</label>',
              '<input type="number" id="manual-purchase" min="0" step="0.01" placeholder="0.00" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-markup">Markup % <span class="manual-optional">(optional)</span></label>',
              '<input type="number" id="manual-markup" min="-100" step="0.01" placeholder="auto" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-sell">Sell Price (&#8377;) <span class="manual-optional">(optional — defaults to MRP)</span></label>',
              '<input type="number" id="manual-sell" min="0" step="0.01" placeholder="auto" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-location">Rack / Location <span class="manual-optional">(optional)</span></label>',
              '<input type="text" id="manual-location" autocomplete="off" maxlength="100" placeholder="e.g. A3, Shelf 2" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-qty">Bill Quantity <span class="manual-optional">(optional)</span></label>',
              '<input type="number" id="manual-qty" min="0.001" step="0.001" value="1" placeholder="1" />',
            '</div>',
          '</div>',
          '<p class="manual-add-save-status" id="manual-add-save-status"></p>',
        '</div>',
        '<div class="manual-add-footer">',
          '<button class="btn btn-ghost" id="manual-add-cancel" type="button">Cancel</button>',
          '<button class="btn btn-primary" id="manual-add-submit" type="button">Save &amp; Add to Bill</button>',
        '</div>',
      '</div>',
    ].join("");

    document.body.appendChild(overlay);

    var nameEl     = document.getElementById("manual-name");
    var locationEl = document.getElementById("manual-location");
    var mrpEl      = document.getElementById("manual-mrp");
    var purchaseEl = document.getElementById("manual-purchase");
    var markupEl   = document.getElementById("manual-markup");
    var sellEl     = document.getElementById("manual-sell");
    var qtyEl      = document.getElementById("manual-qty");
    var saveStatusEl = document.getElementById("manual-add-save-status");

    if (prefillName && nameEl) nameEl.value = prefillName;

    function recalcSell() {
      var purchase = parseFloat(purchaseEl.value);
      var markup   = parseFloat(markupEl.value);
      if (!isNaN(purchase) && !isNaN(markup)) {
        sellEl.value = round2(purchase * (1 + markup / 100));
      }
    }

    function recalcMarkup() {
      var purchase = parseFloat(purchaseEl.value);
      var sell     = parseFloat(sellEl.value);
      if (!isNaN(purchase) && purchase > 0 && !isNaN(sell)) {
        markupEl.value = round2((sell - purchase) / purchase * 100);
      }
    }

    purchaseEl.addEventListener("input", recalcSell);
    markupEl.addEventListener("input", recalcSell);
    sellEl.addEventListener("input", recalcMarkup);

    function closeModal() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (bEl.search) bEl.search.focus();
    }

    async function submitManual() {
      var name = (nameEl.value || "").trim();
      if (!name) { nameEl.focus(); return; }
      var mrpRaw      = parseFloat(mrpEl.value);
      if (isNaN(mrpRaw) || mrpRaw < 0) { mrpEl.focus(); return; }
      var purchaseRaw = parseFloat(purchaseEl.value);
      if (isNaN(purchaseRaw) || purchaseRaw < 0) { purchaseEl.focus(); return; }

      var markupRaw   = parseFloat(markupEl.value);
      // Sell price defaults to MRP if not set
      var sellRaw     = parseFloat(sellEl.value);
      if (isNaN(sellRaw) || sellRaw < 0) sellRaw = mrpRaw;
      // Auto-calc markup if not set but purchase & sell are known
      if (isNaN(markupRaw) && purchaseRaw > 0) {
        markupRaw = round2((sellRaw - purchaseRaw) / purchaseRaw * 100);
      }
      var locationVal = (locationEl.value || "").trim() || "—";
      var qty         = Math.max(0.001, parseFloat(qtyEl.value) || 0.001);

      var submitBtn = document.getElementById("manual-add-submit");
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }
      if (saveStatusEl) { saveStatusEl.textContent = ""; saveStatusEl.className = "manual-add-save-status"; }

      var savedItem = null;
      try {
        var result = await requestApi("/api/medicines", {
          method: "POST",
          body: {
            item: {
              medicineName:  name,
              location:      locationVal,
              mrp:           mrpRaw,
              purchasePrice: purchaseRaw,
              sellingPrice:  sellRaw,
              quantity:      null,
            },
          },
        });
        if (result && result.item) {
          savedItem = result.item;
          state.items.unshift(savedItem);
          if (typeof saveLocalItems === "function") saveLocalItems(state.items);
        }
      } catch (err) {
        if (saveStatusEl) {
          saveStatusEl.textContent = "⚠ Inventory save failed (" + (err.message || "unknown") + ") — adding to bill only.";
          saveStatusEl.className = "manual-add-save-status is-warn";
        }
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save & Add to Bill"; }
      }

      var rowId = "row-" + (bState.nextRowId++);
      bState.lineItems.push({
        _rowId:        rowId,
        medicineId:    savedItem ? savedItem.id : null,
        medicineName:  name,
        location:      locationVal,
        mrp:           mrpRaw,
        purchasePrice: purchaseRaw,
        sellPrice:     sellRaw,
        markupPercent: isNaN(markupRaw) ? null : markupRaw,
        quantity:      qty,
      });

      renderLineItems();
      recalcTotals();

      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (bEl.search) bEl.search.value = "";
      setTimeout(function () { if (bEl.search) bEl.search.focus(); }, 0);
    }

    document.getElementById("manual-add-close").addEventListener("click", closeModal);
    document.getElementById("manual-add-cancel").addEventListener("click", closeModal);
    document.getElementById("manual-add-submit").addEventListener("click", submitManual);

    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) closeModal();
    });

    overlay.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
    });

    qtyEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submitManual(); }
    });

    setTimeout(function () { if (nameEl) nameEl.focus(); }, 50);
  }

  // -------------------------------------------------------------------------
  // Edit existing inventory medicine modal
  // -------------------------------------------------------------------------
  function showMedicineEditModal(invItem) {
    var existing = document.getElementById("manual-add-overlay");
    if (existing) existing.parentNode.removeChild(existing);

    var curPurchase = invItem.purchasePrice !== null && invItem.purchasePrice !== undefined
      ? invItem.purchasePrice
      : (invItem.rate !== null && invItem.rate !== undefined ? invItem.rate : "");
    var curSell = invItem.sellingPrice !== null && invItem.sellingPrice !== undefined
      ? invItem.sellingPrice
      : (invItem.sellPrice !== null && invItem.sellPrice !== undefined ? invItem.sellPrice : "");
    var curMarkup = (curPurchase !== "" && curPurchase > 0 && curSell !== "")
      ? round2((curSell - curPurchase) / curPurchase * 100) : "";

    var overlay = document.createElement("div");
    overlay.id = "manual-add-overlay";
    overlay.className = "manual-add-overlay";
    overlay.innerHTML = [
      '<div class="manual-add-modal">',
        '<div class="manual-add-header">',
          '<h3>Edit Medicine</h3>',
          '<button class="manual-add-close" id="manual-add-close" type="button" aria-label="Close">✕</button>',
        '</div>',
        '<div class="manual-add-body">',
          '<p class="manual-add-hint">Changes will be saved to your inventory immediately.</p>',
          '<div class="manual-add-fields">',
            '<div class="manual-add-field manual-add-field--wide">',
              '<label for="manual-name">Medicine Name *</label>',
              '<input type="text" id="manual-name" autocomplete="off" maxlength="200" value="' + (invItem.medicineName || "") + '" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-mrp">MRP (&#8377;) *</label>',
              '<input type="number" id="manual-mrp" min="0" step="0.01" value="' + (invItem.mrp !== null && invItem.mrp !== undefined ? invItem.mrp : "") + '" placeholder="0.00" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-purchase">Purchase Price (&#8377;) *</label>',
              '<input type="number" id="manual-purchase" min="0" step="0.01" value="' + curPurchase + '" placeholder="0.00" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-markup">Markup % <span class="manual-optional">(optional)</span></label>',
              '<input type="number" id="manual-markup" min="-100" step="0.01" value="' + curMarkup + '" placeholder="auto" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-sell">Sell Price (&#8377;) <span class="manual-optional">(optional)</span></label>',
              '<input type="number" id="manual-sell" min="0" step="0.01" value="' + curSell + '" placeholder="auto" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-location">Rack / Location <span class="manual-optional">(optional)</span></label>',
              '<input type="text" id="manual-location" autocomplete="off" maxlength="100" value="' + (invItem.location || "") + '" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-stock-qty">Stock Qty <span class="manual-optional">(optional)</span></label>',
              '<input type="number" id="manual-stock-qty" min="0" step="1" value="' + (invItem.quantity !== null && invItem.quantity !== undefined ? invItem.quantity : "") + '" placeholder="?" />',
            '</div>',
          '</div>',
          '<p class="manual-add-save-status" id="manual-add-save-status"></p>',
        '</div>',
        '<div class="manual-add-footer">',
          '<button class="btn btn-ghost" id="manual-add-cancel" type="button">Cancel</button>',
          '<button class="btn btn-primary" id="manual-add-submit" type="button">Save Changes</button>',
        '</div>',
      '</div>',
    ].join("");

    document.body.appendChild(overlay);

    var nameEl     = document.getElementById("manual-name");
    var locationEl = document.getElementById("manual-location");
    var mrpEl      = document.getElementById("manual-mrp");
    var purchaseEl = document.getElementById("manual-purchase");
    var markupEl   = document.getElementById("manual-markup");
    var sellEl     = document.getElementById("manual-sell");
    var stockQtyEl = document.getElementById("manual-stock-qty");
    var saveStatusEl = document.getElementById("manual-add-save-status");

    function recalcSell() {
      var p = parseFloat(purchaseEl.value), m = parseFloat(markupEl.value);
      if (!isNaN(p) && !isNaN(m)) sellEl.value = round2(p * (1 + m / 100));
    }
    function recalcMarkup() {
      var p = parseFloat(purchaseEl.value), s = parseFloat(sellEl.value);
      if (!isNaN(p) && p > 0 && !isNaN(s)) markupEl.value = round2((s - p) / p * 100);
    }
    purchaseEl.addEventListener("input", recalcSell);
    markupEl.addEventListener("input", recalcSell);
    sellEl.addEventListener("input", recalcMarkup);

    function closeModal() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (bEl.search) bEl.search.focus();
    }

    async function submitEdit() {
      var name = (nameEl.value || "").trim();
      if (!name) { nameEl.focus(); return; }
      var mrpRaw = parseFloat(mrpEl.value);
      if (isNaN(mrpRaw) || mrpRaw < 0) { mrpEl.focus(); return; }
      var purchaseRaw = parseFloat(purchaseEl.value);
      if (isNaN(purchaseRaw) || purchaseRaw < 0) { purchaseEl.focus(); return; }

      var markupRaw = parseFloat(markupEl.value);
      var sellRaw   = parseFloat(sellEl.value);
      if (isNaN(sellRaw) || sellRaw < 0) sellRaw = mrpRaw;
      if (isNaN(markupRaw) && purchaseRaw > 0) markupRaw = round2((sellRaw - purchaseRaw) / purchaseRaw * 100);
      var locationVal = (locationEl.value || "").trim() || "—";
      var stockQtyRaw = parseInt(stockQtyEl.value, 10);

      var submitBtn = document.getElementById("manual-add-submit");
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }
      if (saveStatusEl) { saveStatusEl.textContent = ""; saveStatusEl.className = "manual-add-save-status"; }

      try {
        var result = await requestApi("/api/medicines", {
          method: "POST",
          body: {
            item: {
              id:            invItem.id,
              medicineName:  name,
              location:      locationVal,
              mrp:           mrpRaw,
              purchasePrice: purchaseRaw,
              sellingPrice:  sellRaw,
              quantity:      isNaN(stockQtyRaw) ? null : stockQtyRaw,
            },
          },
        });

        if (result && result.item) {
          var updated = result.item;
          var idx = state.items.findIndex(function (it) { return it.id === invItem.id; });
          if (idx >= 0) state.items[idx] = updated; else state.items.unshift(updated);
          if (typeof saveLocalItems === "function") saveLocalItems(state.items);

          // Refresh any matching line items in the current bill
          bState.lineItems.forEach(function (li) {
            if (li.medicineId === invItem.id) {
              li.medicineName  = updated.medicineName;
              li.location      = updated.location;
              li.mrp           = updated.mrp;
              li.purchasePrice = updated.purchasePrice !== null && updated.purchasePrice !== undefined
                ? updated.purchasePrice : updated.rate;
            }
          });
          renderLineItems();
          recalcTotals();
        }

        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (bEl.search) bEl.search.focus();

      } catch (err) {
        if (saveStatusEl) {
          saveStatusEl.textContent = "⚠ Save failed: " + (err.message || "unknown");
          saveStatusEl.className = "manual-add-save-status is-warn";
        }
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save Changes"; }
      }
    }

    document.getElementById("manual-add-close").addEventListener("click", closeModal);
    document.getElementById("manual-add-cancel").addEventListener("click", closeModal);
    document.getElementById("manual-add-submit").addEventListener("click", submitEdit);
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeModal(); });
    overlay.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

    setTimeout(function () { if (mrpEl) { mrpEl.focus(); mrpEl.select(); } }, 50);
  }

  // -------------------------------------------------------------------------
  // Line Item Management
  // -------------------------------------------------------------------------
  function addLineItem(medicine) {
    var purchase =
      medicine.purchasePrice !== null && medicine.purchasePrice !== undefined ? medicine.purchasePrice
      : (medicine.rate !== null && medicine.rate !== undefined ? medicine.rate : null);
    var sell =
      medicine.sellingPrice !== null && medicine.sellingPrice !== undefined ? medicine.sellingPrice
      : (medicine.sellPrice !== null && medicine.sellPrice !== undefined ? medicine.sellPrice
      : (medicine.mrp !== null && medicine.mrp !== undefined ? medicine.mrp : 0));

    // Override with last price for this customer if available
    var medicineLower = (medicine.medicineName || "").toLowerCase().trim();
    var lastPriceInfo = bState.customerLastPrices[medicineLower];
    var markupPct = null;
    if (lastPriceInfo) {
      sell = lastPriceInfo.sellPrice;
      markupPct = lastPriceInfo.markupPercent;
    }

    var rowId = "row-" + (bState.nextRowId++);

    bState.lineItems.push({
      _rowId: rowId,
      medicineId:    medicine.id,
      medicineName:  medicine.medicineName,
      location:      medicine.location || "",
      mrp:           medicine.mrp !== null && medicine.mrp !== undefined ? Number(medicine.mrp) : null,
      purchasePrice: purchase !== null ? Number(purchase) : null,
      sellPrice:     Number(sell) || 0,
      markupPercent: markupPct,
      quantity:      1,
    });

    var newRowId = rowId;

    renderLineItems();
    recalcTotals();

    if (bEl.search) bEl.search.value = "";

    setTimeout(function () {
      var markupInput = document.getElementById("markup-" + newRowId);
      var sellInput   = document.getElementById("sell-"   + newRowId);
      if (markupInput && !markupInput.disabled) {
        markupInput.focus();
        markupInput.select();
      } else if (sellInput) {
        sellInput.focus();
        sellInput.select();
      }
    }, 0);
  }

  function removeLineItem(rowId) {
    bState.lineItems = bState.lineItems.filter(function (r) {
      return r._rowId !== rowId;
    });
    renderLineItems();
    recalcTotals();
  }

  function updateLineItemField(rowId, field, rawValue) {
    var item = bState.lineItems.find(function (r) { return r._rowId === rowId; });
    if (!item) return;

    if (field === "mrp") {
      var mrp = parseFloat(rawValue);
      item.mrp = isNaN(mrp) ? null : mrp;
      return; // MRP doesn't affect totals

    } else if (field === "quantity") {
      item.quantity = Math.max(0.001, parseFloat(rawValue) || 0.001);

    } else if (field === "sellPrice") {
      var sp = parseFloat(rawValue);
      item.sellPrice = isNaN(sp) ? 0 : sp;
      // Back-calculate markup %
      if (item.purchasePrice !== null && item.purchasePrice > 0) {
        item.markupPercent = round2((item.sellPrice - item.purchasePrice) / item.purchasePrice * 100);
        var markupInput = document.getElementById("markup-" + rowId);
        if (markupInput) markupInput.value = item.markupPercent;
      }

    } else if (field === "markupPercent") {
      var mp = parseFloat(rawValue);
      if (!isNaN(mp) && item.purchasePrice !== null && item.purchasePrice >= 0) {
        item.markupPercent = mp;
        item.sellPrice = round2(item.purchasePrice * (1 + mp / 100));
        var sellInput = document.getElementById("sell-" + rowId);
        if (sellInput) sellInput.value = item.sellPrice;
      } else {
        item.markupPercent = isNaN(mp) ? null : mp;
      }
    }

    // Update line total cell
    var totalEl = document.getElementById("total-" + rowId);
    if (totalEl) {
      totalEl.textContent = fmtMoney(round2(item.sellPrice * item.quantity));
    }

    recalcTotals();
  }

  function renderLineItems() {
    if (!bEl.itemsTbody) return;

    var hasItems = bState.lineItems.length > 0;
    if (bEl.itemsEmpty) bEl.itemsEmpty.classList.toggle("hidden", hasItems);
    if (bEl.itemsTableWrap) bEl.itemsTableWrap.classList.toggle("hidden", !hasItems);

    bEl.itemsTbody.textContent = "";

    var frag = document.createDocumentFragment();

    bState.lineItems.forEach(function (item) {
      var tr = document.createElement("tr");
      var hasPurchase = item.purchasePrice !== null && item.purchasePrice !== undefined;
      var lineTotal = round2(item.sellPrice * item.quantity);

      var markupVal = item.markupPercent !== null && item.markupPercent !== undefined
        ? item.markupPercent : "";
      var sellVal = item.sellPrice !== null && item.sellPrice !== undefined
        ? item.sellPrice : "";
      var mrpVal = item.mrp !== null && item.mrp !== undefined ? item.mrp : "";
      var purchaseDisplay = hasPurchase ? fmtMoney(item.purchasePrice) : "—";

      tr.innerHTML =
        "<td>" +
          '<div class="bill-item-name" title="' + item.medicineName + '">' + item.medicineName + "</div>" +
          '<div class="bill-item-location">' + (item.location || "—") + "</div>" +
        "</td>" +
        '<td class="num-col">' +
          '<input id="mrp-' + item._rowId + '" class="bill-table-input" type="number"' +
          ' data-col="mrp"' +
          ' min="0" step="0.01"' +
          ' value="' + mrpVal + '"' +
          ' placeholder="—"' +
          " />" +
        "</td>" +
        '<td class="num-col bill-purchase-col"><span style="font-family:var(--font-mono);font-size:0.85rem;color:#3a5560;">' + purchaseDisplay + "</span></td>" +
        '<td class="num-col">' +
          '<input id="markup-' + item._rowId + '" class="bill-table-input" type="number"' +
          ' data-col="markup"' +
          ' min="-100" max="2000" step="0.01"' +
          ' value="' + markupVal + '"' +
          ' placeholder="' + (hasPurchase ? "0" : "N/A") + '"' +
          (hasPurchase ? "" : ' disabled title="Set purchase price in inventory first"') +
          " />" +
        "</td>" +
        '<td class="num-col">' +
          '<input id="sell-' + item._rowId + '" class="bill-table-input bill-table-input--sell" type="number"' +
          ' data-col="sell"' +
          ' min="0" step="0.01"' +
          ' value="' + sellVal + '"' +
          ' placeholder="0"' +
          " />" +
        "</td>" +
        '<td class="num-col">' +
          '<input id="qty-' + item._rowId + '" class="bill-table-input" type="number"' +
          ' data-col="qty"' +
          ' min="0.001" step="0.001"' +
          ' value="' + item.quantity + '"' +
          ' placeholder="1"' +
          " />" +
        "</td>" +
        '<td class="num-col"><span id="total-' + item._rowId + '" class="bill-item-line-total">' + fmtMoney(lineTotal) + "</span></td>" +
        "<td>" +
          '<div class="bill-row-actions">' +
          (item.medicineId
            ? '<button class="btn btn-ghost btn-xs bill-edit-inv-btn" data-edit-inv="' + item._rowId + '" title="Edit medicine in inventory" type="button">✏</button>'
            : '') +
          '<button class="btn btn-danger btn-xs bill-remove-btn" data-remove="' + item._rowId + '" title="Remove this line" type="button">✕</button>' +
          '</div>' +
        "</td>";

      frag.appendChild(tr);
    });

    bEl.itemsTbody.appendChild(frag);

    // Bind row events after render
    bEl.itemsTbody.querySelectorAll("[data-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        removeLineItem(btn.dataset.remove);
      });
    });

    bEl.itemsTbody.querySelectorAll("[data-edit-inv]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var rowId = btn.dataset.editInv;
        var li = bState.lineItems.find(function (x) { return x._rowId === rowId; });
        if (!li || !li.medicineId) return;
        var invItem = (state.items || []).find(function (x) { return x.id === li.medicineId; });
        if (invItem) showMedicineEditModal(invItem);
      });
    });

    bState.lineItems.forEach(function (item) {
      var mrpInput    = document.getElementById("mrp-"    + item._rowId);
      var qtyInput    = document.getElementById("qty-"    + item._rowId);
      var sellInput   = document.getElementById("sell-"   + item._rowId);
      var markupInput = document.getElementById("markup-" + item._rowId);

      function bindInput(el, field, onEnter) {
        if (!el) return;
        el.addEventListener("input",  function () { updateLineItemField(item._rowId, field, el.value); });
        el.addEventListener("change", function () { updateLineItemField(item._rowId, field, el.value); });
        el.addEventListener("keydown", function (e) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            navigateTableInput(el, e.key === "ArrowDown" ? "down" : "up");
          } else if (e.key === "Enter" && onEnter) {
            e.preventDefault();
            onEnter();
          }
        });
      }

      bindInput(mrpInput, "mrp", function () {
        if (markupInput && !markupInput.disabled) { markupInput.focus(); markupInput.select(); }
        else if (sellInput) { sellInput.focus(); sellInput.select(); }
      });
      bindInput(markupInput, "markupPercent", function () {
        var sell = document.getElementById("sell-" + item._rowId);
        if (sell) { sell.focus(); sell.select(); }
      });
      bindInput(sellInput, "sellPrice", function () {
        var qty = document.getElementById("qty-" + item._rowId);
        if (qty) { qty.focus(); qty.select(); }
      });
      bindInput(qtyInput, "quantity", function () {
        if (bEl.search) bEl.search.focus();
      });
    });
  }

  function navigateTableInput(input, direction) {
    var col = input.dataset.col;
    if (!col || !bEl.itemsTbody) return;
    var siblings = Array.prototype.slice.call(
      bEl.itemsTbody.querySelectorAll("input[data-col='" + col + "']:not([disabled])")
    );
    var idx = siblings.indexOf(input);
    if (idx === -1) return;
    var next = siblings[direction === "down" ? idx + 1 : idx - 1];
    if (next) { next.focus(); next.select(); }
  }

  function recalcTotals() {
    var subtotalVal = bState.lineItems.reduce(function (sum, item) {
      return sum + round2(item.sellPrice * item.quantity);
    }, 0);
    subtotalVal = round2(subtotalVal);

    var gstPct = parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0;
    var gstAmt = round2(subtotalVal * gstPct / 100);
    var preRoundTotal = round2(subtotalVal + gstAmt);

    var grandTotalVal = Math.ceil(preRoundTotal);
    var roundOffAmt   = round2(grandTotalVal - preRoundTotal);

    if (bEl.subtotal)   bEl.subtotal.textContent   = fmtMoney(subtotalVal);
    if (bEl.gstAmount)  bEl.gstAmount.textContent  = fmtMoney(gstAmt);
    if (bEl.gstLabel)   bEl.gstLabel.textContent   = "GST (" + gstPct + "%)";
    if (bEl.grandTotal) bEl.grandTotal.textContent = fmtMoney(grandTotalVal);
    if (bEl.itemsCount) bEl.itemsCount.textContent = String(bState.lineItems.length);

    if (bEl.roundOffRow)    bEl.roundOffRow.classList.toggle("hidden", roundOffAmt === 0);
    if (bEl.roundOffAmount) {
      bEl.roundOffAmount.textContent = "+" + fmtMoney(roundOffAmt);
      bEl.roundOffAmount.className   = "summary-amount summary-amount--muted";
    }

    recalcPayment();
  }

  function recalcPayment() {
    var subtotalVal = bState.lineItems.reduce(function (sum, item) {
      return sum + round2(item.sellPrice * item.quantity);
    }, 0);
    var gstPct      = parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0;
    var preRound   = round2(round2(subtotalVal) + round2(round2(subtotalVal) * gstPct / 100));
    var grandTotal = Math.ceil(preRound);
    var prevBal     = bState.currentCustomerBalance || 0;
    var totalDueVal = round2(grandTotal + prevBal);
    var received    = parseFloat(bEl.receivedAmount ? bEl.receivedAmount.value : "0") || 0;
    var balDue      = round2(totalDueVal - received);

    // Previous balance row — dim it when zero
    var prevRow = document.querySelector(".bill-prev-balance-row");
    if (prevRow) prevRow.style.opacity = prevBal > 0 ? "1" : "0.38";
    if (bEl.prevBalance) bEl.prevBalance.textContent = fmtMoney(prevBal);

    if (bEl.totalDue)  bEl.totalDue.textContent  = fmtMoney(totalDueVal);
    if (bEl.balanceDue) {
      bEl.balanceDue.textContent = fmtMoney(balDue);
      bEl.balanceDue.className   = "bill-balance-due-value" +
        (balDue > 0.005 ? " bill-balance-due-value--debt" : (balDue < -0.005 ? " bill-balance-due-value--credit" : ""));
    }
  }

  // -------------------------------------------------------------------------
  // Save Bill
  // -------------------------------------------------------------------------
  function buildSavePayload() {
    var gstPct = parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0;
    return {
      customerName:  normalizeString(bEl.customerName  ? bEl.customerName.value  : ""),
      customerPhone: normalizeString(bEl.customerPhone ? bEl.customerPhone.value : ""),
      notes:         normalizeString(bEl.notes         ? bEl.notes.value         : ""),
      gstPercent:    gstPct,
      items: bState.lineItems.map(function (item) {
        return {
          medicineId:    item.medicineId,
          medicineName:  item.medicineName,
          location:      item.location,
          mrp:           item.mrp,
          purchasePrice: item.purchasePrice,
          sellPrice:     item.sellPrice,
          markupPercent: item.markupPercent,
          quantity:      item.quantity,
        };
      }),
    };
  }

  async function saveBill() {
    if (!bState.lineItems.length) {
      setSaveStatus("Add at least one medicine to the bill.", "is-warn");
      return;
    }

    if (bEl.saveBillButton) bEl.saveBillButton.disabled = true;
    setSaveStatus("Saving bill…", "is-info");

    var payload = buildSavePayload();

    try {
      if (bState.currentBillId) {
        // Update existing bill
        payload.id = bState.currentBillId;
        await requestApi("/api/bills", { method: "PUT", body: payload });
        setSaveStatus("✅ Bill " + bState.currentBillNumber + " updated successfully.", "is-ok");

        // Adjust customer balance for changes in bill total, received, or opening balance
        var _editCustName = normalizeString(bEl.customerName ? bEl.customerName.value : "");
        if (_editCustName && bState.editOriginalGrandTotal !== null) {
          var _newRecv    = parseFloat(bEl.receivedAmount ? bEl.receivedAmount.value : "0") || 0;
          var _newPrevBal = parseFloat(bEl.openingBalance ? bEl.openingBalance.value : "0") || 0;
          var _sub2  = bState.lineItems.reduce(function (s, it) { return s + round2(it.sellPrice * it.quantity); }, 0);
          var _gst2  = parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0;
          var _newGT = Math.ceil(round2(round2(_sub2) + round2(round2(_sub2) * _gst2 / 100)));

          // Delta from bill amount / received changes
          var _billAdj = round2((_newGT - _newRecv) - (bState.editOriginalGrandTotal - bState.editOriginalReceived));
          // Delta from opening balance correction (e.g. user fixing a wrong prev balance)
          var _prevAdj = round2(_newPrevBal - (bState.editOriginalPrevBalance || 0));
          var _totalAdj = round2(_billAdj + _prevAdj);

          if (_totalAdj !== 0) {
            var _cl  = loadSavedCustomers();
            var _cidx = bState.currentCustomerIdx;
            if (_cidx === null) {
              _cidx = _cl.findIndex(function (c) { return c.name.toLowerCase() === _editCustName.toLowerCase(); });
            }
            if (_cidx >= 0) {
              _cl[_cidx].balance = round2((parseFloat(_cl[_cidx].balance) || 0) + _totalAdj);
              persistSavedCustomers(_cl);
              bState.currentCustomerBalance = _cl[_cidx].balance;
              renderCustomerSelect();
              recalcPayment();
            }
          }

          // Persist snapshots for this bill (opening balance stays as what user typed)
          var _bid = bState.currentBillId;
          try { localStorage.setItem("am.billPrev." + _bid, String(_newPrevBal)); } catch (_e) {}
          try { localStorage.setItem("am.billRecv." + _bid, String(_newRecv)); } catch (_e) {}
          // Update originals so a second re-save doesn't double-adjust
          bState.editOriginalGrandTotal  = _newGT;
          bState.editOriginalReceived    = _newRecv;
          bState.editOriginalPrevBalance = _newPrevBal;
        }
      } else {
        // Create new bill
        var result = await requestApi("/api/bills", { method: "POST", body: payload });
        bState.currentBillId     = result.bill.id;
        bState.currentBillNumber = result.billNumber;

        if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = result.billNumber;
        setSaveStatus("✅ Bill " + result.billNumber + " saved successfully!", "is-ok");
      }

      if (bEl.printBillButton) bEl.printBillButton.disabled = false;

      // Carry forward balance — only on first save of each bill (not on edits/re-saves)
      if (!bState.balanceCarriedForward) {
        var custName  = normalizeString(bEl.customerName  ? bEl.customerName.value  : "");
        var custPhone = normalizeString(bEl.customerPhone ? bEl.customerPhone.value : "");
        var received  = parseFloat(bEl.receivedAmount ? bEl.receivedAmount.value : "0") || 0;
        var _sub      = bState.lineItems.reduce(function (s, it) { return s + round2(it.sellPrice * it.quantity); }, 0);
        var _gst      = parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0;
        var grandTot  = Math.ceil(round2(round2(_sub) + round2(round2(_sub) * _gst / 100)));

        if (custName) {
          var custList = loadSavedCustomers();

          // Resolve customer index: prefer current state, fallback to name/phone lookup
          var idx = bState.currentCustomerIdx;
          if (idx === null) {
            idx = custList.findIndex(function (c) {
              return c.name.toLowerCase() === custName.toLowerCase() ||
                (custPhone && c.phone && c.phone === custPhone);
            });
          }

          // Existing customer → use the stored balance (authoritative running ledger).
          // New customer (not yet in localStorage) → fall back to the Opening Balance
          // field, which is the ONLY place the user's manually-entered opening amount lives.
          // This was the root bug: idx < 0 was always returning 0, silently discarding
          // whatever the user typed in the Opening Balance input.
          var prevBal = (idx >= 0 && custList[idx])
            ? (parseFloat(custList[idx].balance) || 0)
            : (parseFloat(bEl.openingBalance ? bEl.openingBalance.value : "0") || 0);

          // Snapshot prevBal + received for this bill so history view can reconstruct
          // the exact receipt instead of using stale current-form state.
          var _sid = bState.currentBillId;
          if (_sid) {
            try { localStorage.setItem("am.billPrev." + _sid, String(prevBal)); } catch (_e) {}
            try { localStorage.setItem("am.billRecv." + _sid, String(received)); } catch (_e) {}
          }

          var newBalance = round2(grandTot + prevBal - received);

          if (idx < 0) {
            // New customer — create entry
            custList.push({ name: custName, phone: custPhone || "", balance: newBalance });
            idx = custList.length - 1;
          } else {
            custList[idx].balance = newBalance;
          }

          persistSavedCustomers(custList);
          bState.currentCustomerIdx     = idx;
          bState.currentCustomerBalance = newBalance;
          bState.balanceCarriedForward  = true;
          if (bEl.openingBalance) bEl.openingBalance.value = newBalance > 0 ? newBalance : "";
          renderCustomerSelect();
          recalcPayment();
        }
      }

      await loadBillHistory();

    } catch (error) {
      setSaveStatus("Save failed: " + (error.message || "Unknown error"), "is-error");
    } finally {
      if (bEl.saveBillButton) bEl.saveBillButton.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Print Bill
  // -------------------------------------------------------------------------

  function numToWords(n) {
    var ones = ["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine",
      "Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
    var tens = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
    if (n === 0) return "Zero";
    function two(n) {
      return n < 20 ? ones[n] : tens[Math.floor(n/10)] + (n%10 ? " " + ones[n%10] : "");
    }
    function three(n) {
      return n >= 100 ? ones[Math.floor(n/100)] + " Hundred" + (n%100 ? " " + two(n%100) : "") : two(n);
    }
    var out = "";
    var cr = Math.floor(n/10000000); n %= 10000000;
    var lk = Math.floor(n/100000);   n %= 100000;
    var th = Math.floor(n/1000);     n %= 1000;
    if (cr) out += three(cr) + " Crore ";
    if (lk) out += three(lk) + " Lakh ";
    if (th) out += three(th) + " Thousand ";
    if (n)  out += three(n);
    return out.trim();
  }

  function buildReceiptHtml(overrides) {
    var customer  = (overrides && overrides.customerName)  || normalizeString(bEl.customerName  ? bEl.customerName.value  : "");
    var phone     = (overrides && overrides.customerPhone) || normalizeString(bEl.customerPhone ? bEl.customerPhone.value : "");
    var notes     = (overrides && overrides.notes)         || normalizeString(bEl.notes         ? bEl.notes.value         : "");
    var gstPct    = (overrides && overrides.gstPercent !== undefined) ? overrides.gstPercent : (parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0);
    var items     = (overrides && overrides.items) || bState.lineItems;
    var billNo    = (overrides && overrides.billNumber) || bState.currentBillNumber || "DRAFT";
    var prevBal   = (overrides && overrides.prevBalance  !== undefined) ? overrides.prevBalance  : (bState.currentCustomerBalance || 0);
    var received  = (overrides && overrides.received     !== undefined) ? overrides.received     : (parseFloat(bEl.receivedAmount ? bEl.receivedAmount.value : "0") || 0);
    var now      = new Date();
    var dateStr  = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    var timeStr  = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

    var subtotal   = round2(items.reduce(function (s, it) {
      return s + round2((it.sell_price !== undefined ? it.sell_price : it.sellPrice) * it.quantity);
    }, 0));
    var gstAmt     = round2(subtotal * gstPct / 100);
    var grandTotal = Math.ceil(round2(subtotal + gstAmt));

    var totalDue    = round2(grandTotal + prevBal);
    var balanceDue  = round2(totalDue - received);

    var intPart  = Math.floor(totalDue);
    var decPart  = Math.round((totalDue - intPart) * 100);
    var amtWords = "Rupees " + numToWords(intPart) + (decPart ? " and " + numToWords(decPart) + " Paise" : "") + " Only";

    var rowsHtml = items.map(function (it, idx) {
      var name  = it.medicine_name || it.medicineName || "—";
      var mrp   = (it.mrp !== null && it.mrp !== undefined) ? "&#8377;" + Number(it.mrp).toFixed(2) : "—";
      var qty   = it.quantity;
      var price = it.sell_price !== undefined ? it.sell_price : it.sellPrice;
      var total = round2(price * qty);
      var bg    = idx % 2 === 0 ? "#ffffff" : "#f5faf9";
      return (
        "<tr style='background:" + bg + ";'>" +
          "<td style='padding:6px 8px;border:1px solid #d4e8e5;text-align:center;color:#7a9a96;font-size:11px;font-family:monospace;'>" + (idx + 1) + "</td>" +
          "<td style='padding:6px 10px;border:1px solid #d4e8e5;font-size:12.5px;font-weight:600;color:#0d2a28;'>" + name + "</td>" +
          "<td style='padding:6px 8px;border:1px solid #d4e8e5;text-align:right;font-size:11px;color:#7a9a96;font-family:monospace;'>" + mrp + "</td>" +
          "<td style='padding:6px 8px;border:1px solid #d4e8e5;text-align:center;font-size:13px;font-weight:700;color:#0d2a28;'>" + qty + "</td>" +
          "<td style='padding:6px 8px;border:1px solid #d4e8e5;text-align:right;font-size:12px;font-family:monospace;color:#2c5f5b;'>&#8377;" + Number(price).toFixed(2) + "</td>" +
          "<td style='padding:6px 8px;border:1px solid #d4e8e5;text-align:right;font-size:12.5px;font-weight:700;font-family:monospace;color:#085f59;'>&#8377;" + Number(total).toFixed(2) + "</td>" +
        "</tr>"
      );
    }).join("");

    return (
      "<div style='font-family:Arial,\"Helvetica Neue\",sans-serif;max-width:740px;margin:0 auto;color:#0d2a28;'>" +

        /* ── Teal header ── */
        "<div style='background:linear-gradient(135deg,#0b6d67 0%,#0d5c80 100%);padding:16px 22px;border-radius:6px 6px 0 0;'>" +
          "<div style='display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;'>" +
            "<div>" +
              "<div style='font-size:23px;font-weight:900;letter-spacing:2.5px;text-transform:uppercase;color:#ffffff;'>Adarsh Medicals</div>" +
              "<div style='font-size:11px;margin-top:3px;color:rgba(255,255,255,0.75);'>Khasra No. 157, Thekma, Near Bus Stop, Martinganj, Azamgarh, U.P. – 276303</div>" +
              "<div style='font-size:11px;color:rgba(255,255,255,0.75);'>Mob: 8470900910</div>" +
            "</div>" +
            "<div style='text-align:right;'>" +
              "<div style='font-size:9.5px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:rgba(255,255,255,0.55);'>TAX INVOICE</div>" +
              "<div style='font-size:15px;font-weight:800;font-family:monospace;color:#8febe4;margin-top:2px;letter-spacing:0.5px;'>" + billNo + "</div>" +
              "<div style='font-size:11px;color:rgba(255,255,255,0.68);margin-top:3px;'>" + dateStr + " &nbsp;·  " + timeStr + "</div>" +
            "</div>" +
          "</div>" +
          "<div style='margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.2);font-size:10px;color:rgba(255,255,255,0.6);letter-spacing:0.3px;'>" +
            "Drug Lic. (Form 20): <strong style='color:rgba(255,255,255,0.88);'>RLF20UP2025023538</strong>" +
            "&nbsp;&nbsp;|&nbsp;&nbsp;" +
            "Drug Lic. (Form 21): <strong style='color:rgba(255,255,255,0.88);'>RLF21UP2025023481</strong>" +
          "</div>" +
        "</div>" +

        /* ── Bill To band ── */
        "<div style='border:1px solid #c4e2de;border-top:none;padding:10px 18px;background:#f0faf8;'>" +
          "<div style='font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#5a9490;margin-bottom:4px;'>Bill To</div>" +
          (customer
            ? "<div style='font-size:14px;font-weight:700;color:#0d2a28;'>" + customer + "</div>"
            : "<div style='font-size:13px;color:#7a9a96;font-style:italic;'>—</div>") +
          (phone ? "<div style='font-size:11.5px;color:#3d6560;margin-top:2px;'>Mob: " + phone + "</div>" : "") +
        "</div>" +

        /* ── Items table ── */
        "<table style='width:100%;border-collapse:collapse;font-size:12px;margin:0;'>" +
          "<thead>" +
            "<tr style='background:#e4f4f1;'>" +
              "<th style='padding:8px;border:1px solid #c4e2de;text-align:center;width:28px;font-size:10px;color:#3d6560;'>#</th>" +
              "<th style='padding:8px 10px;border:1px solid #c4e2de;text-align:left;color:#0d2a28;'>Medicine Name</th>" +
              "<th style='padding:8px;border:1px solid #c4e2de;text-align:right;width:68px;color:#3d6560;'>MRP</th>" +
              "<th style='padding:8px;border:1px solid #c4e2de;text-align:center;width:40px;color:#0d2a28;'>Qty</th>" +
              "<th style='padding:8px;border:1px solid #c4e2de;text-align:right;width:72px;color:#0d2a28;'>Rate</th>" +
              "<th style='padding:8px;border:1px solid #c4e2de;text-align:right;width:86px;color:#085f59;'>Amount</th>" +
            "</tr>" +
          "</thead>" +
          "<tbody>" + rowsHtml + "</tbody>" +
        "</table>" +

        /* ── Totals ── */
        "<div style='display:flex;justify-content:flex-end;border:1px solid #c4e2de;border-top:none;'>" +
          "<div style='min-width:280px;font-size:12.5px;'>" +
            "<div style='display:flex;justify-content:space-between;padding:5px 12px;border-bottom:1px solid #dff0ed;color:#3d6560;'>" +
              "<span>Subtotal</span><span style='font-family:monospace;'>&#8377;" + subtotal.toFixed(2) + "</span>" +
            "</div>" +
            (gstPct > 0
              ? "<div style='display:flex;justify-content:space-between;padding:5px 12px;border-bottom:1px solid #dff0ed;color:#3d6560;'>" +
                  "<span>GST (" + gstPct + "%)</span><span style='font-family:monospace;'>&#8377;" + gstAmt.toFixed(2) + "</span>" +
                "</div>"
              : "") +
            "<div style='display:flex;justify-content:space-between;padding:6px 12px;border-bottom:1px solid #dff0ed;font-size:13.5px;font-weight:700;color:#0d2a28;'>" +
              "<span>Bill Amount</span><span style='font-family:monospace;'>&#8377;" + grandTotal.toFixed(2) + "</span>" +
            "</div>" +
            (prevBal > 0
              ? "<div style='display:flex;justify-content:space-between;padding:5px 12px;border-bottom:1px solid #dff0ed;color:#8a5500;background:#fffbf2;'>" +
                  "<span>Previous Balance</span><span style='font-family:monospace;'>&#8377;" + prevBal.toFixed(2) + "</span>" +
                "</div>" +
                "<div style='display:flex;justify-content:space-between;padding:5px 12px;border-bottom:1px solid #dff0ed;color:#3d6560;font-weight:700;'>" +
                  "<span>Total Due</span><span style='font-family:monospace;'>&#8377;" + totalDue.toFixed(2) + "</span>" +
                "</div>"
              : "") +
            "<div style='display:flex;justify-content:space-between;padding:5px 12px;border-bottom:1px solid #dff0ed;color:#1a6644;'>" +
              "<span>Amount Received</span><span style='font-family:monospace;'>&#8377;" + received.toFixed(2) + "</span>" +
            "</div>" +
            "<div style='display:flex;justify-content:space-between;padding:8px 12px;font-size:14px;font-weight:800;background:linear-gradient(135deg,#0b6d67,#0d5c80);color:#fff;letter-spacing:0.5px;'>" +
              "<span>" + (balanceDue > 0.005 ? "BALANCE DUE" : (balanceDue < -0.005 ? "EXCESS PAID" : "CLEARED")) + "</span>" +
              "<span style='font-family:monospace;'>&#8377;" + Math.abs(balanceDue).toFixed(2) + "</span>" +
            "</div>" +
          "</div>" +
        "</div>" +

        /* ── Amount in words ── */
        "<div style='margin-top:8px;font-size:11.5px;border:1px solid #c4e2de;padding:6px 12px;border-radius:4px;background:#f0faf8;color:#2a5550;'>" +
          "<strong>Amount in Words:</strong> " + amtWords +
        "</div>" +

        /* ── Notes ── */
        (notes
          ? "<div style='margin-top:5px;font-size:11px;border:1px dashed #a8d4cf;padding:5px 10px;border-radius:4px;color:#3d6560;background:#f8fcfb;'>" +
              "<strong>Note:</strong> " + notes +
            "</div>"
          : "") +

        /* ── Footer: terms + signatory ── */
        "<div style='display:flex;justify-content:space-between;align-items:flex-end;margin-top:20px;padding-top:12px;border-top:1.5px solid #c4e2de;font-size:11px;color:#5a8884;gap:16px;'>" +
          "<div style='line-height:1.9;'>" +
            "<div>• Goods once sold will not be returned or exchanged.</div>" +
            "<div>• Please verify expiry date and quantity before accepting.</div>" +
            "<div>• All disputes subject to Azamgarh jurisdiction only.</div>" +
          "</div>" +
          "<div style='text-align:center;min-width:140px;flex-shrink:0;'>" +
            "<div style='height:34px;'></div>" +
            "<div style='border-top:1.5px solid #0b6d67;padding-top:4px;font-size:11px;color:#0b6d67;font-weight:700;letter-spacing:0.5px;'>Authorised Signatory</div>" +
            "<div style='font-size:10px;color:#5a8884;margin-top:1px;'>Adarsh Medicals</div>" +
          "</div>" +
        "</div>" +

        /* ── Computer-generated tag ── */
        "<div style='text-align:center;margin-top:10px;padding-top:7px;border-top:1px dashed #c4e2de;font-size:10px;color:#9abfbb;letter-spacing:0.3px;'>This is a computer generated tax invoice.</div>" +

      "</div>"
    );
  }

  function printBill() {
    if (!bEl.printArea) return;
    bEl.printArea.innerHTML = buildReceiptHtml(null);
    window.print();
  }

  // -------------------------------------------------------------------------
  // New Bill
  // -------------------------------------------------------------------------
  function newBill() {
    if (bState.lineItems.length) {
      if (!window.confirm("Start a new bill? Current bill will be discarded if not saved.")) {
        return;
      }
    }

    bState.lineItems         = [];
    bState.currentBillId     = null;
    bState.currentBillNumber = null;

    if (bEl.customerName)   bEl.customerName.value   = "";
    if (bEl.customerPhone)  bEl.customerPhone.value  = "";
    if (bEl.notes)          bEl.notes.value          = "";
    if (bEl.gstPercent)     bEl.gstPercent.value     = "0";
    if (bEl.roundOffToggle) bEl.roundOffToggle.checked = false;
    if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = "New Bill";
    if (bEl.printBillButton)   bEl.printBillButton.disabled = true;
    if (bEl.savedCustomerSelect) bEl.savedCustomerSelect.value = "";
    if (bEl.openingBalance)      bEl.openingBalance.value      = "";
    if (bEl.receivedAmount)      bEl.receivedAmount.value      = "0";
    bState.currentCustomerIdx     = null;
    bState.currentCustomerBalance = 0;
    bState.editOriginalGrandTotal  = null;
    bState.editOriginalReceived    = null;
    bState.editOriginalPrevBalance = null;
    bState.balanceCarriedForward   = false;
    bState.customerLastPrices      = {};
    bState.customerLastPricesFor   = null;

    setSaveStatus("", "");
    setSaveCustomerStatus("", "");
    renderLineItems();
    recalcTotals();
    if (bEl.search) bEl.search.focus();
  }

  // -------------------------------------------------------------------------
  // Import Bills
  // -------------------------------------------------------------------------
  var CSV_HEADERS = ["date","bill_number","customer_name","customer_phone","notes","gst_percent","medicine_name","location","quantity","mrp","purchase_price","sell_price"];
  var CSV_TEMPLATE = CSV_HEADERS.join(",") + "\r\n" +
    "2026-06-01,AM-20260601-001,Dr. Yaswant,9616095373,,0,Calpol 500 Tab,A1,3,14.26,8.00,10.55\r\n" +
    "2026-06-01,AM-20260601-001,Dr. Yaswant,9616095373,,0,Cefitaxe O Tab,A2,2,140.60,50.00,63.00\r\n" +
    "2026-06-01,,Dr. Sanjay,,,,Amul 500g New,,1,263.00,200.00,247.00\r\n";

  var importParsedRows = [];

  function parseCSVLine(line) {
    var result = [], cur = "", inQ = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === "," && !inQ) { result.push(cur); cur = ""; }
      else { cur += c; }
    }
    result.push(cur);
    return result;
  }

  function parseCSV(text) {
    var lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
    if (lines.length < 2) return [];
    var headers = parseCSVLine(lines[0]).map(function (h) { return h.trim().replace(/^"|"$/g, "").toLowerCase(); });
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var cols = parseCSVLine(line);
      var row = {};
      headers.forEach(function (h, idx) { row[h] = (cols[idx] || "").trim().replace(/^"|"$/g, ""); });
      rows.push(row);
    }
    return rows;
  }

  function showImportModal() {
    var overlay = document.getElementById("import-modal-overlay");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    importParsedRows = [];
    var fileInput = document.getElementById("import-file-input");
    if (fileInput) fileInput.value = "";
    var preview = document.getElementById("import-preview");
    if (preview) preview.classList.add("hidden");
    var result = document.getElementById("import-result");
    if (result) { result.classList.add("hidden"); result.textContent = ""; }
    var submitBtn = document.getElementById("import-submit-btn");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Import Bills"; }
    var pdfNote = document.getElementById("import-pdf-note");
    if (pdfNote) pdfNote.classList.add("hidden");
  }

  function closeImportModal() {
    var overlay = document.getElementById("import-modal-overlay");
    if (overlay) overlay.classList.add("hidden");
  }

  // ── PDF support ──────────────────────────────────────────────────────────

  var PDFJS_VERSION = "3.11.174";

  function loadPdfJs() {
    return new Promise(function (resolve, reject) {
      if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
      var s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VERSION + "/pdf.min.js";
      s.crossOrigin = "anonymous";
      s.onload = function () {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VERSION + "/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      s.onerror = function () { reject(new Error("Could not load PDF.js")); };
      document.head.appendChild(s);
    });
  }

  async function extractPdfLines(file) {
    var lib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    var pdf = await lib.getDocument({ data: buf }).promise;
    var allLines = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p);
      var content = await page.getTextContent();
      // Group text items into visual rows by Y coordinate (PDF Y is bottom-up)
      var rowMap = [];
      content.items.forEach(function (item) {
        if (!item.str || !item.str.trim()) return;
        var y = item.transform[5];
        var x = item.transform[4];
        var matched = false;
        for (var i = 0; i < rowMap.length; i++) {
          if (Math.abs(rowMap[i].y - y) < 4) {
            rowMap[i].items.push({ x: x, str: item.str });
            matched = true; break;
          }
        }
        if (!matched) rowMap.push({ y: y, items: [{ x: x, str: item.str }] });
      });
      // Sort rows top-to-bottom, items left-to-right
      rowMap.sort(function (a, b) { return b.y - a.y; });
      rowMap.forEach(function (row) {
        row.items.sort(function (a, b) { return a.x - b.x; });
        allLines.push(row.items.map(function (i) { return i.str; }).join("  "));
      });
    }
    return allLines;
  }

  var PDF_SKIP_RE = /^\s*(?:total|grand\s*total|sub\s*total|invoice|bill\s*no|receipt|date|address|gstin|gst[\s#]|phone|mob|customer|qty|quantity|mrp|rate|disc(?:ount)?|tax|sgst|cgst|igst|hsn|batch|exp(?:iry)?|mfg|medicine\s*name|item|product|description|particulars|sr\.?\s*no?|s\.?\s*no?|amount|value|net|page\s*\d|bill\s*to|bill\s*amount|rupees|drug\s*lic|previous|balance|received|paid|cash|cheque|adarsh|khasra|thekma|martinganj|azamgarh)\b/i;

  function pdfNums(token) {
    // Strip currency symbols and commas, return float if purely numeric after strip
    var s = token.replace(/[₹$€£,\s]/g, "");
    return /^\d+(?:\.\d+)?$/.test(s) ? parseFloat(s) : null;
  }

  function assignPdfNums(nums) {
    var qty = "", mrp = "", purchase = "", sell = "";
    var close = function (a, b) { return b > 0 && Math.abs(a - b) / b < 0.07; };

    if (nums.length === 1) {
      sell = nums[0];
    } else if (nums.length === 2) {
      qty = nums[0]; sell = nums[1];
    } else if (nums.length === 3) {
      var a = nums[0], b = nums[1], c = nums[2];
      if (close(c, a * b))      { qty = a; sell = b; }          // qty, rate, total
      else                       { qty = a; mrp = b; sell = c; }
    } else {
      // 4+ numbers — detect which two multiply to the last (line total)
      var t = nums[nums.length - 1];
      var n0 = nums[0], n1 = nums[1], n2 = nums[2];
      if      (close(t, n0 * n2)) { qty = n0; mrp = n1; sell = n2; }  // qty, mrp, rate, total
      else if (close(t, n1 * n2)) { mrp = n0; qty = n1; sell = n2; }  // mrp, qty, rate, total (this app's receipt)
      else if (close(t, n0 * n1)) { qty = n0; sell = n1; }            // qty, rate, ?, total
      else                         { qty = n0; mrp = n1; purchase = n2; sell = nums[3]; }
    }
    return { qty: qty, mrp: mrp, purchase: purchase, sell: sell };
  }

  function parsePdfLines(lines) {
    var rows = [];
    lines.forEach(function (line) {
      line = line.trim();
      if (line.length < 4) return;
      if (PDF_SKIP_RE.test(line)) return;
      if (!/\d/.test(line)) return;

      // Strip leading serial number: "1." / "2)" / "  3  "
      var cleaned = line.replace(/^\s*\d{1,3}[\.\)]\s*/, "").trim();
      if (!cleaned || cleaned.length < 3) return;

      // ── Strategy 1: split by 2+ spaces (preserves table column layout) ──
      var tokens = cleaned.split(/\s{2,}/).map(function (t) { return t.trim(); }).filter(Boolean);
      var numVals = [], nameEnd = tokens.length;

      if (tokens.length >= 2) {
        // Peel numeric tokens off the right
        for (var i = tokens.length - 1; i >= 0; i--) {
          var v = pdfNums(tokens[i]);
          if (v !== null) { numVals.unshift(v); nameEnd = i; }
          else break;
        }
      }

      var name, nums;
      if (numVals.length >= 1 && nameEnd >= 1) {
        name = tokens.slice(0, nameEnd).join(" ").trim();
        nums = numVals;
      } else {
        // ── Strategy 2: fallback — split at first run of digits/currency ──
        var di = cleaned.search(/[₹\d]/);
        if (di < 2) return;
        name = cleaned.substring(0, di).trim().replace(/[\s,]+$/, "");
        var tail = cleaned.substring(di);
        nums = [];
        var nr; var nre = /\d+(?:\.\d+)?/g;
        while ((nr = nre.exec(tail)) !== null) { nums.push(parseFloat(nr[0])); }
      }

      if (!name || name.length < 2 || !nums || !nums.length) return;
      // Skip address lines (long) or lines with a 6-digit pincode/license number
      if (name.length > 55) return;
      if (/\d{6,}/.test(name)) return;
      // Skip if any extracted number looks like a year or large ID (> 5000 with only 1 number)
      if (nums.length === 1 && nums[0] > 5000) return;

      var assigned = assignPdfNums(nums);
      rows.push({
        date: "", bill_number: "", customer_name: "", customer_phone: "",
        notes: "", gst_percent: "",
        medicine_name: name, location: "",
        quantity:       assigned.qty      ? String(assigned.qty)      : "1",
        mrp:            assigned.mrp      ? String(assigned.mrp)      : "",
        purchase_price: assigned.purchase ? String(assigned.purchase) : "",
        sell_price:     assigned.sell     ? String(assigned.sell)     : "",
      });
    });
    return rows;
  }

  async function handlePdfFile(file) {
    var pdfNote = document.getElementById("import-pdf-note");
    var info    = document.getElementById("import-preview-info");
    var preview = document.getElementById("import-preview");
    if (preview) preview.classList.remove("hidden");
    if (info)    info.textContent = "Extracting text from PDF…";
    try {
      var lines = await extractPdfLines(file);
      var hasText = lines.some(function (l) { return l.trim().length > 0; });

      if (!hasText) {
        if (info) info.textContent =
          "No text layer found in this PDF — it was saved as an image. " +
          "Bills downloaded via the app’s Share button are image-only. " +
          "To import, use browser Print → Save as PDF (Ctrl+P) instead, or export as CSV.";
        if (preview) preview.classList.remove("hidden");
        return;
      }

      importParsedRows = parsePdfLines(lines);

      if (!importParsedRows.length) {
        if (info) info.textContent =
          "Text was found in the PDF but no medicine rows could be identified. " +
          "The layout may not be supported — try exporting as CSV instead.";
        if (preview) preview.classList.remove("hidden");
        return;
      }

      if (pdfNote) pdfNote.classList.remove("hidden");
      renderImportPreview(importParsedRows);
    } catch (err) {
      if (info) info.textContent = "PDF extraction failed: " + (err.message || "unknown error");
    }
  }

  function handleImportFile(file) {
    if (!file) return;
    var pdfNote = document.getElementById("import-pdf-note");
    if (pdfNote) pdfNote.classList.add("hidden");
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      handlePdfFile(file);
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
      importParsedRows = parseCSV(e.target.result);
      renderImportPreview(importParsedRows);
    };
    reader.readAsText(file);
  }

  function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function renderImportPreview(rows) {
    var preview = document.getElementById("import-preview");
    var info    = document.getElementById("import-preview-info");
    var thead   = document.getElementById("import-preview-head");
    var tbody   = document.getElementById("import-preview-body");
    var submit  = document.getElementById("import-submit-btn");
    var result  = document.getElementById("import-result");

    if (result) { result.classList.add("hidden"); result.textContent = ""; }

    if (!rows.length) {
      if (info) info.textContent = "No valid rows found. Check that your CSV matches the template format.";
      if (preview) preview.classList.remove("hidden");
      if (submit) submit.disabled = true;
      return;
    }

    // Count distinct bills
    var billNums = new Set();
    var autoBills = 0;
    rows.forEach(function (r) {
      var bn = (r.bill_number || "").trim();
      if (bn) { billNums.add(bn); } else { autoBills++; }
    });
    var totalBills = billNums.size + autoBills;

    if (info) info.textContent = "Found " + rows.length + " row(s) → " + totalBills + " bill(s). Showing first 15 rows:";

    // Build preview table
    var showCols = ["date","bill_number","customer_name","medicine_name","qty","sell_price"];
    var displayRows = rows.slice(0, 15);

    if (thead) {
      thead.innerHTML = "<tr>" + ["Date","Bill No.","Customer","Medicine","Qty","Sell ₹"].map(function (h) {
        return '<th style="padding:0.45rem 0.7rem;text-align:left;font-size:0.75rem;color:#64748b;font-weight:700;border-bottom:1px solid #e2e8f0;white-space:nowrap;">' + h + "</th>";
      }).join("") + "</tr>";
    }
    if (tbody) {
      tbody.innerHTML = displayRows.map(function (r) {
        return "<tr>" +
          [r.date, r.bill_number || "(auto)", r.customer_name, r.medicine_name, r.quantity, r.sell_price].map(function (v) {
            return '<td style="padding:0.4rem 0.7rem;border-bottom:1px solid #f1f5f9;font-size:0.8rem;color:#1e293b;">' + escHtml(v || "—") + "</td>";
          }).join("") +
        "</tr>";
      }).join("");
    }

    if (preview) preview.classList.remove("hidden");
    if (submit) { submit.disabled = false; submit.textContent = "Import " + totalBills + " Bill(s)"; }
  }

  async function submitImport() {
    if (!importParsedRows.length) return;
    var submitBtn = document.getElementById("import-submit-btn");
    var resultEl  = document.getElementById("import-result");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Importing…"; }

    try {
      var data = await requestApi("/api/import-bills", { method: "POST", body: { rows: importParsedRows } });
      var msg = "✅ Imported: " + data.ok + " bill(s).";
      if (data.skipped) msg += "  Skipped (already exist): " + data.skipped + ".";
      if (data.errors)  msg += "  Errors: " + data.errors + ".";
      if (resultEl) {
        resultEl.textContent = msg;
        resultEl.style.cssText = "background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;";
        resultEl.classList.remove("hidden");
      }
      if (submitBtn) submitBtn.textContent = "Done";
      await loadBillHistory();
    } catch (err) {
      if (resultEl) {
        resultEl.textContent = "Import failed: " + (err.message || "Unknown error");
        resultEl.style.cssText = "background:#fef2f2;border:1px solid #fecaca;color:#dc2626;";
        resultEl.classList.remove("hidden");
      }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Retry Import"; }
    }
  }

  function downloadTemplate() {
    var blob = new Blob([CSV_TEMPLATE], { type: "text/csv;charset=utf-8;" });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement("a");
    a.href = url; a.download = "bill-import-template.csv";
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  function initImportModal() {
    if (bEl.importBillsBtn) bEl.importBillsBtn.addEventListener("click", showImportModal);

    var closeBtn   = document.getElementById("import-modal-close");
    var cancelBtn  = document.getElementById("import-cancel-btn");
    var fileInput  = document.getElementById("import-file-input");
    var submitBtn  = document.getElementById("import-submit-btn");
    var templateBtn = document.getElementById("import-template-btn");
    var overlay    = document.getElementById("import-modal-overlay");

    if (closeBtn)    closeBtn.addEventListener("click",   closeImportModal);
    if (cancelBtn)   cancelBtn.addEventListener("click",  closeImportModal);
    if (templateBtn) templateBtn.addEventListener("click", downloadTemplate);
    if (fileInput)   fileInput.addEventListener("change", function () { handleImportFile(this.files[0]); });
    if (submitBtn)   submitBtn.addEventListener("click",  submitImport);
    if (overlay)     overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeImportModal(); });
  }

  // -------------------------------------------------------------------------
  // Bill History
  // -------------------------------------------------------------------------
  async function loadBillHistory() {
    try {
      var result = await requestApi("/api/bills", { method: "GET" });
      bState.billHistory = result.bills || [];
      renderBillHistory();
    } catch (error) {
      if (bEl.historyContainer) {
        bEl.historyContainer.innerHTML =
          '<p class="status-message is-error">Could not load bill history: ' +
          (error.message || "Unknown error") + "</p>";
      }
    }
  }

  // ── Receipt modal ────────────────────────────────────────────────────────

  function openReceiptModal(billNumber, receiptHtml) {
    modalBillData = { billNumber: billNumber, receiptHtml: receiptHtml };
    if (bEl.receiptModalRef)  bEl.receiptModalRef.textContent = "Bill " + billNumber;
    if (bEl.receiptModalBody) bEl.receiptModalBody.innerHTML  = receiptHtml;
    if (bEl.receiptModal)     bEl.receiptModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  function closeReceiptModal() {
    if (bEl.receiptModal) bEl.receiptModal.classList.add("hidden");
    if (bEl.receiptModalBody) bEl.receiptModalBody.innerHTML = "";
    document.body.style.overflow = "";
    modalBillData = null;
  }

  function printModalBill() {
    if (!modalBillData || !bEl.printArea) return;
    bEl.printArea.innerHTML = modalBillData.receiptHtml;
    window.print();
  }

  async function shareModalBill() {
    if (!modalBillData) return;
    var bn       = modalBillData.billNumber;
    var shareBtn = bEl.receiptModalShare;
    var origText = shareBtn ? shareBtn.textContent : "";
    if (shareBtn) { shareBtn.disabled = true; shareBtn.textContent = "Generating PDF…"; }

    // The modal sets body.overflow=hidden. Clear it so html2pdf's internal
    // container (position:absolute;top:0;left:0) is fully renderable by html2canvas.
    var savedBodyOverflow = document.body.style.overflow;

    try {
      document.body.style.overflow = "";

      // Wait two frames so the browser applies the overflow change before capture
      await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });

      var opt = {
        margin:      [8, 8, 8, 8],
        filename:    "Bill-" + bn + ".pdf",
        image:       { type: "jpeg", quality: 0.97 },
        html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: "#ffffff", scrollX: 0, scrollY: 0 },
        jsPDF:       { unit: "mm", format: "a4", orientation: "portrait" },
      };

      // Pass the HTML string — NOT a pre-positioned DOM element.
      // When a DOM element with position:fixed/absolute is passed, html2pdf clones
      // it with those same styles, causing the clone to escape html2pdf's rendering
      // container. html2canvas then captures an empty container → blank PDF.
      // With a string, html2pdf creates its own neutrally-positioned element internally.
      var pdfBlob = await new Promise(function (resolve, reject) {
        window.html2pdf().set(opt).from(modalBillData.receiptHtml).outputPdf("blob")
          .then(resolve)
          .catch(reject);
      });

      document.body.style.overflow = savedBodyOverflow;

      var fileName = "Bill-" + bn + ".pdf";
      var pdfFile  = new File([pdfBlob], fileName, { type: "application/pdf" });

      // Try Web Share API (mobile / supported desktop)
      if (window.navigator.share && window.navigator.canShare && window.navigator.canShare({ files: [pdfFile] })) {
        try {
          await window.navigator.share({ files: [pdfFile], title: "Bill " + bn + " — Adarsh Medicals" });
          return;
        } catch (e) {
          if (e.name === "AbortError") return;
        }
      }

      // Fallback: direct download
      var url = URL.createObjectURL(pdfBlob);
      var a   = document.createElement("a");
      a.href = url; a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);

    } catch (err) {
      document.body.style.overflow = savedBodyOverflow;
      window.alert("Could not generate PDF: " + (err.message || "Unknown error"));
    } finally {
      if (shareBtn) { shareBtn.disabled = false; shareBtn.textContent = origText; }
    }
  }

  // Walk backwards through bill history for a customer to infer what prevBal was
  // at the time a specific bill was created. Uses the customer's current stored
  // balance as the starting point and subtracts grand_totals going backwards.
  // Only used for old bills that predate the per-bill localStorage snapshot.
  function inferPrevBalanceFromHistory(bill) {
    if (!bill || !bill.customer_name) return 0;
    var cname = bill.customer_name.toLowerCase();
    var custList = loadSavedCustomers();
    var custIdx = custList.findIndex(function(c) { return c.name.toLowerCase() === cname; });
    if (custIdx < 0) return 0;
    var currentBalance = parseFloat(custList[custIdx].balance) || 0;
    // Sort this customer's bills most-recent first
    var customerBills = (bState.billHistory || [])
      .filter(function(b) { return b.customer_name && b.customer_name.toLowerCase() === cname; })
      .sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    // Walk backwards: prevBal_for_bill = runningBalance - ceil(grandTotal) + received
    var runningBal = currentBalance;
    for (var i = 0; i < customerBills.length; i++) {
      var b = customerBills[i];
      var billRecv = parseFloat(localStorage.getItem("am.billRecv." + b.id) || "0") || 0;
      var prevBal  = round2(runningBal - Math.ceil(b.grand_total) + billRecv);
      if (b.id === bill.id) return Math.max(0, prevBal);
      runningBal = prevBal;
    }
    return 0;
  }

  async function viewBillInModal(billId) {
    try {
      var result = await requestApi("/api/bills?id=" + encodeURIComponent(billId), { method: "GET" });
      var bill   = result.bill;
      var items  = result.items || [];
      var prevBal, received;
      if (localStorage.getItem("am.billPrev." + billId) !== null) {
        prevBal  = parseFloat(localStorage.getItem("am.billPrev." + billId)) || 0;
        received = parseFloat(localStorage.getItem("am.billRecv." + billId) || "0") || 0;
      } else {
        prevBal  = inferPrevBalanceFromHistory(bill);
        received = 0;
      }
      var html   = buildReceiptHtml({
        billNumber:    bill.bill_number,
        customerName:  bill.customer_name,
        customerPhone: bill.customer_phone,
        notes:         bill.notes,
        gstPercent:    bill.gst_percent,
        items:         items,
        prevBalance:   prevBal,
        received:      received,
      });
      openReceiptModal(bill.bill_number, html);
    } catch (err) {
      window.alert("Could not load bill: " + (err.message || "Unknown error"));
    }
  }

  async function shareFromHistory(billId) {
    try {
      var result = await requestApi("/api/bills?id=" + encodeURIComponent(billId), { method: "GET" });
      var bill   = result.bill;
      var items  = result.items || [];
      var prevBal, received;
      if (localStorage.getItem("am.billPrev." + billId) !== null) {
        prevBal  = parseFloat(localStorage.getItem("am.billPrev." + billId)) || 0;
        received = parseFloat(localStorage.getItem("am.billRecv." + billId) || "0") || 0;
      } else {
        prevBal  = inferPrevBalanceFromHistory(bill);
        received = 0;
      }
      var html   = buildReceiptHtml({
        billNumber:    bill.bill_number,
        customerName:  bill.customer_name,
        customerPhone: bill.customer_phone,
        notes:         bill.notes,
        gstPercent:    bill.gst_percent,
        items:         items,
        prevBalance:   prevBal,
        received:      received,
      });
      // Open the modal first so user can also print, then share
      openReceiptModal(bill.bill_number, html);
    } catch (err) {
      window.alert("Could not load bill: " + (err.message || "Unknown error"));
    }
  }

  function renderBillHistory() {
    if (!bEl.historyContainer) return;

    if (!bState.billHistory.length) {
      bEl.historyContainer.innerHTML = '<p class="empty-state">No bills created yet.</p>';
      return;
    }

    var rowsHtml = bState.billHistory.map(function (bill) {
      return (
        "<tr>" +
          '<td><span class="bill-history-number">' + bill.bill_number + "</span></td>" +
          "<td>" + fmtDate(bill.created_at) + "</td>" +
          "<td>" + (bill.customer_name
            ? bill.customer_name
            : '<span style="color:var(--muted)">Walk-in</span>') +
          "</td>" +
          '<td style="font-family:var(--font-mono);font-size:0.78rem;color:var(--muted);">' +
            bill.created_by +
          "</td>" +
          '<td class="num-col"><span class="bill-history-total">' + fmtMoney(Math.ceil(bill.grand_total)) + "</span></td>" +
          "<td>" +
            '<div style="display:flex;gap:0.4rem;justify-content:flex-end;flex-wrap:wrap;">' +
              '<button class="btn btn-ghost btn-xs" data-view-bill="'   + bill.id + '" type="button">👁 View</button>' +
              '<button class="btn btn-ghost btn-xs" data-share-bill="'  + bill.id + '" type="button">📤 Share</button>' +
              '<button class="btn btn-ghost btn-xs" data-edit-bill="'   + bill.id + '" type="button">✏️ Edit</button>' +
              '<button class="btn btn-secondary btn-xs" data-print-bill="' + bill.id + '" type="button">🖨️</button>' +
              '<button class="btn btn-ghost btn-xs bill-delete-btn" data-delete-bill="' + bill.id + '" data-bill-number="' + bill.bill_number + '" type="button">🗑️</button>' +
            "</div>" +
          "</td>" +
        "</tr>"
      );
    }).join("");

    bEl.historyContainer.innerHTML =
      '<div style="overflow-x:auto;border-radius:var(--radius-sm);border:1px solid var(--line);">' +
        '<table class="bill-history-table">' +
          "<thead><tr>" +
            "<th>Bill No.</th>" +
            "<th>Date</th>" +
            "<th>Customer</th>" +
            "<th>Created By</th>" +
            '<th class="num-col">Total</th>' +
            "<th></th>" +
          "</tr></thead>" +
          "<tbody>" + rowsHtml + "</tbody>" +
        "</table>" +
      "</div>";

    bEl.historyContainer.querySelectorAll("[data-view-bill]").forEach(function (btn) {
      btn.addEventListener("click", function () { viewBillInModal(btn.dataset.viewBill); });
    });

    bEl.historyContainer.querySelectorAll("[data-share-bill]").forEach(function (btn) {
      btn.addEventListener("click", function () { shareFromHistory(btn.dataset.shareBill); });
    });

    bEl.historyContainer.querySelectorAll("[data-edit-bill]").forEach(function (btn) {
      btn.addEventListener("click", function () { loadBillForEdit(btn.dataset.editBill); });
    });

    bEl.historyContainer.querySelectorAll("[data-print-bill]").forEach(function (btn) {
      btn.addEventListener("click", function () { loadAndPrintBill(btn.dataset.printBill); });
    });

    bEl.historyContainer.querySelectorAll("[data-delete-bill]").forEach(function (btn) {
      btn.addEventListener("click", function () { deleteBill(btn.dataset.deleteBill, btn.dataset.billNumber); });
    });
  }

  async function deleteBill(billId, billNumber) {
    if (!window.confirm("Delete bill " + billNumber + "? This cannot be undone.")) return;
    try {
      await requestApi("/api/bills?id=" + encodeURIComponent(billId), { method: "DELETE" });
      // If the deleted bill is the one currently being edited, reset the form
      if (bState.currentBillId === billId) {
        bState.currentBillId     = null;
        bState.currentBillNumber = null;
        if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = "New Bill";
        if (bEl.printBillButton)   bEl.printBillButton.disabled = true;
        setSaveStatus("Deleted bill " + billNumber + ".", "is-info");
      }
      await loadBillHistory();
    } catch (err) {
      window.alert("Could not delete bill: " + (err.message || "Unknown error"));
    }
  }

  async function loadBillForEdit(billId) {
    try {
      setBillingStatus("Loading bill for editing…", "is-info");
      var result = await requestApi("/api/bills?id=" + encodeURIComponent(billId), { method: "GET" });
      var bill  = result.bill;
      var items = result.items || [];

      bState.currentBillId     = bill.id;
      bState.currentBillNumber = bill.bill_number;
      bState.balanceCarriedForward  = true; // prevent new-bill balance logic on re-save
      bState.editOriginalGrandTotal = Math.ceil(bill.grand_total);
      bState.editOriginalReceived   = parseFloat(localStorage.getItem("am.billRecv." + bill.id) || "0") || 0;

      bState.lineItems = items.map(function (it) {
        return {
          _rowId:        "row-" + (bState.nextRowId++),
          medicineId:    it.medicine_id,
          medicineName:  it.medicine_name,
          location:      it.location,
          mrp:           it.mrp !== null ? Number(it.mrp) : null,
          purchasePrice: it.purchase_price !== null ? Number(it.purchase_price) : null,
          sellPrice:     Number(it.sell_price) || 0,
          markupPercent: it.markup_percent !== null ? Number(it.markup_percent) : null,
          quantity:      Number(it.quantity) || 1,
        };
      });

      if (bEl.customerName)   bEl.customerName.value   = bill.customer_name  || "";
      if (bEl.customerPhone)  bEl.customerPhone.value  = bill.customer_phone || "";
      if (bEl.notes)          bEl.notes.value          = bill.notes          || "";
      if (bEl.gstPercent)     bEl.gstPercent.value     = bill.gst_percent    || "0";
      if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = bill.bill_number;
      if (bEl.printBillButton)   bEl.printBillButton.disabled = false;

      // Restore the previous-balance snapshot so the form & receipt show the
      // correct "Previous Balance" for this specific bill. The user can correct
      // it in the Opening Balance field and re-save to fix historical receipts.
      var _storedPrev = parseFloat(localStorage.getItem("am.billPrev." + bill.id) || "0") || 0;
      bState.currentCustomerBalance  = _storedPrev;
      bState.editOriginalPrevBalance = _storedPrev;
      if (bEl.openingBalance) bEl.openingBalance.value = _storedPrev > 0 ? String(_storedPrev) : "";

      // Mark the customer as already resolved so tryAutoFillCustomer doesn't
      // fire on blur and overwrite the opening balance with the customer's
      // current stored balance.
      if (bill.customer_name) {
        var _cl2 = loadSavedCustomers();
        var _ci2 = _cl2.findIndex(function (c) {
          return c.name.toLowerCase() === bill.customer_name.toLowerCase();
        });
        if (_ci2 >= 0) bState.currentCustomerIdx = _ci2;
        loadCustomerLastPrices(bill.customer_name);
      }

      renderLineItems();
      recalcTotals();

      var editMsg = items.length === 0
        ? "Bill loaded for editing. No saved line items found — please re-add medicines above, then click Save Bill."
        : "Bill loaded for editing. Make changes then click Save Bill.";
      setSaveStatus(editMsg, "is-info");
      setBillingStatus("", "");

      // Scroll to top of form
      if (bEl.billFormSection) {
        bEl.billFormSection.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (error) {
      setBillingStatus("Could not load bill: " + (error.message || "Unknown error"), "is-error");
    }
  }

  async function loadAndPrintBill(billId) {
    try {
      var result = await requestApi("/api/bills?id=" + encodeURIComponent(billId), { method: "GET" });
      var bill  = result.bill;
      var items = result.items || [];

      if (!bEl.printArea) return;
      var prevBal, received;
      if (localStorage.getItem("am.billPrev." + billId) !== null) {
        prevBal  = parseFloat(localStorage.getItem("am.billPrev." + billId)) || 0;
        received = parseFloat(localStorage.getItem("am.billRecv." + billId) || "0") || 0;
      } else {
        prevBal  = inferPrevBalanceFromHistory(bill);
        received = 0;
      }
      bEl.printArea.innerHTML = buildReceiptHtml({
        billNumber:    bill.bill_number,
        customerName:  bill.customer_name,
        customerPhone: bill.customer_phone,
        notes:         bill.notes,
        gstPercent:    bill.gst_percent,
        items:         items,
        prevBalance:   prevBal,
        received:      received,
      });
      window.print();
    } catch (error) {
      window.alert("Could not print bill: " + (error.message || "Unknown error"));
    }
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------
  function initBillingPage() {
    if (bState.initialized) return;
    bState.initialized = true;

    if (!isAdmin()) {
      setBillingStatus("Admin access required to use billing.", "is-error");
      if (bEl.billFormSection) bEl.billFormSection.classList.add("hidden");
      var itemsSection = document.querySelector('[id="bill-items-section"]');
      if (itemsSection) itemsSection.classList.add("hidden");
      return;
    }

    // Date
    if (bEl.billDateValue) bEl.billDateValue.textContent = todayLong();

    // Saved customers
    renderCustomerSelect();
    if (bEl.savedCustomerSelect) bEl.savedCustomerSelect.addEventListener("change", onSavedCustomerChange);
    if (bEl.saveCustomerBtn)     bEl.saveCustomerBtn.addEventListener("click", saveCurrentCustomer);
    if (bEl.repairBalanceBtn)    bEl.repairBalanceBtn.addEventListener("click", reconcileCustomerBalance);
    if (bEl.restoreCustomersBtn) bEl.restoreCustomersBtn.addEventListener("click", restoreCustomersFromHistory);
    initImportModal();

    // Opening balance field directly drives recalcPayment
    if (bEl.openingBalance) {
      bEl.openingBalance.addEventListener("input", function () {
        bState.currentCustomerBalance = parseFloat(bEl.openingBalance.value) || 0;
        recalcPayment();
      });
    }

    // Auto-fill balance when customer name or phone matches a saved customer on blur
    function tryAutoFillCustomer() {
      var name  = (bEl.customerName  ? bEl.customerName.value  : "").trim().toLowerCase();
      var phone = (bEl.customerPhone ? bEl.customerPhone.value : "").trim();
      if (!name && !phone) return;
      var list = loadSavedCustomers();
      var idx  = list.findIndex(function (c) {
        return (name  && c.name.toLowerCase()  === name)  ||
               (phone && c.phone               === phone);
      });
      if (idx >= 0 && bState.currentCustomerIdx !== idx) {
        var c = list[idx];
        bState.currentCustomerIdx     = idx;
        bState.currentCustomerBalance = parseFloat(c.balance) || 0;
        if (bEl.customerName)        bEl.customerName.value        = c.name  || "";
        if (bEl.customerPhone)       bEl.customerPhone.value       = c.phone || "";
        if (bEl.openingBalance)      bEl.openingBalance.value      = bState.currentCustomerBalance > 0 ? bState.currentCustomerBalance : "";
        if (bEl.savedCustomerSelect) bEl.savedCustomerSelect.value = String(idx);
        loadCustomerLastPrices(c.name);
        recalcPayment();
      }
    }
    if (bEl.customerName)  bEl.customerName.addEventListener("blur",  tryAutoFillCustomer);
    if (bEl.customerPhone) bEl.customerPhone.addEventListener("blur", tryAutoFillCustomer);

    // Also trigger on input with debounce so the balance row updates as the user types
    var _autoFillTimer = null;
    function debouncedAutoFill() {
      clearTimeout(_autoFillTimer);
      _autoFillTimer = setTimeout(tryAutoFillCustomer, 400);
    }
    if (bEl.customerName)  bEl.customerName.addEventListener("input",  debouncedAutoFill);
    if (bEl.customerPhone) bEl.customerPhone.addEventListener("input", debouncedAutoFill);

    // Search events
    if (bEl.search) {
      bEl.search.addEventListener("input", handleSearchInput);
      bEl.search.addEventListener("blur", function () {
        setTimeout(function () { hideDropdown(); }, 200);
      });
      bEl.search.addEventListener("keydown", function (e) {
        var dropdownOpen = bEl.dropdown && !bEl.dropdown.classList.contains("hidden");
        if (e.key === "Escape") {
          hideDropdown();
        } else if (e.key === "ArrowDown") {
          if (!dropdownOpen) return;
          e.preventDefault();
          setActiveDropdownItem(activeDropdownIdx + 1);
        } else if (e.key === "ArrowUp") {
          if (!dropdownOpen) return;
          e.preventDefault();
          setActiveDropdownItem(activeDropdownIdx - 1);
        } else if (e.key === "Enter") {
          if (!dropdownOpen) return;
          e.preventDefault();
          var idx = activeDropdownIdx >= 0 ? activeDropdownIdx : 0;
          if (currentDropdownResults[idx]) {
            addLineItem(currentDropdownResults[idx]);
            hideDropdown();
          }
        }
      });
    }

    // Outside click closes dropdown
    document.addEventListener("click", function (e) {
      if (!bEl.dropdown) return;
      if (!bEl.dropdown.contains(e.target) && e.target !== bEl.search) {
        bEl.dropdown.classList.add("hidden");
      }
    });

    // GST / round-off / received amount recalculation
    if (bEl.gstPercent)     bEl.gstPercent.addEventListener("input",    recalcTotals);
    if (bEl.roundOffToggle) bEl.roundOffToggle.addEventListener("change", recalcTotals);
    if (bEl.receivedAmount) bEl.receivedAmount.addEventListener("input", recalcPayment);

    // Action buttons
    if (bEl.saveBillButton)  bEl.saveBillButton.addEventListener("click", saveBill);
    if (bEl.printBillButton) bEl.printBillButton.addEventListener("click", printBill);
    if (bEl.newBillButton)   bEl.newBillButton.addEventListener("click", newBill);

    // Receipt modal wiring
    if (bEl.receiptModalClose)    bEl.receiptModalClose.addEventListener("click", closeReceiptModal);
    if (bEl.receiptModalBackdrop) bEl.receiptModalBackdrop.addEventListener("click", closeReceiptModal);
    if (bEl.receiptModalPrint)    bEl.receiptModalPrint.addEventListener("click", printModalBill);
    if (bEl.receiptModalShare)    bEl.receiptModalShare.addEventListener("click", shareModalBill);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && bEl.receiptModal && !bEl.receiptModal.classList.contains("hidden")) {
        closeReceiptModal();
      }
    });

    // Initial render
    setBillingStatus("Ready. Search for medicines to start a new bill.", "is-ok");
    renderLineItems();
    recalcTotals();
    loadBillHistory();
  }

  // -------------------------------------------------------------------------
  // Hooks for app.js integration
  // -------------------------------------------------------------------------

  /** Called once by app.js when auth is confirmed ready */
  window.__onBillingReady = function () {
    initBillingPage();
  };

  /** Called by app.js on every renderPage() — keeps header in sync */
  window.__renderBillingPage = function () {
    // No-op: header session is managed by app.js renderHeaderSession()
  };
})();
