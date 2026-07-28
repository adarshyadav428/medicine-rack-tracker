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

  // Customers live in the `customers` table; each balance is derived by the
  // server from that customer's bills and payments. This array is a read cache
  // so the synchronous callers below keep working unchanged.
  var customerCache = [];

  function loadCustomers() {
    return customerCache;
  }

  /** Cache locally, then persist name / phone / opening balance. */
  function saveCustomers(list) {
    customerCache = Array.isArray(list) ? list : [];

    customerCache.forEach(function (c) {
      if (!c || !c.name || !String(c.name).trim()) return;
      if (c._clean && !c._dirty) return;
      c._dirty = false;
      c._clean = true;

      var body = { name: c.name, phone: c.phone || "" };
      if (c.openingBalance !== undefined && c.openingBalance !== null) {
        body.openingBalance = c.openingBalance;
      }

      requestApi("/api/customers", { method: "POST", body: body })
        .catch(function () { c._clean = false; });
    });
  }

  /** Load the list and the server-derived balances. */
  async function refreshCustomers() {
    var result = await requestApi("/api/customers", { method: "GET" });
    customerCache = (result.customers || []).map(function (c) {
      return {
        id: c.id,
        name: c.name,
        phone: c.phone || "",
        balance: parseFloat(c.balance) || 0,
        openingBalance: parseFloat(c.openingBalance) || 0,
        billCount: c.billCount || 0,
        totalBilled: parseFloat(c.totalBilled) || 0,
        totalReceived: parseFloat(c.totalReceived) || 0,
        totalPayments: parseFloat(c.totalPayments) || 0,
        _clean: true,
      };
    });
    return customerCache;
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

    var current = list[cState.selectedIdx];

    // The balance shown is derived: opening balance + everything billed, less
    // everything received. To make it read as the figure just typed, adjust
    // the opening balance by the difference — overwriting it outright would
    // silently discard every bill and payment on the account.
    var activity = round2((parseFloat(current.balance) || 0) -
                          (parseFloat(current.openingBalance) || 0));

    current.name           = name;
    current.phone          = phone;
    current.openingBalance = round2(bal - activity);
    current.balance        = bal;
    current._dirty         = true;
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
      updateBalanceDisplay(newBal); // optimistic; the refresh below confirms it

      try {
        await refreshCustomers();
        var fresh = customerCache.find(function (x) {
          return x.name.toLowerCase().trim() === c.name.toLowerCase().trim();
        });
        if (fresh) {
          newBal = fresh.balance;
          updateBalanceDisplay(newBal);
        }
      } catch (_) { /* keep the optimistic figure */ }

      if (cEl.payAmount) cEl.payAmount.value = "";
      if (cEl.payNote)   cEl.payNote.value   = "";

      // Update cached payments so history refreshes without re-fetch
      var custKey = c.name.toLowerCase();
      if (cState.allPayments[custKey]) {
        cState.allPayments[custKey].unshift(result.payment);
      } else {
        delete cState.allPayments[custKey];
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
    requestApi("/api/customers?name=" + encodeURIComponent(c.name), { method: "DELETE" })
      .catch(function () {});
    list.splice(cState.selectedIdx, 1);
    customerCache = list;
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
        var result = await requestApi("/api/bills?all=1", { method: "GET" });
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
            "<td></td>" +
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
            '<td><button class="btn btn-danger btn-xs" data-del-payment="' + escHtml(p.id) +
              '" data-amount="' + escHtml(String(p.amount)) +
              '" title="Delete this payment" type="button">🗑️</button></td>' +
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
            "<th></th>" +
          "</tr></thead>" +
          "<tbody>" + rows + "</tbody>" +
        "</table>" +
      "</div>";

    cEl.billsContainer.querySelectorAll("[data-del-payment]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        deletePayment(btn.dataset.delPayment, btn.dataset.amount);
      });
    });
  }

  /** Remove a payment entered by mistake and re-derive the balance. */
  async function deletePayment(paymentId, amountLabel) {
    if (!paymentId) return;
    if (!window.confirm(
      "Delete this payment of " + fmtMoney(amountLabel) +
      "? The customer's balance will go back up by that amount."
    )) return;

    setPayStatus("Deleting payment…", "is-info");

    try {
      await requestApi("/api/payments?id=" + encodeURIComponent(paymentId), { method: "DELETE" });

      var list = loadCustomers();
      var c = list[cState.selectedIdx];

      // Drop the cached payments for this customer so the history re-fetches.
      if (c) delete cState.allPayments[c.name.toLowerCase().trim()];

      await refreshCustomers();
      renderCustomerList();

      var fresh = c && loadCustomers().find(function (x) {
        return x.name.toLowerCase().trim() === c.name.toLowerCase().trim();
      });
      if (fresh) updateBalanceDisplay(fresh.balance);

      setPayStatus("Payment deleted.", "is-ok");
      if (c) await loadAndRenderBills(c.name);
    } catch (err) {
      setPayStatus("Could not delete payment: " + (err.message || "unknown error"), "is-warn");
    }
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // One-time import of balances that used to live in this browser
  //
  // Balances now live in the database. Any customer still carrying a balance in
  // this browser's localStorage is offered as an import so nothing is lost when
  // switching over. Runs once per browser.
  // -------------------------------------------------------------------------
  var IMPORT_DONE_KEY = "medicineRackTracker.balancesImported.v1";

  function readLegacyCustomers() {
    try { return JSON.parse(localStorage.getItem(CUSTOMERS_KEY) || "[]"); } catch (_) { return []; }
  }

  function offerLocalImport() {
    if (localStorage.getItem(IMPORT_DONE_KEY)) return;

    var legacy = readLegacyCustomers().filter(function (c) {
      return c && String(c.name || "").trim() && (parseFloat(c.balance) || 0) !== 0;
    });
    if (!legacy.length) {
      try { localStorage.setItem(IMPORT_DONE_KEY, "1"); } catch (_) {}
      return;
    }

    // Only import customers whose balance the database doesn't already explain,
    // so running this twice can't double anyone's opening amount.
    var pending = legacy.filter(function (c) {
      var match = customerCache.find(function (x) {
        return x.name.toLowerCase().trim() === String(c.name).toLowerCase().trim();
      });
      return !match || match.openingBalance === 0;
    });
    if (!pending.length) {
      try { localStorage.setItem(IMPORT_DONE_KEY, "1"); } catch (_) {}
      return;
    }

    var total = pending.reduce(function (sum, c) { return sum + (parseFloat(c.balance) || 0); }, 0);

    if (!window.confirm(
      "This browser still has saved balances for " + pending.length + " customer(s), " +
      "totalling " + fmtMoney(total) + ".\n\n" +
      "Import them into the database as opening balances so every device sees them?\n\n" +
      "Do this on ONE device only — importing again elsewhere would add the amounts twice."
    )) {
      return; // ask again next time
    }

    requestApi("/api/customers", {
      method: "PUT",
      body: {
        customers: pending.map(function (c) {
          return {
            name: c.name,
            phone: c.phone || "",
            // The old running balance becomes the opening anchor; bills already
            // in the database then chain forward from it.
            openingBalance: parseFloat(c.balance) || 0,
          };
        }),
      },
    })
      .then(function (result) {
        try { localStorage.setItem(IMPORT_DONE_KEY, "1"); } catch (_) {}
        setPageStatus("✅ Imported balances for " + result.imported + " customer(s).", "is-ok");
        return refreshCustomers().then(renderCustomerList);
      })
      .catch(function (err) {
        setPageStatus("Import failed: " + (err.message || "Unknown error"), "is-error");
      });
  }

  function initCustomersPage() {
    if (cState.initialized) return;
    cState.initialized = true;

    if (!isAdmin()) {
      setPageStatus("Admin access required to view customer profiles.", "is-error");
      return;
    }

    setPageStatus("Loading customers…", "is-info");
    renderCustomerList();

    refreshCustomers()
      .then(function () {
        setPageStatus("", "");
        renderCustomerList();
        offerLocalImport();
      })
      .catch(function (err) {
        setPageStatus(
          "Could not load customers: " + (err.message || "Unknown error") +
            " — if this is the first run, make sure add-db-balances.sql has been applied.",
          "is-error"
        );
      });

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
