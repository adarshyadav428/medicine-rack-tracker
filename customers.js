/**
 * customers.js — Customer profiles page for Adarsh Medicals
 *
 * Depends on app.js globals: isAdmin, isAuthenticated, requestApi, normalizeString
 */
(function () {
  "use strict";

  if (document.body.dataset.page !== "customers") return;

  var CUSTOMERS_KEY = "medicineRackTracker.customers.v1";

  var cState = {
    initialized: false,
    selectedIdx: null,
    allBills: null,      // null = not yet fetched
    allPayments: {},     // keyed by customer name lowercased, cached after first fetch
    searchQuery: "",
  };

  var cEl = {
    status:             document.getElementById("customers-status"),
    searchInput:        document.getElementById("cust-search"),
    listContainer:      document.getElementById("cust-list"),
    profilePanel:       document.getElementById("cust-profile-panel"),
    profileEmpty:       document.getElementById("cust-profile-empty"),
    profileContent:     document.getElementById("cust-profile-content"),
    profileName:        document.getElementById("cust-profile-name"),
    profilePhone:       document.getElementById("cust-profile-phone"),
    profileBalance:     document.getElementById("cust-profile-balance"),
    profileClose:       document.getElementById("cust-profile-close"),
    editBtn:            document.getElementById("cust-edit-btn"),
    editForm:           document.getElementById("cust-edit-form"),
    editNameInput:      document.getElementById("cust-edit-name-input"),
    editPhoneInput:     document.getElementById("cust-edit-phone-input"),
    editBalanceInput:   document.getElementById("cust-edit-balance-input"),
    editSaveBtn:        document.getElementById("cust-edit-save-btn"),
    editCancelBtn:      document.getElementById("cust-edit-cancel-btn"),
    editStatus:         document.getElementById("cust-edit-status"),
    deleteBtn:          document.getElementById("cust-delete-btn"),
    payAmount:          document.getElementById("cust-pay-amount"),
    payNote:            document.getElementById("cust-pay-note"),
    payBtn:             document.getElementById("cust-pay-btn"),
    payStatus:          document.getElementById("cust-pay-status"),
    billsContainer:     document.getElementById("cust-bills-container"),
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function loadCustomers() {
    try { return JSON.parse(localStorage.getItem(CUSTOMERS_KEY) || "[]"); } catch (_) { return []; }
  }

  function saveCustomers(list) {
    try { localStorage.setItem(CUSTOMERS_KEY, JSON.stringify(list)); } catch (_) {}
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function fmtMoney(n) {
    var v = parseFloat(n) || 0;
    return "₹" + v.toFixed(2);
  }

  function escHtml(s) {
    return (s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    } catch (_) { return iso; }
  }

  function setPageStatus(msg, tone) {
    if (!cEl.status) return;
    cEl.status.textContent = msg || "";
    cEl.status.className = "status-message" + (tone ? " " + tone : "");
  }

  function setPayStatus(msg, tone) {
    if (!cEl.payStatus) return;
    cEl.payStatus.textContent = msg || "";
    cEl.payStatus.className = "status-message" + (tone ? " " + tone : "");
  }

  function setEditStatus(msg, tone) {
    if (!cEl.editStatus) return;
    cEl.editStatus.textContent = msg || "";
    cEl.editStatus.className = "status-message" + (tone ? " " + tone : "");
  }

  function balanceClass(bal) {
    if (bal > 0) return "is-due";
    if (bal < 0) return "is-credit";
    return "is-clear";
  }

  function balanceLabel(bal) {
    if (bal > 0) return "Due: " + fmtMoney(bal);
    if (bal < 0) return "Credit: " + fmtMoney(Math.abs(bal));
    return "Cleared";
  }

  // -------------------------------------------------------------------------
  // Customer list
  // -------------------------------------------------------------------------

  function renderCustomerList() {
    if (!cEl.listContainer) return;
    var list = loadCustomers();
    var q = cState.searchQuery.toLowerCase();
    var filtered = q
      ? list.filter(function (c) {
          return (c.name || "").toLowerCase().indexOf(q) >= 0 ||
                 (c.phone || "").indexOf(q) >= 0;
        })
      : list;

    if (!list.length) {
      cEl.listContainer.innerHTML =
        '<p class="cust-empty">No customers saved yet.<br>' +
        'Add them from the <a href="billing.html" data-nav>Billing</a> page.</p>';
      return;
    }

    if (!filtered.length) {
      cEl.listContainer.innerHTML = '<p class="cust-empty">No customers match your search.</p>';
      return;
    }

    cEl.listContainer.innerHTML = filtered.map(function (c) {
      var realIdx = list.indexOf(c);
      var bal = parseFloat(c.balance) || 0;
      return (
        '<div class="cust-card' + (cState.selectedIdx === realIdx ? " is-active" : "") +
        '" data-idx="' + realIdx + '" role="button" tabindex="0">' +
          '<div class="cust-card-main">' +
            '<span class="cust-card-name">' + escHtml(c.name) + '</span>' +
            (c.phone ? '<span class="cust-card-phone">' + escHtml(c.phone) + '</span>' : '') +
          '</div>' +
          '<span class="cust-balance-badge ' + balanceClass(bal) + '">' + balanceLabel(bal) + '</span>' +
        '</div>'
      );
    }).join("");

    cEl.listContainer.querySelectorAll(".cust-card").forEach(function (card) {
      card.addEventListener("click", function () {
        openProfile(parseInt(card.dataset.idx, 10));
      });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") openProfile(parseInt(card.dataset.idx, 10));
      });
    });
  }

  // -------------------------------------------------------------------------
  // Profile panel
  // -------------------------------------------------------------------------

  function showProfileContent(show) {
    if (cEl.profileEmpty)   cEl.profileEmpty.classList.toggle("hidden", show);
    if (cEl.profileContent) cEl.profileContent.classList.toggle("hidden", !show);
  }

  function updateBalanceDisplay(bal) {
    if (!cEl.profileBalance) return;
    cEl.profileBalance.textContent = fmtMoney(bal);
    cEl.profileBalance.className = "cust-profile-balance-value " + balanceClass(bal);
  }

  async function openProfile(idx) {
    var list = loadCustomers();
    var c = list[idx];
    if (!c) return;

    cState.selectedIdx = idx;

    if (cEl.profileName)  cEl.profileName.textContent  = c.name  || "";
    if (cEl.profilePhone) cEl.profilePhone.textContent = c.phone || "—";
    updateBalanceDisplay(parseFloat(c.balance) || 0);

    // Reset pay form and clear payment cache for this customer so history refreshes
    if (cEl.payAmount) cEl.payAmount.value = "";
    if (cEl.payNote)   cEl.payNote.value   = "";
    setPayStatus("", "");
    delete cState.allPayments[(c.name || "").toLowerCase()];

    // Hide edit form if open
    hideEditForm();

    showProfileContent(true);
    renderCustomerList();

    await loadAndRenderBills(c.name);
  }

  function closeProfile() {
    cState.selectedIdx = null;
    showProfileContent(false);
    renderCustomerList();
  }

  // -------------------------------------------------------------------------
  // Edit customer inline
  // -------------------------------------------------------------------------

  function showEditForm() {
    var list = loadCustomers();
    var c = list[cState.selectedIdx];
    if (!c) return;
    if (cEl.editNameInput)    cEl.editNameInput.value    = c.name    || "";
    if (cEl.editPhoneInput)   cEl.editPhoneInput.value   = c.phone   || "";
    if (cEl.editBalanceInput) cEl.editBalanceInput.value = parseFloat(c.balance) || 0;
    setEditStatus("", "");
    if (cEl.editForm) cEl.editForm.classList.remove("hidden");
    if (cEl.editBtn)  cEl.editBtn.textContent = "Cancel";
  }

  function hideEditForm() {
    if (cEl.editForm) cEl.editForm.classList.add("hidden");
    if (cEl.editBtn)  cEl.editBtn.textContent = "✏ Edit";
  }

  function saveEdit() {
    var name  = (cEl.editNameInput    ? cEl.editNameInput.value    : "").trim();
    var phone = (cEl.editPhoneInput   ? cEl.editPhoneInput.value   : "").trim();
    var bal   = parseFloat(cEl.editBalanceInput ? cEl.editBalanceInput.value : "0") || 0;

    if (!name) { setEditStatus("Name is required.", "is-warn"); return; }

    var list = loadCustomers();
    // Check for duplicate name (excluding current)
    var dup = list.findIndex(function (c, i) {
      return i !== cState.selectedIdx && c.name.toLowerCase() === name.toLowerCase();
    });
    if (dup >= 0) { setEditStatus("Another customer with this name already exists.", "is-warn"); return; }

    list[cState.selectedIdx].name    = name;
    list[cState.selectedIdx].phone   = phone;
    list[cState.selectedIdx].balance = bal;
    saveCustomers(list);

    if (cEl.profileName)  cEl.profileName.textContent  = name;
    if (cEl.profilePhone) cEl.profilePhone.textContent = phone || "—";
    updateBalanceDisplay(bal);

    hideEditForm();
    setEditStatus("", "");
    renderCustomerList();
  }

  // -------------------------------------------------------------------------
  // Record payment
  // -------------------------------------------------------------------------

  async function recordPayment() {
    var amt = parseFloat(cEl.payAmount ? cEl.payAmount.value : "0") || 0;
    if (amt <= 0) { setPayStatus("Enter a valid payment amount.", "is-warn"); return; }

    var list = loadCustomers();
    var c = list[cState.selectedIdx];
    if (!c) return;

    if (cEl.payBtn) { cEl.payBtn.disabled = true; cEl.payBtn.textContent = "Saving…"; }

    try {
      var note = cEl.payNote ? cEl.payNote.value.trim() : "";
      var result = await requestApi("/api/payments", {
        method: "POST",
        body: { customer_name: c.name, customer_phone: c.phone || "", amount: amt, note: note },
      });

      var prevBal = parseFloat(c.balance) || 0;
      var newBal  = round2(prevBal - amt);
      list[cState.selectedIdx].balance = newBal;
      saveCustomers(list);
      updateBalanceDisplay(newBal);

      if (cEl.payAmount) cEl.payAmount.value = "";
      if (cEl.payNote)   cEl.payNote.value   = "";

      // Update cached payments so history refreshes without re-fetch
      var custKey = c.name.toLowerCase();
      if (cState.allPayments[custKey]) {
        cState.allPayments[custKey].unshift(result.payment);
      } else {
        delete cState.allPayments[custKey]; // force re-fetch next time
      }

      setPayStatus("✓ Payment of " + fmtMoney(amt) + " saved. New balance: " + fmtMoney(newBal), "is-ok");
      renderCustomerList();
      await loadAndRenderBills(c.name);
    } catch (err) {
      setPayStatus("Could not save payment: " + (err.message || "unknown error"), "is-warn");
    } finally {
      if (cEl.payBtn) { cEl.payBtn.disabled = false; cEl.payBtn.textContent = "✔ Apply Payment"; }
    }
  }

  // -------------------------------------------------------------------------
  // Delete customer
  // -------------------------------------------------------------------------

  function deleteCustomer() {
    var list = loadCustomers();
    var c = list[cState.selectedIdx];
    if (!c) return;
    if (!window.confirm('Delete customer "' + c.name + '"? This cannot be undone.')) return;
    list.splice(cState.selectedIdx, 1);
    saveCustomers(list);
    closeProfile();
  }

  // -------------------------------------------------------------------------
  // Bill history
  // -------------------------------------------------------------------------

  async function loadAndRenderBills(customerName) {
    if (!cEl.billsContainer) return;
    cEl.billsContainer.innerHTML = '<p class="status-message is-info">Loading…</p>';

    try {
      if (cState.allBills === null) {
        var result = await requestApi("/api/bills", { method: "GET" });
        cState.allBills = result.bills || [];
      }

      var nameLower = (customerName || "").toLowerCase().trim();

      if (!cState.allPayments[nameLower]) {
        var pResult = await requestApi(
          "/api/payments?customer=" + encodeURIComponent(customerName),
          { method: "GET" }
        );
        cState.allPayments[nameLower] = pResult.payments || [];
      }

      var bills = cState.allBills.filter(function (b) {
        return (b.customer_name || "").toLowerCase().trim() === nameLower;
      });
      var payments = cState.allPayments[nameLower];

      renderHistory(bills, payments);
    } catch (err) {
      cEl.billsContainer.innerHTML =
        '<p class="status-message is-error">Could not load history: ' +
        escHtml(err.message || "Unknown error") + "</p>";
    }
  }

  function renderHistory(bills, payments) {
    if (!cEl.billsContainer) return;

    // Merge bills and payments into a single timeline sorted newest-first
    var entries = [];
    bills.forEach(function (b) {
      entries.push({ type: "bill", date: b.created_at, data: b });
    });
    (payments || []).forEach(function (p) {
      entries.push({ type: "payment", date: p.created_at, data: p });
    });
    entries.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });

    if (!entries.length) {
      cEl.billsContainer.innerHTML = '<p class="cust-empty">No bills or payments found for this customer.</p>';
      return;
    }

    var rows = entries.map(function (e) {
      if (e.type === "bill") {
        var b = e.data;
        var grandTotal = parseFloat(b.grand_total) || 0;
        var gstAmt     = parseFloat(b.gst_amount)  || 0;
        var subtotal   = parseFloat(b.subtotal)     || 0;
        return (
          "<tr>" +
            '<td><span class="bill-history-number">' + escHtml(b.bill_number || "—") + "</span></td>" +
            "<td>" + fmtDate(b.created_at) + "</td>" +
            '<td class="num-col">' + fmtMoney(subtotal) + "</td>" +
            '<td class="num-col">' + (gstAmt > 0 ? fmtMoney(gstAmt) : "—") + "</td>" +
            '<td class="num-col"><strong>' + fmtMoney(grandTotal) + "</strong></td>" +
          "</tr>"
        );
      } else {
        var p = e.data;
        var note = p.note ? " · " + escHtml(p.note) : "";
        return (
          '<tr class="payment-row">' +
            '<td><span class="payment-history-label">💳 Payment' + note + "</span></td>" +
            "<td>" + fmtDate(p.created_at) + "</td>" +
            '<td class="num-col" colspan="2" style="color:#64748b;font-size:0.82rem;">Amount received</td>' +
            '<td class="num-col" style="color:#16a34a;font-weight:600;">−' + fmtMoney(p.amount) + "</td>" +
          "</tr>"
        );
      }
    }).join("");

    cEl.billsContainer.innerHTML =
      '<div class="bill-table-scroll">' +
        '<table class="bill-items-table">' +
          "<thead><tr>" +
            "<th>Bill / Payment</th>" +
            "<th>Date</th>" +
            '<th class="num-col">Subtotal</th>' +
            '<th class="num-col">GST</th>' +
            '<th class="num-col">Total / Paid</th>' +
          "</tr></thead>" +
          "<tbody>" + rows + "</tbody>" +
        "</table>" +
      "</div>";
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  function initCustomersPage() {
    if (cState.initialized) return;
    cState.initialized = true;

    if (!isAdmin()) {
      setPageStatus("Admin access required to view customer profiles.", "is-error");
      return;
    }

    setPageStatus("", "");
    renderCustomerList();

    if (cEl.searchInput) {
      cEl.searchInput.addEventListener("input", function () {
        cState.searchQuery = cEl.searchInput.value || "";
        renderCustomerList();
      });
    }

    if (cEl.profileClose) {
      cEl.profileClose.addEventListener("click", closeProfile);
    }

    if (cEl.editBtn) {
      cEl.editBtn.addEventListener("click", function () {
        if (cEl.editForm && !cEl.editForm.classList.contains("hidden")) {
          hideEditForm();
        } else {
          showEditForm();
        }
      });
    }

    if (cEl.editSaveBtn)   cEl.editSaveBtn.addEventListener("click", saveEdit);
    if (cEl.editCancelBtn) cEl.editCancelBtn.addEventListener("click", hideEditForm);
    if (cEl.payBtn)        cEl.payBtn.addEventListener("click", recordPayment);
    if (cEl.deleteBtn)     cEl.deleteBtn.addEventListener("click", deleteCustomer);

    if (cEl.payAmount) {
      cEl.payAmount.addEventListener("keydown", function (e) {
        if (e.key === "Enter") recordPayment();
      });
    }
  }

  window.__onCustomersReady = function () {
    initCustomersPage();
  };
})();
