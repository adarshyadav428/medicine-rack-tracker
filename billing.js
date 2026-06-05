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
    saveCustomerStatus:    document.getElementById("bill-save-customer-status"),
    openingBalance:        document.getElementById("bill-opening-balance"),
    receivedAmount:        document.getElementById("bill-received-amount"),
    prevBalance:           document.getElementById("summary-prev-balance"),
    totalDue:              document.getElementById("summary-total-due"),
    balanceDue:            document.getElementById("summary-balance-due"),
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
    renderCustomerSelect();
    recalcPayment();
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
      var noResult = document.createElement("div");
      noResult.className = "medicine-dropdown-item medicine-dropdown-empty";
      noResult.textContent = 'No medicines found for "' + query + '"';
      bEl.dropdown.appendChild(noResult);
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

    bEl.dropdown.appendChild(frag);
    bEl.dropdown.classList.remove("hidden");
  }

  function hideDropdown() {
    if (bEl.dropdown) bEl.dropdown.classList.add("hidden");
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

    if (bEl.search) {
      bEl.search.value = "";
      setTimeout(function () { bEl.search.focus(); }, 0);
    }
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

    var gstPct = parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0;
    var gstAmt = round2(subtotalVal * gstPct / 100);
    var grandTotalVal = round2(subtotalVal + gstAmt);

    if (bEl.subtotal)   bEl.subtotal.textContent   = fmtMoney(subtotalVal);
    if (bEl.gstAmount)  bEl.gstAmount.textContent  = fmtMoney(gstAmt);
    if (bEl.gstLabel)   bEl.gstLabel.textContent   = "GST (" + gstPct + "%)";
    if (bEl.grandTotal) bEl.grandTotal.textContent = fmtMoney(grandTotalVal);
    if (bEl.itemsCount) bEl.itemsCount.textContent = String(bState.lineItems.length);

    recalcPayment();
  }

  function recalcPayment() {
    var subtotalVal = bState.lineItems.reduce(function (sum, item) {
      return sum + round2(item.sellPrice * item.quantity);
    }, 0);
    var gstPct      = parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0;
    var grandTotal  = round2(round2(subtotalVal) + round2(round2(subtotalVal) * gstPct / 100));
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
      } else {
        // Create new bill
        var result = await requestApi("/api/bills", { method: "POST", body: payload });
        bState.currentBillId     = result.bill.id;
        bState.currentBillNumber = result.billNumber;

        if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = result.billNumber;
        setSaveStatus("✅ Bill " + result.billNumber + " saved successfully!", "is-ok");
      }

      if (bEl.printBillButton) bEl.printBillButton.disabled = false;

      // Carry forward balance for the selected saved customer
      if (bState.currentCustomerIdx !== null) {
        var received   = parseFloat(bEl.receivedAmount ? bEl.receivedAmount.value : "0") || 0;
        var subtotal   = bState.lineItems.reduce(function (s, it) { return s + round2(it.sellPrice * it.quantity); }, 0);
        var gstPct     = parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0;
        var grandTot   = round2(round2(subtotal) + round2(round2(subtotal) * gstPct / 100));
        var totalDue   = round2(grandTot + (bState.currentCustomerBalance || 0));
        var newBalance = round2(totalDue - received);
        var custList   = loadSavedCustomers();
        if (custList[bState.currentCustomerIdx]) {
          custList[bState.currentCustomerIdx].balance = newBalance;
          persistSavedCustomers(custList);
          bState.currentCustomerBalance = newBalance;
          if (bEl.openingBalance) bEl.openingBalance.value = newBalance || "";
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
    var grandTotal = round2(subtotal + gstAmt);

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
    if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = "New Bill";
    if (bEl.printBillButton)   bEl.printBillButton.disabled = true;
    if (bEl.savedCustomerSelect) bEl.savedCustomerSelect.value = "";
    if (bEl.openingBalance)      bEl.openingBalance.value      = "";
    if (bEl.receivedAmount)      bEl.receivedAmount.value      = "0";
    bState.currentCustomerIdx     = null;
    bState.currentCustomerBalance = 0;

    setSaveStatus("", "");
    setSaveCustomerStatus("", "");
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
      if (bEl.gstPercent)     bEl.gstPercent.value     = bill.gst_percent    || "0";
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
        gstPercent:    bill.gst_percent,
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

    // Saved customers
    renderCustomerSelect();
    if (bEl.savedCustomerSelect) bEl.savedCustomerSelect.addEventListener("change", onSavedCustomerChange);
    if (bEl.saveCustomerBtn)     bEl.saveCustomerBtn.addEventListener("click", saveCurrentCustomer);

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

    // GST / received amount recalculation
    if (bEl.gstPercent)     bEl.gstPercent.addEventListener("input",    recalcTotals);
    if (bEl.receivedAmount) bEl.receivedAmount.addEventListener("input", recalcPayment);

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
