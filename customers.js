/**
 * Customer accounts. Financial values come from the server; local state owns
 * selection and drafts, never a running balance that can be written implicitly.
 */
(function () {
  "use strict";

  if (document.body.dataset.page !== "customers") return;

  var CUSTOMERS_KEY = "medicineRackTracker.customers.v1";
  var IMPORT_DONE_KEY = "medicineRackTracker.balancesImported.v1";
  var customerCache = [];
  var pendingOperations = new Map();
  var completedOperations = new Set();
  var cState = {
    initialized: false,
    selectedKey: null,
    searchQuery: "",
    customerReadSeq: 0,
    profileSeq: 0,
    historySeq: 0,
    profileLoading: false,
    historyOwner: null,
    historyPayments: [],
    editSnapshot: null,
    editInFlight: false,
    paymentInFlight: false,
    deleteInFlight: false,
    refreshQueued: false,
  };
  var cEl = {
    status: document.getElementById("customers-status"),
    searchInput: document.getElementById("cust-search"),
    listContainer: document.getElementById("cust-list"),
    profilePanel: document.getElementById("cust-profile-panel"),
    profileEmpty: document.getElementById("cust-profile-empty"),
    profileContent: document.getElementById("cust-profile-content"),
    profileName: document.getElementById("cust-profile-name"),
    profilePhone: document.getElementById("cust-profile-phone"),
    profileBalance: document.getElementById("cust-profile-balance"),
    profileClose: document.getElementById("cust-profile-close"),
    editBtn: document.getElementById("cust-edit-btn"),
    editForm: document.getElementById("cust-edit-form"),
    editNameInput: document.getElementById("cust-edit-name-input"),
    editPhoneInput: document.getElementById("cust-edit-phone-input"),
    editBalanceInput: document.getElementById("cust-edit-balance-input"),
    editSaveBtn: document.getElementById("cust-edit-save-btn"),
    editCancelBtn: document.getElementById("cust-edit-cancel-btn"),
    editStatus: document.getElementById("cust-edit-status"),
    deleteBtn: document.getElementById("cust-delete-btn"),
    payAmount: document.getElementById("cust-pay-amount"),
    payNote: document.getElementById("cust-pay-note"),
    payBtn: document.getElementById("cust-pay-btn"),
    payStatus: document.getElementById("cust-pay-status"),
    billsContainer: document.getElementById("cust-bills-container"),
  };

  function nameKey(name) { return String(name || "").trim().toLowerCase(); }
  function customerKey(c) { return c && c.id ? "id:" + c.id : "name:" + nameKey(c && c.name); }
  function selectedCustomer() {
    return customerCache.find(function (c) { return customerKey(c) === cState.selectedKey; }) || null;
  }
  function sameCustomer(a, b) {
    return !!a && !!b && (a.id && b.id ? a.id === b.id : nameKey(a.name) === nameKey(b.name));
  }
  function isSelected(c) { return sameCustomer(c, selectedCustomer()); }
  function findCustomer(reference) {
    return customerCache.find(function (c) { return sameCustomer(c, reference); }) || null;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function moneyValue(value) {
    var text = String(value == null ? "" : value).trim();
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) return null;
    var number = Number(text);
    return Number.isFinite(number) && Math.abs(number) <= 99999999.99 ? round2(number) : null;
  }
  function fmtMoney(n) { return "₹" + Number(n || 0).toFixed(2); }
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtDate(iso) {
    var date = new Date(iso);
    return Number.isFinite(date.getTime())
      ? date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
      : "—";
  }
  function status(el, message, tone) {
    if (!el) return;
    el.textContent = message || "";
    el.className = "status-message" + (tone ? " " + tone : "");
  }
  function setPageStatus(message, tone) { status(cEl.status, message, tone); }
  function setPayStatus(message, tone) { status(cEl.payStatus, message, tone); }
  function setEditStatus(message, tone) { status(cEl.editStatus, message, tone); }
  function normalizeCustomer(c) {
    return {
      id: c.id || c.customer_id || c.customerId || null,
      name: String(c.name || "").trim(),
      phone: String(c.phone || ""),
      balance: Number(c.balance) || 0,
      openingBalance: Number(c.openingBalance !== undefined ? c.openingBalance : c.opening_balance) || 0,
      billCount: Number(c.billCount) || 0,
      totalBilled: Number(c.totalBilled) || 0,
      totalReceived: Number(c.totalReceived) || 0,
      totalPayments: Number(c.totalPayments) || 0,
      version: c.version !== undefined ? c.version : (c.updatedAt || c.updated_at || null),
      archived: !!c.archived,
    };
  }
  function installCustomer(snapshot, original) {
    var saved = normalizeCustomer(snapshot);
    var idx = customerCache.findIndex(function (c) { return sameCustomer(c, original || saved); });
    var wasSelected = original ? isSelected(original) : isSelected(saved);
    if (idx < 0) customerCache.push(saved);
    else customerCache[idx] = saved;
    customerCache.sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (wasSelected) cState.selectedKey = customerKey(saved);
    return saved;
  }
  async function refreshCustomers() {
    var seq = ++cState.customerReadSeq;
    var result = await requestApi("/api/customers?includeArchived=1", { method: "GET" });
    if (seq !== cState.customerReadSeq) return customerCache;
    var selected = selectedCustomer();
    customerCache = (result.customers || []).map(normalizeCustomer);
    if (selected) {
      var resolved = findCustomer(selected);
      cState.selectedKey = resolved ? customerKey(resolved) : null;
    }
    return customerCache;
  }
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (char) {
      var value = Math.floor(Math.random() * 16);
      return (char === "x" ? value : ((value & 3) | 8)).toString(16);
    });
  }
  async function fingerprint(value) {
    var text = JSON.stringify(value);
    if (window.crypto && window.crypto.subtle && typeof TextEncoder !== "undefined") {
      var digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return Array.from(new Uint8Array(digest)).map(function (n) { return n.toString(16).padStart(2, "0"); }).join("");
    }
    // Storage holds only an opaque fingerprint and operation ID, not names or notes.
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return String(hash >>> 0) + ":" + text.length;
  }
  async function operationId(scope, payload) {
    // Memory preserves same-screen retries if browser storage is unavailable.
    // Reload recovery depends on retaining this opaque reference in site storage.
    var signature = await fingerprint(payload);
    var key = "medicineRackTracker.pending." + scope + ".v1." + signature;
    var pending = pendingOperations.get(key);
    if (!pending) {
      try { pending = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) {}
    }
    if (!pending || pending.fingerprint !== signature || completedOperations.has(pending.id)) pending = { fingerprint: signature, id: uuid() };
    pending.scope = scope;
    pending.storageKey = key;
    pendingOperations.set(key, pending);
    try { localStorage.setItem(key, JSON.stringify({ fingerprint: signature, id: pending.id })); } catch (_) {}
    return pending.id;
  }
  function finishOperation(scope, id) {
    var pending;
    pendingOperations.forEach(function (candidate) {
      if (candidate.scope === scope && candidate.id === id) pending = candidate;
    });
    if (!pending || pending.id !== id) return;
    completedOperations.add(id);
    pendingOperations.delete(pending.storageKey);
    try {
      var stored = JSON.parse(localStorage.getItem(pending.storageKey) || "null");
      if (stored && stored.id === id) localStorage.removeItem(pending.storageKey);
    } catch (_) {}
  }
  function balanceClass(n) { return n > 0 ? "is-due" : n < 0 ? "is-credit" : "is-clear"; }
  function balanceLabel(n) {
    return n > 0 ? "Due: " + fmtMoney(n) : n < 0 ? "Credit: " + fmtMoney(-n) : "Cleared";
  }
  function updateBalanceDisplay(balance) {
    if (!cEl.profileBalance) return;
    cEl.profileBalance.textContent = fmtMoney(balance);
    cEl.profileBalance.className = "cust-profile-balance-value " + balanceClass(balance);
  }
  function renderProfile(c) {
    if (!c || !isSelected(c)) return;
    if (cEl.profileName) cEl.profileName.textContent = c.name + (c.archived ? " (archived)" : "");
    if (cEl.profilePhone) cEl.profilePhone.textContent = c.phone || "—";
    updateBalanceDisplay(c.balance);
    updateButtons();
  }
  function updateButtons() {
    var c = selectedCustomer();
    if (cEl.payBtn) {
      cEl.payBtn.disabled = !c || c.archived || cState.profileLoading || cState.paymentInFlight || cState.editInFlight || cState.deleteInFlight;
      cEl.payBtn.textContent = cState.paymentInFlight ? "Saving…" : "✔ Apply Payment";
    }
    if (cEl.editBtn) cEl.editBtn.disabled = !c || c.archived || cState.profileLoading || cState.editInFlight;
    if (cEl.editSaveBtn) cEl.editSaveBtn.disabled = !!(c && c.archived) || cState.editInFlight || cState.paymentInFlight || cState.deleteInFlight;
    if (cEl.editCancelBtn) cEl.editCancelBtn.disabled = cState.editInFlight;
    if (cEl.deleteBtn) {
      cEl.deleteBtn.disabled = !c || cState.profileLoading || cState.deleteInFlight || cState.paymentInFlight || cState.editInFlight;
      cEl.deleteBtn.textContent = c && c.archived ? "Restore" : "Archive";
    }
  }
  function renderCustomerList() {
    if (!cEl.listContainer) return;
    var query = cState.searchQuery.toLowerCase();
    var filtered = customerCache.filter(function (c) {
      if (c.archived && !query && !isSelected(c)) return false;
      return !query || c.name.toLowerCase().indexOf(query) >= 0 || c.phone.indexOf(query) >= 0;
    });
    if (!filtered.length) {
      cEl.listContainer.innerHTML = '<p class="cust-empty">' +
        (query ? "No customers match your search." : customerCache.length
          ? "No active customers. Search by name to view an archived account."
          : 'No customers saved yet.<br>Add them from the <a href="billing.html" data-nav>Billing</a> page.') + "</p>";
      return;
    }
    cEl.listContainer.innerHTML = filtered.map(function (c) {
      return '<div class="cust-card' + (isSelected(c) ? " is-active" : "") +
        '" data-key="' + escHtml(customerKey(c)) + '" role="button" tabindex="0">' +
        '<div class="cust-card-main"><span class="cust-card-name">' + escHtml(c.name) +
        (c.archived ? " (archived)" : "") + "</span>" +
        (c.phone ? '<span class="cust-card-phone">' + escHtml(c.phone) + "</span>" : "") +
        '</div><span class="cust-balance-badge ' + balanceClass(c.balance) + '">' +
        balanceLabel(c.balance) + "</span></div>";
    }).join("");
    cEl.listContainer.querySelectorAll(".cust-card").forEach(function (card) {
      card.addEventListener("click", function () { openProfile(card.dataset.key); });
      card.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openProfile(card.dataset.key);
        }
      });
    });
  }
  function showProfileContent(show) {
    if (cEl.profileEmpty) cEl.profileEmpty.classList.toggle("hidden", show);
    if (cEl.profileContent) cEl.profileContent.classList.toggle("hidden", !show);
  }
  function hideEditForm() {
    cState.editSnapshot = null;
    if (cEl.editForm) cEl.editForm.classList.add("hidden");
    if (cEl.editBtn) cEl.editBtn.textContent = "✏ Edit";
  }
  async function openProfile(key, preserveForms) {
    var c = customerCache.find(function (row) { return customerKey(row) === key; });
    if (!c) return;
    cState.selectedKey = key;
    var seq = ++cState.profileSeq;
    ++cState.historySeq;
    cState.historyOwner = null;
    cState.historyPayments = [];
    cState.profileLoading = true;
    if (!preserveForms) {
      hideEditForm();
      if (cEl.payAmount) cEl.payAmount.value = "";
      if (cEl.payNote) cEl.payNote.value = "";
      setPayStatus("", "");
    }
    showProfileContent(true);
    renderProfile(c);
    renderCustomerList();
    if (cEl.billsContainer) cEl.billsContainer.innerHTML = '<p class="status-message is-info">Refreshing account…</p>';
    try {
      await refreshCustomers();
      if (seq !== cState.profileSeq) return;
      var fresh = selectedCustomer();
      if (!fresh) {
        closeProfile();
        setPageStatus("This customer is no longer available. Refresh the list.", "is-warn");
        return;
      }
      renderProfile(fresh);
      renderCustomerList();
      await loadAndRenderBills(fresh, seq);
    } catch (error) {
      if (seq !== cState.profileSeq) return;
      setPageStatus("Could not refresh this account: " + (error.message || "Unknown error"), "is-error");
      if (cEl.billsContainer) cEl.billsContainer.innerHTML = '<p class="status-message is-error">Account freshness could not be confirmed. Reopen the profile to retry.</p>';
    } finally {
      if (seq === cState.profileSeq) {
        cState.profileLoading = false;
        updateButtons();
        if (cState.refreshQueued) {
          cState.refreshQueued = false;
          refreshSelectedProfile();
        }
      }
    }
  }
  function closeProfile() {
    cState.selectedKey = null;
    ++cState.profileSeq;
    ++cState.historySeq;
    cState.historyOwner = null;
    cState.historyPayments = [];
    cState.profileLoading = false;
    hideEditForm();
    showProfileContent(false);
    renderCustomerList();
    updateButtons();
  }
  function refreshSelectedProfile(queueIfLoading) {
    if (cState.profileLoading) {
      if (queueIfLoading === true) cState.refreshQueued = true;
      return;
    }
    if (cState.paymentInFlight || cState.editInFlight || cState.deleteInFlight) return;
    var c = selectedCustomer();
    if (c) return openProfile(customerKey(c), true);
    return refreshCustomers().then(renderCustomerList).catch(function (error) {
      setPageStatus("Could not refresh customers: " + error.message, "is-warn");
    });
  }
  function showEditForm() {
    var c = selectedCustomer();
    if (!c || c.archived || cState.profileLoading) return;
    cState.editSnapshot = { customer: Object.assign({}, c), balanceDirty: false };
    if (cEl.editNameInput) cEl.editNameInput.value = c.name;
    if (cEl.editPhoneInput) cEl.editPhoneInput.value = c.phone;
    if (cEl.editBalanceInput) cEl.editBalanceInput.value = String(c.balance);
    setEditStatus("", "");
    if (cEl.editForm) cEl.editForm.classList.remove("hidden");
    if (cEl.editBtn) cEl.editBtn.textContent = "Cancel";
  }
  async function saveEdit() {
    if (cState.editInFlight || cState.paymentInFlight || cState.deleteInFlight) return;
    var draft = cState.editSnapshot;
    if (!draft || !isSelected(draft.customer) || selectedCustomer().archived) return;
    var name = String(cEl.editNameInput ? cEl.editNameInput.value : "").trim();
    var phone = String(cEl.editPhoneInput ? cEl.editPhoneInput.value : "").trim();
    if (!name) { setEditStatus("Name is required.", "is-warn"); return; }
    if (customerCache.some(function (c) { return !sameCustomer(c, draft.customer) && nameKey(c.name) === nameKey(name); })) {
      setEditStatus("Another customer with this name already exists.", "is-warn");
      return;
    }
    var body = { id: draft.customer.id, originalName: draft.customer.name, name: name, phone: phone };
    cState.editInFlight = true;
    setEditStatus("Saving changes…", "is-info");
    updateButtons();
    var op;
    try {
      if (draft.balanceDirty) {
        var desired = moneyValue(cEl.editBalanceInput ? cEl.editBalanceInput.value : "");
        if (desired === null) throw new Error("Enter a valid balance with no more than two decimal places.");
        await refreshCustomers();
        if (cState.editSnapshot !== draft || !isSelected(draft.customer)) return;
        var fresh = findCustomer(draft.customer);
        if (!fresh || Math.abs(fresh.balance - draft.customer.balance) > 0.005 ||
            Math.abs(fresh.openingBalance - draft.customer.openingBalance) > 0.005 ||
            (draft.customer.version != null && fresh.version !== draft.customer.version)) {
          throw new Error("This account changed while Edit was open. Cancel and reopen Edit to review the current balance.");
        }
        body.openingBalance = round2(desired - (draft.customer.balance - draft.customer.openingBalance));
        body.expectedBalance = draft.customer.balance;
        body.expectedOpeningBalance = draft.customer.openingBalance;
        if (draft.customer.version != null) body.expectedVersion = draft.customer.version;
      }
      op = await operationId("customer-edit", body);
      body.operationId = op;
      var result = await requestApi("/api/customers", { method: "POST", body: body });
      if (!result.customer) throw new Error("The server did not confirm the customer save. Retry without changing the form.");
      finishOperation("customer-edit", op);
      if (cState.editSnapshot !== draft || !isSelected(draft.customer)) {
        await refreshCustomers();
        renderCustomerList();
        setPageStatus("Customer changes for " + name + " were saved.", "is-ok");
        return;
      }
      var saved;
      try {
        if (Number.isFinite(Number(result.customer.balance))) saved = installCustomer(result.customer, draft.customer);
        else {
          await refreshCustomers();
          saved = findCustomer({ id: result.customer.id || draft.customer.id, name: name });
        }
        if (cState.editSnapshot === draft && saved) {
          cState.selectedKey = customerKey(saved);
          renderProfile(saved);
          hideEditForm();
          setPageStatus("Customer changes saved.", "is-ok");
          renderCustomerList();
          await loadAndRenderBills(saved, cState.profileSeq);
        }
      } catch (refreshError) {
        if (cState.editSnapshot === draft) {
          hideEditForm();
          setPageStatus("Customer changes were saved, but the account could not be refreshed: " + refreshError.message, "is-warn");
        }
      }
    } catch (error) {
      if (cState.editSnapshot === draft) setEditStatus("Could not save changes: " + (error.message || "Unknown error"), "is-warn");
    } finally {
      cState.editInFlight = false;
      updateButtons();
    }
  }

  async function loadAndRenderBills(customer, profileSeq) {
    if (!cEl.billsContainer || !isSelected(customer)) return false;
    var requestSeq = ++cState.historySeq;
    var owner = customerKey(customer);
    cState.historyOwner = null;
    cState.historyPayments = [];
    cEl.billsContainer.innerHTML = '<p class="status-message is-info">Loading history…</p>';
    var params = "customer=" + encodeURIComponent(customer.name);
    if (customer.id) params += "&customerId=" + encodeURIComponent(customer.id);
    try {
      var pair = await Promise.all([
        requestApi("/api/bills?" + params, { method: "GET" }),
        requestApi("/api/payments?" + params, { method: "GET" }),
      ]);
      if (requestSeq !== cState.historySeq || profileSeq !== cState.profileSeq || !isSelected(customer)) return false;
      var bills = Array.isArray(pair[0].bills) ? pair[0].bills : [];
      var payments = Array.isArray(pair[1].payments) ? pair[1].payments : [];
      cState.historyOwner = owner;
      cState.historyPayments = payments;
      renderHistory(bills, payments, customer);
      return true;
    } catch (error) {
      if (requestSeq !== cState.historySeq || profileSeq !== cState.profileSeq || !isSelected(customer)) return false;
      cEl.billsContainer.innerHTML = '<p class="status-message is-error">Could not load history: ' +
        escHtml(error.message || "Unknown error") + "</p>";
      return false;
    }
  }
  function renderHistory(bills, payments, customer) {
    var entries = bills.map(function (b) { return { type: "bill", date: b.created_at, id: b.id, data: b }; })
      .concat(payments.map(function (p) { return { type: "payment", date: p.created_at, id: p.id, data: p }; }));
    entries.sort(function (a, b) {
      var byDate = String(b.date || "").localeCompare(String(a.date || ""));
      if (byDate) return byDate;
      var left = String(a.data.ledger_sequence || "0").replace(/^0+(?=\d)/, "");
      var right = String(b.data.ledger_sequence || "0").replace(/^0+(?=\d)/, "");
      var bySequence = right.length - left.length || right.localeCompare(left);
      return bySequence || String(b.id || "").localeCompare(String(a.id || ""));
    });
    if (!entries.length) {
      cEl.billsContainer.innerHTML = '<p class="cust-empty">No bills or payments found for this customer.</p>';
      return;
    }
    var rows = entries.map(function (entry) {
      var data = entry.data;
      if (entry.type === "bill") {
        var received = Number(data.amount_received) || 0;
        var total = Number(data.grand_total) || 0;
        return '<tr><td><span class="bill-history-number">' + escHtml(data.bill_number || "—") +
          "</span></td><td>" + fmtDate(data.created_at) + '</td><td class="num-col">' +
          fmtMoney(data.subtotal) + '</td><td class="num-col">' + fmtMoney(data.gst_amount) +
          '</td><td class="num-col">' + fmtMoney(total) + '</td><td class="num-col">' +
          fmtMoney(received) + '</td><td class="num-col"><strong>' + fmtMoney(round2(total - received)) +
          "</strong></td><td></td></tr>";
      }
      var amount = Number(data.amount) || 0;
      return '<tr class="payment-row"><td><span class="payment-history-label">💳 Payment' +
        (data.note ? " · " + escHtml(data.note) : "") + "</span></td><td>" + fmtDate(data.created_at) +
        '</td><td>—</td><td>—</td><td>—</td><td class="num-col">' + fmtMoney(amount) +
        '</td><td class="num-col">−' + fmtMoney(amount) + '</td><td><button class="btn btn-danger btn-xs" data-del-payment="' +
        escHtml(data.id) + '" data-amount="' + escHtml(String(amount)) +
        '" title="Delete this payment" type="button"' + (customer.archived ? " disabled" : "") + '>🗑️</button></td></tr>';
    }).join("");
    cEl.billsContainer.innerHTML = '<div class="bill-table-scroll"><table class="bill-items-table"><thead><tr>' +
      "<th>Bill / Payment</th><th>Date</th><th>Subtotal</th><th>GST</th><th>Bill total</th><th>Received</th><th>Net change</th><th></th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>";
    cEl.billsContainer.querySelectorAll("[data-del-payment]").forEach(function (button) {
      button.addEventListener("click", function () { deletePayment(button.dataset.delPayment, button.dataset.amount, customer); });
    });
  }

  async function refreshAfterPayment(customer, result) {
    if (result.customer && Number.isFinite(Number(result.customer.balance))) installCustomer(result.customer, customer);
    else await refreshCustomers();
    renderCustomerList();
    var fresh = findCustomer(result.customer || customer);
    if (fresh && isSelected(fresh)) {
      renderProfile(fresh);
      return loadAndRenderBills(fresh, cState.profileSeq);
    }
    return true;
  }
  async function recordPayment() {
    if (cState.paymentInFlight || cState.editInFlight || cState.deleteInFlight || cState.profileLoading) return;
    var c = selectedCustomer();
    if (!c || c.archived) return;
    var amount = moneyValue(cEl.payAmount ? cEl.payAmount.value : "");
    if (amount === null || amount <= 0) { setPayStatus("Enter a positive amount with no more than two decimal places.", "is-warn"); return; }
    var note = String(cEl.payNote ? cEl.payNote.value : "").trim();
    var profileSeq = cState.profileSeq;
    var body = { amount: amount, note: note };
    if (c.id) body.customer_id = c.id;
    else { body.customer_name = c.name; body.customer_phone = c.phone; }
    cState.paymentInFlight = true;
    updateButtons();
    var result, op;
    try {
      op = await operationId("payment", body);
      body.operationId = op;
      result = await requestApi("/api/payments", { method: "POST", body: body });
      if (!result.payment || !result.payment.id) throw new Error("The server did not confirm this receipt.");
      finishOperation("payment", op);
    } catch (error) {
      if (profileSeq === cState.profileSeq && isSelected(c)) setPayStatus("Payment was not confirmed: " + (error.message || "Unknown error") +
        ". Retry the same entry to check it safely; do not enter it as a new payment.", "is-warn");
      cState.paymentInFlight = false;
      updateButtons();
      return;
    }
    if (profileSeq !== cState.profileSeq || !isSelected(c)) {
      cState.paymentInFlight = false;
      updateButtons();
      setPageStatus("Payment of " + fmtMoney(amount) + " for " + c.name + " was saved.", "is-ok");
      await refreshSelectedProfile(true);
      return;
    }
    // The write is confirmed. Display/refresh failures cannot turn it into a failed payment.
    if (isSelected(c)) {
      if (cEl.payAmount && moneyValue(cEl.payAmount.value) === amount) cEl.payAmount.value = "";
      if (cEl.payNote && String(cEl.payNote.value).trim() === note) cEl.payNote.value = "";
      setPayStatus("✓ Payment of " + fmtMoney(amount) + " saved.", "is-ok");
    }
    try {
      var complete = await refreshAfterPayment(c, result);
      if (!complete && isSelected(c)) setPayStatus("Payment of " + fmtMoney(amount) +
        " was saved. History could not be refreshed; reopen this account to retry the refresh.", "is-warn");
    } catch (error) {
      if (isSelected(c)) setPayStatus("Payment of " + fmtMoney(amount) +
        " was saved, but the account could not be refreshed: " + error.message, "is-warn");
    } finally {
      cState.paymentInFlight = false;
      updateButtons();
    }
  }
  async function deletePayment(id, amountLabel, customer) {
    if (cState.deleteInFlight || cState.paymentInFlight || cState.editInFlight || !customer || customer.archived || !isSelected(customer) ||
        cState.historyOwner !== customerKey(customer) || !cState.historyPayments.some(function (p) { return p.id === id; })) return;
    if (!window.confirm("Delete this payment of " + fmtMoney(amountLabel) + "? The customer's balance will increase by that amount.")) return;
    cState.deleteInFlight = true;
    updateButtons();
    var op, result, profileSeq = cState.profileSeq;
    try {
      op = await operationId("payment-delete", { id: id, customerId: customer.id, customer: customer.name });
      var query = "id=" + encodeURIComponent(id) + "&operationId=" + encodeURIComponent(op);
      if (customer.id) query += "&customerId=" + encodeURIComponent(customer.id);
      result = await requestApi("/api/payments?" + query, { method: "DELETE" });
      finishOperation("payment-delete", op);
    } catch (error) {
      if (profileSeq === cState.profileSeq && isSelected(customer)) setPayStatus("Payment deletion was not confirmed: " + error.message + ". Retry to check safely.", "is-warn");
      cState.deleteInFlight = false;
      updateButtons();
      return;
    }
    if (profileSeq !== cState.profileSeq || !isSelected(customer)) {
      cState.deleteInFlight = false;
      updateButtons();
      setPageStatus("Payment for " + customer.name + " was deleted.", "is-ok");
      await refreshSelectedProfile(true);
      return;
    }
    if (isSelected(customer)) setPayStatus("Payment deleted.", "is-ok");
    try {
      var complete = await refreshAfterPayment(customer, result);
      if (!complete && isSelected(customer)) setPayStatus("Payment was deleted. History could not be refreshed.", "is-warn");
    } catch (error) {
      if (isSelected(customer)) setPayStatus("Payment was deleted, but the account could not be refreshed: " + error.message, "is-warn");
    } finally {
      cState.deleteInFlight = false;
      updateButtons();
    }
  }
  async function deleteCustomer() {
    var c = selectedCustomer();
    if (!c || cState.deleteInFlight || cState.paymentInFlight || cState.editInFlight) return;
    if (c.archived) return restoreCustomer(c);
    if (!window.confirm('Archive customer "' + c.name + '"? Their balance, bills and payments will be kept.')) return;
    cState.deleteInFlight = true;
    updateButtons();
    var op;
    try {
      op = await operationId("customer-archive", { id: c.id, name: c.name });
      var query = c.id ? "id=" + encodeURIComponent(c.id) : "name=" + encodeURIComponent(c.name);
      await requestApi("/api/customers?" + query + "&operationId=" + encodeURIComponent(op), { method: "DELETE" });
      finishOperation("customer-archive", op);
    } catch (error) {
      if (isSelected(c)) setPayStatus("Could not archive customer: " + error.message, "is-warn");
      cState.deleteInFlight = false;
      updateButtons();
      return;
    }
    if (isSelected(c)) closeProfile();
    try {
      await refreshCustomers();
      renderCustomerList();
      setPageStatus("Customer archived. Their financial history and balance are preserved.", "is-ok");
    } catch (error) {
      setPageStatus("Customer was archived, but the list could not be refreshed: " + error.message, "is-warn");
    } finally {
      cState.deleteInFlight = false;
      updateButtons();
    }
  }

  async function restoreCustomer(customer) {
    if (!window.confirm('Restore customer "' + customer.name + '" for billing and payments? Their balance and history will be unchanged.')) return;
    cState.deleteInFlight = true;
    updateButtons();
    var body = { id: customer.id, originalName: customer.name, name: customer.name,
      phone: customer.phone, restore: true };
    if (customer.version != null) body.expectedVersion = customer.version;
    var op, result;
    try {
      op = await operationId("customer-restore", body);
      body.operationId = op;
      result = await requestApi("/api/customers", { method: "POST", body: body });
      if (!result.customer) throw new Error("The server did not confirm the restore. Refresh to check this account.");
      finishOperation("customer-restore", op);
    } catch (error) {
      if (isSelected(customer)) setPayStatus("Restore was not confirmed: " + error.message, "is-warn");
      cState.deleteInFlight = false;
      updateButtons();
      return;
    }
    try {
      await refreshCustomers();
      renderCustomerList();
      var fresh = findCustomer(customer);
      if (fresh && isSelected(fresh)) {
        renderProfile(fresh);
        setPayStatus("Customer restored. Their balance and history are unchanged.", "is-ok");
        await loadAndRenderBills(fresh, cState.profileSeq);
      }
      setPageStatus("Customer restored for billing and payments.", "is-ok");
    } catch (error) {
      setPageStatus("Customer was restored, but the account could not be refreshed: " + error.message, "is-warn");
    } finally {
      cState.deleteInFlight = false;
      updateButtons();
    }
  }

  function readLegacyCustomers() {
    try {
      var list = JSON.parse(localStorage.getItem(CUSTOMERS_KEY) || "[]");
      return Array.isArray(list) ? list : null;
    } catch (_) { return null; }
  }
  async function offerLocalImport() {
    if (localStorage.getItem(IMPORT_DONE_KEY)) return;
    var legacyRows = readLegacyCustomers();
    if (!legacyRows) {
      setPageStatus("Saved browser balances could not be read. They have been kept for manual review.", "is-warn");
      return;
    }
    var seen = new Map();
    var conflicts = new Set();
    var invalid = 0;
    var pending = [];
    legacyRows.forEach(function (legacy) {
      var key = nameKey(legacy && legacy.name);
      var balance = moneyValue(legacy && legacy.balance);
      if (!key || balance === null) { invalid += 1; return; }
      if (seen.has(key)) {
        if (seen.get(key) !== balance) { conflicts.add(key); invalid += 1; }
        return;
      }
      seen.set(key, balance);
      if (balance === 0) return;
      var match = customerCache.find(function (c) { return nameKey(c.name) === key; });
      if (match && (match.archived || match.openingBalance !== 0 || Math.abs(match.balance - balance) < 0.005)) return;
      pending.push({
        name: match ? match.name : String(legacy.name).trim(), phone: match && match.phone ? match.phone : String(legacy.phone || ""),
        balance: balance,
        expectedBalance: match ? match.balance : 0,
        expectedOpeningBalance: match ? match.openingBalance : 0,
        expectedVersion: match ? match.version : null,
      });
    });
    pending = pending.filter(function (entry) { return !conflicts.has(nameKey(entry.name)); });
    if (!pending.length) {
      if (invalid) {
        setPageStatus("Some saved browser balances are invalid or conflict. They have been kept for manual review.", "is-warn");
        return;
      }
      try { localStorage.setItem(IMPORT_DONE_KEY, "1"); } catch (_) {}
      return;
    }
    var preview = pending.slice(0, 10).map(function (c) {
      return c.name + ": current " + fmtMoney(c.expectedBalance) + " → saved " + fmtMoney(c.balance);
    }).join("\n");
    if (!window.confirm("Review these saved browser balances:\n\n" + preview +
        (pending.length > 10 ? "\n…and " + (pending.length - 10) + " more." : "") +
        "\n\nReconcile these accounts to the saved amounts? Bills and receipts will be kept, and existing activity will not be added twice. " +
        "Continue only if the saved amounts are the intended CURRENT balances.")) return;
    var body = { customers: pending, mode: "reconcile" }, op;
    try {
      op = await operationId("legacy-balances", body);
      body.operationId = op;
      var result = await requestApi("/api/customers", { method: "PUT", body: body });
      finishOperation("legacy-balances", op);
      if (!invalid) { try { localStorage.setItem(IMPORT_DONE_KEY, "1"); } catch (_) {} }
      setPageStatus("Reconciled saved balances for " + (result.imported || pending.length) + " customer(s)." +
        (invalid ? " Invalid or conflicting saved balances remain for manual review." : ""), invalid ? "is-warn" : "is-ok");
      await refreshCustomers();
      renderCustomerList();
    } catch (error) {
      setPageStatus("Balance reconciliation was not confirmed: " + error.message + ". Refresh and review the current accounts before retrying.", "is-error");
    }
  }
  function initCustomersPage() {
    if (cState.initialized) return;
    cState.initialized = true;
    if (!isAdmin()) { setPageStatus("Admin access required to view customer profiles.", "is-error"); return; }
    setPageStatus("Loading customers…", "is-info");
    refreshCustomers().then(function () {
      setPageStatus("", "");
      renderCustomerList();
      updateButtons();
      return offerLocalImport();
    }).catch(function (error) {
      setPageStatus("Could not load customers: " + error.message, "is-error");
    });
    if (cEl.searchInput) cEl.searchInput.addEventListener("input", function () {
      cState.searchQuery = cEl.searchInput.value || "";
      renderCustomerList();
    });
    if (cEl.profileClose) cEl.profileClose.addEventListener("click", closeProfile);
    if (cEl.editBtn) cEl.editBtn.addEventListener("click", function () {
      if (cEl.editForm && !cEl.editForm.classList.contains("hidden")) hideEditForm();
      else showEditForm();
    });
    if (cEl.editBalanceInput) cEl.editBalanceInput.addEventListener("input", function () {
      if (cState.editSnapshot) cState.editSnapshot.balanceDirty = true;
    });
    if (cEl.editSaveBtn) cEl.editSaveBtn.addEventListener("click", saveEdit);
    if (cEl.editCancelBtn) cEl.editCancelBtn.addEventListener("click", hideEditForm);
    if (cEl.payBtn) cEl.payBtn.addEventListener("click", recordPayment);
    if (cEl.deleteBtn) cEl.deleteBtn.addEventListener("click", deleteCustomer);
    if (cEl.payAmount) cEl.payAmount.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); recordPayment(); }
    });
    window.addEventListener("focus", refreshSelectedProfile);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") refreshSelectedProfile();
    });
    updateButtons();
  }
  window.__onCustomersReady = initCustomersPage;
})();
