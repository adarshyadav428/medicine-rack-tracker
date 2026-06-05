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
      bEl.search.focus();
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
    var customer = (overrides && overrides.customerName)  || normalizeString(bEl.customerName  ? bEl.customerName.value  : "") || "Walk-in Customer";
    var phone    = (overrides && overrides.customerPhone) || normalizeString(bEl.customerPhone ? bEl.customerPhone.value : "");
    var notes    = (overrides && overrides.notes)         || normalizeString(bEl.notes         ? bEl.notes.value         : "");
    var gstPct   = (overrides && overrides.gstPercent !== undefined) ? overrides.gstPercent : (parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0);
    var items    = (overrides && overrides.items) || bState.lineItems;
    var billNo   = (overrides && overrides.billNumber) || bState.currentBillNumber || "DRAFT";
    var now      = new Date();
    var dateStr  = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    var timeStr  = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

    var subtotal   = round2(items.reduce(function (s, it) {
      return s + round2((it.sell_price !== undefined ? it.sell_price : it.sellPrice) * it.quantity);
    }, 0));
    var gstAmt     = round2(subtotal * gstPct / 100);
    var grandTotal = round2(subtotal + gstAmt);

    var intPart   = Math.floor(grandTotal);
    var decPart   = Math.round((grandTotal - intPart) * 100);
    var amtWords  = "Rupees " + numToWords(intPart) + (decPart ? " and " + numToWords(decPart) + " Paise" : "") + " Only";

    var rowsHtml = items.map(function (it, idx) {
      var name  = it.medicine_name || it.medicineName || "—";
      var mrp   = (it.mrp !== null && it.mrp !== undefined) ? "₹" + Number(it.mrp).toFixed(2) : "—";
      var qty   = it.quantity;
      var price = it.sell_price !== undefined ? it.sell_price : it.sellPrice;
      var total = round2(price * qty);
      var bg    = idx % 2 === 0 ? "#fff" : "#f9fbfc";
      return (
        "<tr style='background:" + bg + ";'>" +
          "<td style='padding:5px 7px;border:1px solid #dde3e7;text-align:center;color:#666;font-size:11px;'>" + (idx + 1) + "</td>" +
          "<td style='padding:5px 8px;border:1px solid #dde3e7;font-size:12.5px;font-weight:600;'>" + name + "</td>" +
          "<td style='padding:5px 7px;border:1px solid #dde3e7;text-align:right;font-size:11.5px;color:#555;'>" + mrp + "</td>" +
          "<td style='padding:5px 7px;border:1px solid #dde3e7;text-align:center;font-size:12.5px;font-weight:700;'>" + qty + "</td>" +
          "<td style='padding:5px 7px;border:1px solid #dde3e7;text-align:right;font-size:12px;'>₹" + Number(price).toFixed(2) + "</td>" +
          "<td style='padding:5px 7px;border:1px solid #dde3e7;text-align:right;font-size:12.5px;font-weight:700;'>₹" + Number(total).toFixed(2) + "</td>" +
        "</tr>"
      );
    }).join("");

    return (
      "<div style='font-family:Arial,\"Helvetica Neue\",sans-serif;max-width:720px;margin:0 auto;padding:20px 24px;color:#000;border:1.5px solid #ccc;'>" +

        /* ── Store header ── */
        "<div style='text-align:center;padding-bottom:10px;border-bottom:2px solid #000;margin-bottom:10px;'>" +
          "<div style='font-size:22px;font-weight:900;letter-spacing:2px;text-transform:uppercase;'>Adarsh Medicals</div>" +
          "<div style='font-size:12px;margin-top:3px;'>Khasra No. 157, Thekma, Near Bus Stop, Martinganj, Azamgarh, U.P. – 276303</div>" +
          "<div style='font-size:12px;'>Mob: 8470900910</div>" +
          "<div style='font-size:10.5px;margin-top:5px;border-top:1px dashed #bbb;padding-top:4px;color:#333;'>" +
            "Drug Lic. (Form 20): <strong>RLF20UP2025023538</strong>" +
            "&nbsp;&nbsp;|&nbsp;&nbsp;" +
            "Drug Lic. (Form 21): <strong>RLF21UP2025023481</strong>" +
          "</div>" +
        "</div>" +

        /* ── Invoice title ── */
        "<div style='text-align:center;font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin-bottom:10px;color:#333;'>Cash Memo / Retail Invoice</div>" +

        /* ── Bill meta + customer ── */
        "<div style='display:flex;justify-content:space-between;gap:12px;margin-bottom:12px;font-size:12px;'>" +
          "<div style='border:1px solid #ccc;padding:7px 10px;border-radius:4px;flex:1;'>" +
            "<div style='font-size:10px;font-weight:700;text-transform:uppercase;color:#666;margin-bottom:4px;letter-spacing:1px;'>Bill To</div>" +
            "<div style='font-size:13px;font-weight:700;'>" + customer + "</div>" +
            (phone ? "<div style='margin-top:2px;'>Mob: " + phone + "</div>" : "") +
          "</div>" +
          "<div style='border:1px solid #ccc;padding:7px 10px;border-radius:4px;text-align:right;min-width:165px;'>" +
            "<div style='font-size:10px;font-weight:700;text-transform:uppercase;color:#666;margin-bottom:4px;letter-spacing:1px;'>Bill Details</div>" +
            "<div><strong>Bill No:</strong> " + billNo + "</div>" +
            "<div><strong>Date:</strong> " + dateStr + "</div>" +
            "<div><strong>Time:</strong> " + timeStr + "</div>" +
          "</div>" +
        "</div>" +

        /* ── Items table ── */
        "<table style='width:100%;border-collapse:collapse;font-size:12px;'>" +
          "<thead>" +
            "<tr style='background:#f0f4f6;'>" +
              "<th style='padding:7px;border:1px solid #ccc;text-align:center;width:30px;font-size:11px;'>#</th>" +
              "<th style='padding:7px 9px;border:1px solid #ccc;text-align:left;'>Medicine Name</th>" +
              "<th style='padding:7px;border:1px solid #ccc;text-align:right;width:68px;'>MRP</th>" +
              "<th style='padding:7px;border:1px solid #ccc;text-align:center;width:42px;'>Qty</th>" +
              "<th style='padding:7px;border:1px solid #ccc;text-align:right;width:72px;'>Rate</th>" +
              "<th style='padding:7px;border:1px solid #ccc;text-align:right;width:82px;'>Amount</th>" +
            "</tr>" +
          "</thead>" +
          "<tbody>" + rowsHtml + "</tbody>" +
        "</table>" +

        /* ── Totals block (right-aligned) ── */
        "<div style='display:flex;justify-content:flex-end;'>" +
          "<div style='min-width:270px;border:1px solid #ccc;border-top:none;font-size:12.5px;'>" +
            "<div style='display:flex;justify-content:space-between;padding:5px 10px;border-bottom:1px solid #eee;'>" +
              "<span>Subtotal</span><span>₹" + subtotal.toFixed(2) + "</span>" +
            "</div>" +
            (gstPct > 0
              ? "<div style='display:flex;justify-content:space-between;padding:5px 10px;border-bottom:1px solid #eee;'>" +
                  "<span>GST (" + gstPct + "%)</span><span>₹" + gstAmt.toFixed(2) + "</span>" +
                "</div>"
              : "") +
            "<div style='display:flex;justify-content:space-between;padding:7px 10px;font-size:14px;font-weight:800;background:#f0f4f6;border-top:2px solid #000;'>" +
              "<span>NET AMOUNT</span><span>₹" + grandTotal.toFixed(2) + "</span>" +
            "</div>" +
          "</div>" +
        "</div>" +

        /* ── Amount in words ── */
        "<div style='margin-top:8px;font-size:11.5px;border:1px solid #ddd;padding:5px 10px;border-radius:3px;background:#fafafa;'>" +
          "<strong>Amount in Words:</strong> " + amtWords +
        "</div>" +

        /* ── Notes ── */
        (notes
          ? "<div style='margin-top:6px;font-size:11px;border:1px dashed #bbb;padding:5px 9px;border-radius:3px;color:#444;'>" +
              "<strong>Note:</strong> " + notes +
            "</div>"
          : "") +

        /* ── Footer: terms + signatory ── */
        "<div style='display:flex;justify-content:space-between;align-items:flex-end;margin-top:18px;font-size:11px;color:#444;gap:16px;'>" +
          "<div style='line-height:1.7;'>" +
            "<div>• Medicines once sold will not be returned or exchanged.</div>" +
            "<div>• Please verify medicines before leaving the counter.</div>" +
            "<div>• All disputes subject to Azamgarh jurisdiction.</div>" +
          "</div>" +
          "<div style='text-align:center;min-width:140px;'>" +
            "<div style='height:36px;'></div>" +
            "<div style='border-top:1px solid #000;padding-top:4px;font-size:11px;'>Authorised Signatory</div>" +
            "<div style='font-size:10px;color:#555;'>Adarsh Medicals</div>" +
          "</div>" +
        "</div>" +

        /* ── Thank you ── */
        "<div style='text-align:center;margin-top:12px;padding-top:8px;border-top:1px dashed #bbb;font-size:11.5px;color:#333;'>" +
          "Thank you for shopping at Adarsh Medicals &nbsp;🙏&nbsp; Get well soon!" +
        "</div>" +
        "<div style='text-align:center;margin-top:4px;font-size:10px;color:#999;'>This is a computer generated bill.</div>" +

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

    // GST recalculation
    if (bEl.gstPercent) bEl.gstPercent.addEventListener("input", recalcTotals);

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
