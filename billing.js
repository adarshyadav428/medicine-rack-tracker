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
    subtotal:         document.getElementById("summary-subtotal"),
    grandTotal:       document.getElementById("summary-grand-total"),
    itemsCount:       document.getElementById("summary-items-count"),
    saveBillButton:   document.getElementById("save-bill-button"),
    printBillButton:  document.getElementById("print-bill-button"),
    newBillButton:    document.getElementById("new-bill-button"),
    saveStatus:       document.getElementById("bill-save-status"),
    historyContainer: document.getElementById("bill-history-container"),
    printArea:        document.getElementById("print-receipt-area"),
  };

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

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function parseMoneyInput(value) {
    var parsed = parseFloat(value);
    return isNaN(parsed) || parsed < 0 ? null : round2(parsed);
  }

  // -------------------------------------------------------------------------
  // Medicine Search (client-side, against state.items)
  // -------------------------------------------------------------------------
  var searchTimer = null;

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
    bEl.dropdown.textContent = "";

    if (!results.length) {
      bEl.dropdown.appendChild(buildNewMedicineOption(query));
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

      var metaParts = [];
      if (item.location) metaParts.push("📍 " + item.location);
      if (item.mrp !== null && item.mrp !== undefined) metaParts.push("MRP: ₹" + item.mrp);
      if (sell !== null) metaParts.push("Sell: ₹" + sell);
      metaParts.push(stockLabel);

      el.innerHTML =
        '<span class="medicine-dropdown-name">' + item.medicineName + "</span>" +
        '<span class="medicine-dropdown-meta">' + metaParts.join(" · ") + "</span>";

      // Use mousedown so blur doesn't hide dropdown before click fires
      el.addEventListener("mousedown", function (e) {
        e.preventDefault();
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

    var exactMatch = results.some(function (item) {
      return item.medicineName.toLowerCase() === query.toLowerCase();
    });
    if (!exactMatch) {
      frag.appendChild(buildNewMedicineOption(query));
    }

    bEl.dropdown.appendChild(frag);
    bEl.dropdown.classList.remove("hidden");
  }

  function buildNewMedicineOption(query) {
    var wrapper = document.createElement("div");
    wrapper.className = "medicine-dropdown-item medicine-dropdown-new";
    wrapper.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });

    var safeQuery = escapeHtml(query);
    wrapper.innerHTML =
      '<div class="medicine-dropdown-new-head">' +
        '<span class="medicine-dropdown-name">Add "' + safeQuery + '" as new medicine</span>' +
        '<span class="medicine-dropdown-meta">Enter purchase price and MRP to add it now.</span>' +
      "</div>" +
      '<div class="billing-new-medicine-grid">' +
        '<div class="billing-new-field">' +
          '<label for="billing-new-name">Medicine Name</label>' +
          '<input id="billing-new-name" type="text" maxlength="160" value="' + safeQuery + '" />' +
        "</div>" +
        '<div class="billing-new-field">' +
          '<label for="billing-new-purchase">Purchase (₹)</label>' +
          '<input id="billing-new-purchase" type="number" min="0" step="0.01" placeholder="0.00" />' +
        "</div>" +
        '<div class="billing-new-field">' +
          '<label for="billing-new-mrp">MRP (₹)</label>' +
          '<input id="billing-new-mrp" type="number" min="0" step="0.01" placeholder="0.00" />' +
        "</div>" +
        '<button id="billing-new-add" class="btn btn-primary btn-xs" type="button">Add</button>' +
      "</div>" +
      '<p id="billing-new-error" class="billing-new-error"></p>';

    var addButton = wrapper.querySelector("#billing-new-add");
    if (addButton) {
      addButton.addEventListener("click", function () {
        saveNewMedicineFromBilling(wrapper);
      });
    }

    wrapper.querySelectorAll("input").forEach(function (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          saveNewMedicineFromBilling(wrapper);
        }
      });
    });

    return wrapper;
  }

  async function saveNewMedicineFromBilling(wrapper) {
    var nameInput = wrapper.querySelector("#billing-new-name");
    var purchaseInput = wrapper.querySelector("#billing-new-purchase");
    var mrpInput = wrapper.querySelector("#billing-new-mrp");
    var addButton = wrapper.querySelector("#billing-new-add");
    var errorEl = wrapper.querySelector("#billing-new-error");

    var medicineName = normalizeString(nameInput ? nameInput.value : "");
    var purchasePrice = parseMoneyInput(purchaseInput ? purchaseInput.value : "");
    var mrp = parseMoneyInput(mrpInput ? mrpInput.value : "");

    if (!medicineName) {
      if (errorEl) errorEl.textContent = "Medicine name is required.";
      return;
    }

    if (purchasePrice === null || mrp === null) {
      if (errorEl) errorEl.textContent = "Purchase price and MRP are required.";
      return;
    }

    var existing = (state.items || []).find(function (item) {
      return item.medicineName.toLowerCase() === medicineName.toLowerCase();
    });
    if (existing) {
      addLineItem(existing);
      hideDropdown();
      setSaveStatus("Medicine already exists. Added it to the bill.", "is-info");
      return;
    }

    if (addButton) addButton.disabled = true;
    if (errorEl) errorEl.textContent = "Adding medicine...";

    var now = new Date().toISOString();
    var newMedicine = normalizeItem({
      id: createId(),
      medicineName: medicineName,
      location: "Billing",
      quantity: null,
      expiryDate: "",
      sellingPrice: mrp,
      mrp: mrp,
      purchasePrice: purchasePrice,
      discount: null,
      seller: "",
      createdAt: now,
      updatedAt: now,
    });

    try {
      var savedMedicine = isCloudSyncActive() ? await upsertCloudItem(newMedicine) : newMedicine;
      state.items = [savedMedicine].concat(state.items || []);
      saveLocalItems(state.items);
      renderPage();
      addLineItem(savedMedicine);
      hideDropdown();
      setSaveStatus('Added "' + savedMedicine.medicineName + '" to inventory and bill.', "is-ok");
    } catch (error) {
      if (errorEl) errorEl.textContent = "Could not add medicine: " + (error.message || "Unknown error");
      if (addButton) addButton.disabled = false;
    }
  }

  function hideDropdown() {
    if (bEl.dropdown) bEl.dropdown.classList.add("hidden");
    if (bEl.search) bEl.search.value = "";
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

    var rowId = "row-" + (bState.nextRowId++);

    bState.lineItems.push({
      _rowId: rowId,
      medicineId:    medicine.id,
      medicineName:  medicine.medicineName,
      location:      medicine.location || "",
      mrp:           medicine.mrp !== null && medicine.mrp !== undefined ? Number(medicine.mrp) : null,
      purchasePrice: purchase !== null ? Number(purchase) : null,
      sellPrice:     Number(sell) || 0,
      markupPercent: null,
      quantity:      1,
    });

    renderLineItems();
    recalcTotals();

    // Focus search for quick multi-add
    if (bEl.search) bEl.search.focus();
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

    if (field === "quantity") {
      item.quantity = Math.max(1, parseInt(rawValue, 10) || 1);

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
      var mrpDisplay = item.mrp !== null ? fmtMoney(item.mrp) : "—";
      var purchaseDisplay = hasPurchase ? fmtMoney(item.purchasePrice) : "—";

      tr.innerHTML =
        "<td>" +
          '<div class="bill-item-name" title="' + item.medicineName + '">' + item.medicineName + "</div>" +
          '<div class="bill-item-location">' + (item.location || "—") + "</div>" +
        "</td>" +
        '<td class="num-col"><span class="bill-item-mrp">' + mrpDisplay + "</span></td>" +
        '<td class="num-col bill-purchase-col"><span style="font-family:var(--font-mono);font-size:0.85rem;color:#3a5560;">' + purchaseDisplay + "</span></td>" +
        '<td class="num-col">' +
          '<input id="markup-' + item._rowId + '" class="bill-table-input" type="number"' +
          ' min="-100" max="2000" step="0.01"' +
          ' value="' + markupVal + '"' +
          ' placeholder="' + (hasPurchase ? "0" : "N/A") + '"' +
          (hasPurchase ? "" : ' disabled title="Set purchase price in inventory first"') +
          " />" +
        "</td>" +
        '<td class="num-col">' +
          '<input id="sell-' + item._rowId + '" class="bill-table-input bill-table-input--sell" type="number"' +
          ' min="0" step="0.01"' +
          ' value="' + sellVal + '"' +
          ' placeholder="0"' +
          " />" +
        "</td>" +
        '<td class="num-col">' +
          '<input id="qty-' + item._rowId + '" class="bill-table-input" type="number"' +
          ' min="1" step="1"' +
          ' value="' + item.quantity + '"' +
          ' placeholder="1"' +
          " />" +
        "</td>" +
        '<td class="num-col"><span id="total-' + item._rowId + '" class="bill-item-line-total">' + fmtMoney(lineTotal) + "</span></td>" +
        "<td>" +
          '<button class="btn btn-danger btn-xs bill-remove-btn" data-remove="' + item._rowId + '" title="Remove this line" type="button">✕</button>' +
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

    bState.lineItems.forEach(function (item) {
      var qtyInput    = document.getElementById("qty-"    + item._rowId);
      var sellInput   = document.getElementById("sell-"   + item._rowId);
      var markupInput = document.getElementById("markup-" + item._rowId);

      function bindInput(el, field) {
        if (!el) return;
        el.addEventListener("input",  function () { updateLineItemField(item._rowId, field, el.value); });
        el.addEventListener("change", function () { updateLineItemField(item._rowId, field, el.value); });
      }

      bindInput(qtyInput,    "quantity");
      bindInput(sellInput,   "sellPrice");
      bindInput(markupInput, "markupPercent");
    });
  }

  function recalcTotals() {
    var subtotalVal = bState.lineItems.reduce(function (sum, item) {
      return sum + round2(item.sellPrice * item.quantity);
    }, 0);
    subtotalVal = round2(subtotalVal);

    var grandTotalVal = subtotalVal;

    if (bEl.subtotal)   bEl.subtotal.textContent   = fmtMoney(subtotalVal);
    if (bEl.grandTotal) bEl.grandTotal.textContent = fmtMoney(grandTotalVal);
    if (bEl.itemsCount) bEl.itemsCount.textContent = String(bState.lineItems.length);
  }

  // -------------------------------------------------------------------------
  // Save Bill
  // -------------------------------------------------------------------------
  function buildSavePayload() {
    return {
      customerName:  normalizeString(bEl.customerName  ? bEl.customerName.value  : ""),
      customerPhone: normalizeString(bEl.customerPhone ? bEl.customerPhone.value : ""),
      notes:         normalizeString(bEl.notes         ? bEl.notes.value         : ""),
      gstPercent:    0,
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
      } else {
        // Create new bill
        var result = await requestApi("/api/bills", { method: "POST", body: payload });
        bState.currentBillId     = result.bill.id;
        bState.currentBillNumber = result.billNumber;

        if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = result.billNumber;
        setSaveStatus("✅ Bill " + result.billNumber + " saved successfully!", "is-ok");
      }

      if (bEl.printBillButton) bEl.printBillButton.disabled = false;
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
  function buildReceiptHtml(overrides) {
    var customer   = (overrides && overrides.customerName)  || normalizeString(bEl.customerName  ? bEl.customerName.value  : "") || "Walk-in";
    var phone      = (overrides && overrides.customerPhone) || normalizeString(bEl.customerPhone ? bEl.customerPhone.value : "");
    var notes      = (overrides && overrides.notes)         || normalizeString(bEl.notes         ? bEl.notes.value         : "");
    var gstPct     = 0;
    var items      = (overrides && overrides.items) || bState.lineItems;
    var billNo     = (overrides && overrides.billNumber) || bState.currentBillNumber || "DRAFT";
    var dateStr    = new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

    var subtotal = items.reduce(function (s, it) {
      return s + round2((it.sell_price !== undefined ? it.sell_price : it.sellPrice) * it.quantity);
    }, 0);
    subtotal = round2(subtotal);
    var gstAmt    = round2(subtotal * gstPct / 100);
    var grandTotal = round2(subtotal + gstAmt);

    var rowsHtml = items.map(function (it) {
      var name  = it.medicine_name || it.medicineName || "—";
      var qty   = it.quantity;
      var price = it.sell_price !== undefined ? it.sell_price : it.sellPrice;
      var total = round2(price * qty);
      return (
        "<tr>" +
          "<td style='padding:2px 4px;border-bottom:1px dashed #ddd;'>" + name + "</td>" +
          "<td style='padding:2px 4px;border-bottom:1px dashed #ddd;text-align:center;'>" + qty + "</td>" +
          "<td style='padding:2px 4px;border-bottom:1px dashed #ddd;text-align:right;'>₹" + Number(price).toFixed(2) + "</td>" +
          "<td style='padding:2px 4px;border-bottom:1px dashed #ddd;text-align:right;'>₹" + Number(total).toFixed(2) + "</td>" +
        "</tr>"
      );
    }).join("");

    return (
      "<div style='font-family:\"Courier New\",monospace;font-size:12px;max-width:80mm;margin:0 auto;padding:8px;color:#000;'>" +
        "<div style='text-align:center;margin-bottom:8px;'>" +
          "<div style='font-size:16px;font-weight:bold;letter-spacing:1px;'>ADARSH MEDICALS</div>" +
          "<div>Thekma, Azamgarh, U.P.</div>" +
          "<div>Ph: 8470900910</div>" +
        "</div>" +
        "<div style='border-top:1px dashed #000;border-bottom:1px dashed #000;padding:4px 0;margin-bottom:6px;'>" +
          "<div>Bill No: <strong>" + billNo + "</strong></div>" +
          "<div>Date: " + dateStr + "</div>" +
          "<div>Customer: " + customer + (phone ? " | Ph: " + phone : "") + "</div>" +
        "</div>" +
        "<table style='width:100%;border-collapse:collapse;margin-bottom:6px;'>" +
          "<thead>" +
            "<tr style='border-bottom:1px solid #000;'>" +
              "<th style='text-align:left;padding:2px 4px;'>Medicine</th>" +
              "<th style='text-align:center;padding:2px 4px;'>Qty</th>" +
              "<th style='text-align:right;padding:2px 4px;'>Rate</th>" +
              "<th style='text-align:right;padding:2px 4px;'>Amount</th>" +
            "</tr>" +
          "</thead>" +
          "<tbody>" + rowsHtml + "</tbody>" +
        "</table>" +
        "<div style='border-top:1px solid #000;padding-top:4px;'>" +
          "<div style='display:flex;justify-content:space-between;'><span>Subtotal:</span><span>₹" + subtotal.toFixed(2) + "</span></div>" +
          (gstPct > 0
            ? "<div style='display:flex;justify-content:space-between;'><span>GST (" + gstPct + "%):</span><span>₹" + gstAmt.toFixed(2) + "</span></div>"
            : "") +
          "<div style='display:flex;justify-content:space-between;font-weight:bold;font-size:14px;border-top:2px solid #000;margin-top:4px;padding-top:4px;'>" +
            "<span>TOTAL:</span><span>₹" + grandTotal.toFixed(2) + "</span>" +
          "</div>" +
        "</div>" +
        (notes ? "<div style='margin-top:6px;font-size:11px;border-top:1px dashed #ccc;padding-top:4px;'>Note: " + notes + "</div>" : "") +
        "<div style='text-align:center;margin-top:10px;font-size:11px;border-top:1px dashed #ccc;padding-top:6px;'>" +
          "Thank you for your business! 🙏<br>Get well soon." +
        "</div>" +
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
    if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = "New Bill";
    if (bEl.printBillButton) bEl.printBillButton.disabled = true;

    setSaveStatus("", "");
    renderLineItems();
    recalcTotals();
    if (bEl.search) bEl.search.focus();
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
          '<td class="num-col"><span class="bill-history-total">' + fmtMoney(bill.grand_total) + "</span></td>" +
          "<td>" +
            '<div style="display:flex;gap:0.4rem;justify-content:flex-end;">' +
              '<button class="btn btn-ghost btn-xs" data-edit-bill="' + bill.id + '" type="button">✏️ Edit</button>' +
              '<button class="btn btn-secondary btn-xs" data-print-bill="' + bill.id + '" type="button">🖨️</button>' +
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

    bEl.historyContainer.querySelectorAll("[data-edit-bill]").forEach(function (btn) {
      btn.addEventListener("click", function () { loadBillForEdit(btn.dataset.editBill); });
    });

    bEl.historyContainer.querySelectorAll("[data-print-bill]").forEach(function (btn) {
      btn.addEventListener("click", function () { loadAndPrintBill(btn.dataset.printBill); });
    });
  }

  async function loadBillForEdit(billId) {
    try {
      setBillingStatus("Loading bill for editing…", "is-info");
      var result = await requestApi("/api/bills?id=" + encodeURIComponent(billId), { method: "GET" });
      var bill  = result.bill;
      var items = result.items || [];

      bState.currentBillId     = bill.id;
      bState.currentBillNumber = bill.bill_number;

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
      if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = bill.bill_number;
      if (bEl.printBillButton)   bEl.printBillButton.disabled = false;

      renderLineItems();
      recalcTotals();
      setSaveStatus("Bill loaded for editing. Make changes then click Save Bill.", "is-info");
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
      bEl.printArea.innerHTML = buildReceiptHtml({
        billNumber:    bill.bill_number,
        customerName:  bill.customer_name,
        customerPhone: bill.customer_phone,
        notes:         bill.notes,
        gstPercent:    0,
        items:         items,
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

    // Search events
    if (bEl.search) {
      bEl.search.addEventListener("input", handleSearchInput);
      bEl.search.addEventListener("blur", function () {
        setTimeout(function () { hideDropdown(); }, 200);
      });
      bEl.search.addEventListener("keydown", function (e) {
        if (e.key === "Escape") hideDropdown();
      });
    }

    // Outside click closes dropdown
    document.addEventListener("click", function (e) {
      if (!bEl.dropdown) return;
      if (!bEl.dropdown.contains(e.target) && e.target !== bEl.search) {
        bEl.dropdown.classList.add("hidden");
      }
    });

    // Action buttons
    if (bEl.saveBillButton)  bEl.saveBillButton.addEventListener("click", saveBill);
    if (bEl.printBillButton) bEl.printBillButton.addEventListener("click", printBill);
    if (bEl.newBillButton)   bEl.newBillButton.addEventListener("click", newBill);

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
