/* Phone sale / item-entry screens, backed by billing.js's existing bill. */
(function () {
  "use strict";
  if (document.body.dataset.page !== "billing" || !window.MedicineBilling) return;
  var api = window.MedicineBilling;
  var media = window.matchMedia("(max-width: 980px) and (pointer: coarse)");
  var screen = "sale", draft = null, paymentMode = "credit", paymentLocked = false;
  var lastBillId = null, started = false, frame = 0, saleScroll = 0, pending = false;
  var updatingCashAmount = false;
  var refreshFields = false;
  var saleError = "";
  var searchResults = [], searchQuery = null;
  var root = document.createElement("div");
  root.id = "phone-billing";
  root.dataset.screen = "sale";
  root.innerHTML = `
    <header class="phone-sale-header">
      <button id="phone-back" class="phone-icon" type="button" aria-label="Open billing menu">☰</button>
      <div class="phone-header-copy"><span>Adarsh Medicals</span><h1 id="phone-title">Billing</h1></div>
      <button id="phone-quick-history" class="phone-history-link" type="button">History</button>
    </header>
    <nav id="phone-menu" class="phone-menu" aria-label="Billing menu" hidden>
      <button id="phone-history" type="button">Bill history</button>
      <button id="phone-new-sale" type="button">New bill</button>
      <a href="dashboard.html">Medicine database</a><a href="customers.html">Customers</a>
      <a id="phone-profit-link" href="profit.html" hidden>Profit</a>
    </nav>
    <p id="phone-global-error" class="phone-feedback is-error" role="alert"></p>
    <aside class="phone-sync" aria-label="Device sync">
      <span id="phone-sync-compact" class="phone-sync-compact" role="status">Automatic sync on</span>
      <p id="phone-sync-status" class="phone-feedback" role="status"></p>
      <button id="phone-sync-refresh" class="phone-history-link" type="button">Refresh saved bills</button>
      <button id="phone-sync-reload" class="phone-history-link" type="button" hidden>Load latest saved bill</button>
    </aside>
    <main id="phone-sale-screen" class="phone-screen">
      <div class="phone-invoice-strip"><div><small>Bill number</small><strong id="phone-invoice">New bill</strong></div><div><small>Bill date</small><span id="phone-date"></span></div></div>
      <section class="phone-sale-customer">
        <div class="phone-card-heading"><h2>Customer</h2><div class="phone-party-balance">Previous balance <strong id="phone-party-balance">₹0.00</strong></div></div>
        <label class="phone-field"><span>Choose saved customer</span><select id="phone-saved-customer"><option value="">Loading customers…</option></select></label>
        <label class="phone-field"><span>Customer / Business Name *</span><input id="phone-customer" autocomplete="off" maxlength="120" placeholder="Or enter a new customer name" required /></label>
        <label class="phone-field"><span>Phone Number</span><input id="phone-customer-phone" type="tel" autocomplete="tel" placeholder="Phone number" /></label>
        <button id="phone-save-customer" class="phone-history-link" type="button">Save customer details</button>
        <details class="phone-sale-options"><summary>Notes &amp; opening balance</summary>
          <label class="phone-field"><span>Order / Notes</span><input id="phone-notes" maxlength="240" placeholder="Order reference or notes" /></label>
          <label class="phone-field"><span>Previous balance (₹; negative for credit)</span><input id="phone-opening" type="number" inputmode="decimal" step="0.01" /></label>
        </details>
        <p id="phone-customer-status" class="phone-feedback" role="status"></p>
      </section>
      <section class="phone-billed-section">
        <h2 class="phone-section-band">Medicines in this bill <span id="phone-item-count">0</span></h2>
        <div id="phone-billed-items"></div>
        <div class="phone-bill-stats"><span>Total Qty: <b id="phone-total-qty">0</b></span><span>Subtotal: <b id="phone-subtotal">₹0.00</b></span><span>Tax: <b id="phone-tax">₹0.00</b></span><span>Round off: <b id="phone-roundoff">₹0.00</b></span></div>
        <button id="phone-add-items" class="phone-add-items" type="button"><span aria-hidden="true">＋</span> Add medicines</button>
      </section>
      <section class="phone-sale-payment">
        <h2 class="phone-payment-heading">Payment &amp; balance</h2>
        <div class="phone-sale-total"><span>Grand total</span><strong id="phone-total">₹0.00</strong></div>
        <div id="phone-payment-switch" class="phone-payment-switch" aria-label="Payment type">
          <button type="button" data-payment="credit" aria-pressed="true">On credit</button>
          <button type="button" data-payment="cash" aria-pressed="false">Paid in full</button>
        </div>
        <div class="phone-two-fields">
          <label class="phone-field"><span>Tax (%)</span><input id="phone-tax-input" type="number" inputmode="decimal" min="0" max="100" step="0.01" /></label>
          <label class="phone-field"><span>Amount received (₹)</span><input id="phone-received" type="number" inputmode="decimal" min="0" step="0.01" /></label>
        </div>
        <div class="phone-balance-line"><span>Balance carried forward</span><strong id="phone-balance">₹0.00</strong></div>
      </section>
      <p id="phone-edit-message" class="phone-edit-message" hidden></p>
      <p id="phone-save-status" class="phone-feedback" role="status" aria-live="polite"></p>
    </main>
    <main id="phone-search-screen" class="phone-screen" hidden>
      <div class="phone-search-context"><p id="phone-search-party" class="phone-search-party"></p><button id="phone-search-customer" type="button">Choose customer</button></div>
      <label class="phone-field phone-search-field"><span>Search medicines</span><input id="phone-item-search" type="search" autocomplete="off" placeholder="Medicine name…" /></label>
      <div class="phone-search-heading"><div><strong>Medicines</strong><span id="phone-search-count"></span></div><button id="phone-add-only" class="phone-history-link" type="button" aria-label="Add medicine for this bill only">＋ Bill-only item</button></div>
      <div id="phone-search-results" class="phone-search-results"></div>
    </main>
    <main id="phone-item-screen" class="phone-screen" hidden>
      <section class="phone-item-fields">
        <div class="phone-field phone-selected-name"><span>Medicine</span><strong id="phone-item-name"></strong></div>
        <p id="phone-item-location" class="phone-location-chip"></p>
        <div class="phone-reference-prices" aria-label="Medicine reference prices">
          <div><span>MRP</span><strong id="phone-item-mrp-value"></strong></div>
          <div><span>Purchase price</span><strong id="phone-item-purchase"></strong></div>
          <div><span>This customer's last rate</span><strong id="phone-item-customer-rate"></strong><button id="phone-use-customer-rate" type="button" hidden>Use customer rate</button></div>
          <div><span>Latest sold rate</span><strong id="phone-item-latest-rate"></strong><small id="phone-item-latest-date"></small><button id="phone-use-latest-rate" type="button" hidden>Use latest rate</button></div>
        </div>
        <div class="phone-reference-actions"><button id="phone-item-sales-history" class="phone-history-link" type="button">Sales history</button><button id="phone-price-retry" class="phone-history-link" type="button" hidden>Retry prices</button></div>
        <div class="phone-two-fields">
          <label class="phone-field"><span>Quantity</span><input id="phone-item-qty" type="number" inputmode="decimal" min="0.001" step="0.001" /></label>
          <label class="phone-field"><span>Sell price (₹)</span><input id="phone-item-rate" type="number" inputmode="decimal" min="0" step="0.01" /></label>
        </div>
        <p id="phone-item-price-note" class="phone-price-note"></p>
        <p id="phone-item-loss-warning" class="billing-loss-warning" role="status" hidden>Warning: negative markup — check the selling price.</p>
        <details class="phone-item-details"><summary>More details: batch, expiry, MRP &amp; markup</summary>
          <div class="phone-two-fields">
            <label class="phone-field"><span>Batch number</span><input id="phone-item-batch" maxlength="120" /></label>
            <label class="phone-field"><span>Expiry (MM/YY)</span><input id="phone-item-expiry" maxlength="60" placeholder="MM/YY" /></label>
          </div>
          <div class="phone-two-fields">
            <label class="phone-field"><span>MRP (₹)</span><input id="phone-item-mrp" type="number" inputmode="decimal" min="0" step="0.01" /></label>
            <label class="phone-field"><span>Markup (%)</span><input id="phone-item-markup" type="number" min="-100" max="2000" step="0.01" /></label>
          </div>
        </details>
      </section>
      <p id="phone-item-error" class="phone-feedback is-warn" role="alert"></p>
      <button id="phone-remove-item" class="phone-remove-item" type="button" hidden>Remove item from bill</button>
    </main>
    <footer class="phone-sale-footer">
      <div id="phone-footer-summary" class="phone-footer-summary" hidden><span id="phone-footer-label">Line total</span><strong id="phone-item-subtotal">₹0.00</strong><strong id="phone-search-total" hidden></strong></div>
      <button id="phone-save-new" class="phone-secondary" type="button">Save &amp; new</button>
      <button id="phone-save" class="phone-primary" type="button">Save bill</button>
      <button id="phone-receipt" class="phone-receipt" type="button" aria-label="Save and open receipt" title="Save and view receipt">▤</button>
    </footer>`;
  document.body.appendChild(root);
  function el(id) { return document.getElementById("phone-" + id); }
  function money(value) { return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(value) || 0); }
  function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function round(value) { return Math.round(value * 100) / 100; }
  function recordedMoney(value) { return value == null || value === "" || !Number.isFinite(Number(value)) ? "Not recorded" : money(value); }
  function historyRate(value, status) {
    if (value != null && Number.isFinite(Number(value))) return status === "error" ? "Unavailable · last known " + money(value) : money(value);
    if (status === "loading" || status === "idle") return "Loading…";
    if (status === "error" || status === "unavailable") return "Unavailable";
    if (status === "no-customer") return "Choose a customer";
    return "No previous sale";
  }
  function priceInfo(medicine) {
    return (api.priceInfo && api.priceInfo(medicine.id || medicine.medicineId, medicine.mrp)) || {
      mrp: medicine.mrp, purchasePrice: medicine.purchasePrice != null ? medicine.purchasePrice : medicine.rate,
      inventoryRate: medicine.sellingPrice != null ? medicine.sellingPrice : medicine.sellPrice,
      stock: medicine.quantity, seller: medicine.seller, location: medicine.location,
      customerStatus: "unavailable", globalStatus: "unavailable"
    };
  }
  function refreshPrices(force) {
    if (!api.refreshPriceHistory) return;
    Promise.resolve(api.refreshPriceHistory({ force: !!force })).catch(function () { schedule(); });
  }
  function drawReferencePrices() {
    if (!draft) return;
    var info = priceInfo(draft);
    var bill = api.snapshot();
    text("item-mrp-value", recordedMoney(draft.mrp));
    text("item-purchase", recordedMoney(draft.purchasePrice));
    text("item-customer-rate", !bill.customerName.trim() ? "Choose a customer" : historyRate(info.customerLastRate, info.customerStatus));
    text("item-latest-rate", historyRate(info.latestSoldRate, info.globalStatus));
    text("item-latest-date", info.latestSoldAt ? new Date(info.latestSoldAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "");
    el("use-customer-rate").hidden = !bill.customerName.trim() || info.customerLastRate == null;
    el("use-latest-rate").hidden = info.latestSoldRate == null;
    el("price-retry").hidden = info.customerStatus !== "error" && info.globalStatus !== "error";
  }
  function text(id, value) { el(id).textContent = value; }
  function field(id, value) {
    // Selecting a customer can auto-fill the phone just as it receives focus.
    if (refreshFields || document.activeElement !== el(id) || (id === "customer-phone" && !el(id).value && value)) {
      el(id).value = value == null ? "" : value;
    }
  }
  function go(next) {
    if (screen === "sale") saleScroll = window.scrollY;
    screen = next;
    root.dataset.screen = next;
    ["sale", "search", "item"].forEach(function (name) { el(name + "-screen").hidden = name !== next; });
    document.body.classList.toggle("phone-billing-history", next === "history");
    text("title", next === "sale" ? "Billing" : next === "history" ? "Bill history" : "Add medicines");
    el("back").setAttribute("aria-label", next === "sale" ? "Open billing menu" : "Back to sale");
    text("back", next === "sale" ? "☰" : "‹");
    el("payment-switch").hidden = next !== "sale";
    el("quick-history").hidden = next !== "sale";
    el("menu").hidden = true;
    root.querySelector("footer").hidden = next === "history";
    el("receipt").hidden = next !== "sale";
    el("save-new").disabled = pending || api.snapshot().saving;
    el("save").disabled = pending || api.snapshot().saving;
    el("save").hidden = next === "search";
    text("save-new", next === "search" ? "Review bill" : next === "item" ? (draft && draft._rowId ? "Cancel" : "Add & review bill") : "Save & new");
    text("save", next === "sale" ? (api.snapshot().id ? "Update bill" : "Save bill") : draft && draft._rowId ? "Save changes" : "Add & continue");
    el("footer-summary").hidden = next !== "item" && next !== "search";
    el("item-subtotal").hidden = next !== "item";
    el("search-total").hidden = next !== "search";
    text("footer-label", next === "item" ? "Line total" : api.snapshot().items.length + " medicine(s) in bill");
    window.scrollTo(0, next === "sale" ? saleScroll : 0);
    if (next === "search") {
      search();
      refreshPrices(true);
      el("item-search").focus(); el("item-search").select();
    }
  }
  function openItem(item) {
    draft = Object.assign({}, item);
    go("item");
    text("title", draft._rowId ? "Edit medicine" : "Medicine details");
    text("save", draft._rowId ? "Save changes" : "Add & continue");
    el("back").setAttribute("aria-label", draft._rowId ? "Back to sale" : "Back to medicine search");
    text("item-name", draft.medicineName);
    text("item-location", draft.location ? "Rack: " + draft.location : "");
    field("item-qty", draft.quantity); field("item-rate", draft.sellPrice);
    field("item-mrp", draft.mrp); field("item-markup", draft.markupPercent);
    field("item-batch", draft.batchNo || ""); field("item-expiry", draft.expiry || "");
    drawReferencePrices();
    var info = priceInfo(draft);
    text("item-price-note", draft._rowId ? "Saved bill rate" : draft.priceNote ||
      (info.source === "customer" ? "This customer’s last rate" : info.source === "history" ? "Latest sold rate" : "Inventory rate · review previous rates above"));
    el("item-markup").disabled = draft.purchasePrice == null;
    el("item-error").textContent = "";
    el("remove-item").hidden = !draft._rowId;
    root.querySelector(".phone-item-details").open = false;
    updateDraftTotal();
    el("item-qty").focus(); el("item-qty").select();
  }
  function search(event) {
    var query = el("item-search").value.trim();
    // A history response updates prices, never reorders the medicine under a
    // finger. Re-rank on the next explicit search input instead.
    if (searchQuery !== query || (event && event.type === "input")) {
      searchQuery = query;
      searchResults = api.search(query);
    }
    var results = searchResults;
    text("search-count", results.length ? (results.length === 40 ? "First 40" : results.length + " matches") : "");
    var bill = api.snapshot();
    var hasCustomer = !!bill.customerName.trim();
    text("search-party", hasCustomer ? "Billing " + bill.customerName : "No customer selected");
    text("search-customer", hasCustomer ? "Change" : "Choose customer");
    el("search-results").classList.toggle("has-customer", hasCustomer);
    var html = results.length ? results.map(function (item) {
      var info = priceInfo(item);
      var inBill = bill.items.filter(function (line) { return line.medicineId === item.id; }).reduce(function (sum, line) { return sum + Number(line.quantity); }, 0);
      function rateTone(value, status) {
        return status === "error" || status === "unavailable" ? "is-unavailable" : value != null && Number.isFinite(Number(value)) ? "is-recorded" : "is-empty";
      }
      return '<button type="button" class="phone-search-item" data-medicine="' + esc(item.id) + '">' +
        '<span class="phone-result-top"><span class="phone-result-title"><strong>' + esc(item.medicineName) + '</strong>' +
        (inBill ? '<small class="phone-in-bill">Added · Qty ' + esc(round(inBill)) + '</small>' : '') + '</span>' +
        '<span class="phone-result-mrp"><small>MRP</small><b>' + esc(recordedMoney(info.mrp)) + '</b></span></span>' +
        '<span class="phone-result-details"><span class="phone-result-meta">' + (info.seller ? '<span>' + esc(info.seller) + '</span>' : '') +
        (info.location ? '<span class="phone-search-rack">Rack: ' + esc(info.location) + '</span>' : '') + '</span>' +
        '<span class="phone-result-purchase"><small>Purchase</small><b>' + esc(recordedMoney(info.purchasePrice)) + '</b></span></span>' +
        '<span class="phone-result-history">' + (hasCustomer ? '<span class="phone-result-customer-rate ' + rateTone(info.customerLastRate,info.customerStatus) + '"><small>Customer’s last rate</small><b>' + esc(historyRate(info.customerLastRate,info.customerStatus)) + '</b></span>' : '') +
        '<span class="phone-result-latest-rate ' + rateTone(info.latestSoldRate,info.globalStatus) + '"><small>Last sold (same MRP)</small><b>' + esc(historyRate(info.latestSoldRate, info.globalStatus)) + '</b></span></span></button>';
    }).join("") : '<p class="phone-empty">' + (query ? "No matching medicine. Try another name." : "Your medicine inventory is empty.") + '</p>';
    if (el("search-results").innerHTML !== html) el("search-results").innerHTML = html;
  }
  function updateDraftTotal() {
    if (!draft) return;
    draft.quantity = el("item-qty").value;
    draft.sellPrice = el("item-rate").value;
    draft.mrp = el("item-mrp").value;
    draft.batchNo = el("item-batch").value;
    draft.expiry = el("item-expiry").value;
    var lineTotal = api.lineTotal ? api.lineTotal(draft.sellPrice, draft.quantity)
      : Math.floor((Math.round(Number(draft.sellPrice) * 100) * Math.round(Number(draft.quantity) * 1000) + 500) / 1000) / 100;
    text("item-subtotal", money(lineTotal));
    el("item-loss-warning").hidden = !(Number(el("item-markup").value) < 0 || (draft.purchasePrice > 0 && Number(draft.sellPrice) < draft.purchasePrice));
    text("item-mrp-value", recordedMoney(draft.mrp));
    drawReferencePrices();
  }
  function saveItem(andNew) {
    updateDraftTotal();
    if (["item-qty", "item-rate", "item-mrp"].some(function (id) { return !el(id).checkValidity(); })) {
      text("item-error", "Enter a quantity above zero with up to 3 decimals and non-negative prices with up to 2 decimals."); return;
    }
    if (!draft.quantity || Number(draft.quantity) <= 0 || !draft.sellPrice || Number(draft.sellPrice) < 0 ||
        (draft.mrp !== "" && (!Number.isFinite(Number(draft.mrp)) || Number(draft.mrp) < 0))) {
      text("item-error", "Enter a quantity above zero and a valid rate and MRP."); return;
    }
    if (!api.commit(draft)) { text("item-error", "Could not add this medicine. Please choose it again."); return; }
    draft = null;
    document.activeElement.blur();
    go(andNew ? "search" : "sale");
    draw();
  }
  async function saveSale(andNew, receipt) {
    if (pending) return;
    saleError = "";
    if (!el("customer").value.trim()) {
      saleError = "Select a customer, or enter their name, before saving."; draw();
      el("customer").focus(); return;
    }
    if (!el("tax-input").checkValidity()) {
      saleError = "Enter a tax percentage between 0 and 100."; draw();
      el("tax-input").focus(); return;
    }
    if (!el("received").checkValidity() || !el("opening").checkValidity()) {
      saleError = "Enter a non-negative amount received and a valid previous balance, with up to 2 decimals."; draw(); return;
    }
    pending = true; draw();
    try {
      var ok = await api.save(andNew);
      if (ok && andNew) { paymentMode = "credit"; paymentLocked = false; saleScroll = 0; window.scrollTo(0, 0); }
      if (ok && receipt) await api.receipt();
    } finally { pending = false; draw(); }
  }
  function draw() {
    if (!api.ready()) return;
    if (!started) { started = true; lastBillId = api.snapshot().id; }
    document.body.classList.toggle("phone-billing-active", media.matches);
    if (!media.matches) return;
    var bill = api.snapshot();
    if (lastBillId !== bill.id) {
      if (screen === "history") go("sale");
      paymentLocked = false;
      paymentMode = bill.totalAmount > 0 && bill.received >= bill.totalAmount ? "cash" : "credit";
      lastBillId = bill.id;
    }
    el("profit-link").hidden = !bill.canViewProfit;
    if (!paymentLocked) paymentMode = bill.totalAmount > 0 && bill.received >= bill.totalAmount ? "cash" : "credit";
    field("customer", bill.customerName); field("customer-phone", bill.customerPhone);
    field("notes", bill.notes); field("tax-input", bill.gstPercent);
    field("received", bill.receivedInput == null ? bill.received : bill.receivedInput);
    field("opening", bill.openingInput == null ? bill.previousBalance : bill.openingInput);
    text("invoice", bill.number); text("date", bill.date);
    text("party-balance", money(bill.previousBalance)); text("item-count", bill.items.length);
    text("total-qty", round(bill.items.reduce(function (sum, item) { return sum + Number(item.quantity); }, 0)));
    text("subtotal", bill.subtotal); text("tax", bill.tax); text("roundoff", bill.roundOff);
    text("total", bill.total); text("balance", bill.balance);
    text("customer-status", bill.customerStatus || "");
    text("global-error", bill.error || "");
    text("sync-status", bill.syncStatus || "Saved bills are shared across your devices.");
    var syncNeedsAttention = bill.syncReloadAvailable || /could not|failed|unavailable|reconnect|unconfirmed/i.test(bill.syncStatus || "");
    root.classList.toggle("phone-sync-attention", !!syncNeedsAttention);
    text("sync-compact", syncNeedsAttention ? "Sync needs attention" : "Automatic sync on");
    el("sync-reload").hidden = !bill.syncReloadAvailable;
    el("sync-refresh").disabled = pending || bill.saving;
    el("sync-reload").disabled = pending || bill.saving;
    text("save-status", saleError || bill.status); el("save-status").className = "phone-feedback " + (saleError ? "is-warn" : bill.statusTone);
    text("edit-message", "Editing " + bill.number + ". Save updates this bill; use Save & New to start the next sale.");
    el("edit-message").hidden = !bill.id;
    var customerOptions = '<option value="">' + (bill.customers.length ? 'New customer / enter name below' : 'No saved customers — enter a name below') + '</option>' + bill.customers.map(function (customer) {
      return '<option value="' + esc(customer.id || customer.name) + '">' + esc(customer.name) +
        (customer.phone ? ' · ' + esc(customer.phone) : '') + (customer.balance < 0 ? ' · Credit ' : ' · Due ') + esc(money(Math.abs(customer.balance))) + '</option>';
    }).join("");
    if (el("saved-customer").innerHTML !== customerOptions) el("saved-customer").innerHTML = customerOptions;
    var selectedCustomer = bill.customers.find(function (customer) { return customer.name.toLowerCase() === bill.customerName.trim().toLowerCase(); }) ||
      (bill.id && bill.customerName === bill.issuedCustomerName && bill.customers.find(function (customer) { return customer.id === bill.customerId; }));
    el("saved-customer").value = selectedCustomer ? selectedCustomer.id || selectedCustomer.name : "";
    el("billed-items").innerHTML = bill.items.length ? bill.items.map(function (item, index) {
      return '<button class="phone-billed-item" data-row="' + esc(item._rowId) + '" type="button" aria-label="Edit ' + esc(item.medicineName) + '"><span class="phone-item-title"><span><small>' + (index + 1) + '</small> ' + esc(item.medicineName) + (item.billOnly ? ' <small>Bill only · no profit</small>' : '') + '</span><strong>' + esc(money(round(item.quantity * item.sellPrice))) + '</strong></span><span class="phone-item-calculation"><span>' + esc(item.quantity) + ' × ' + esc(money(item.sellPrice)) + '</span><span class="phone-edit-hint">Edit →</span></span></button>';
    }).join("") : '<p class="phone-empty">Your bill is ready for its first medicine.</p>';
    var busy = pending || bill.saving;
    root.querySelectorAll("input, select, #phone-save-customer, [data-payment], [data-row], #phone-new-sale, #phone-add-items, #phone-add-only, #phone-remove-item").forEach(function (input) {
      input.disabled = busy || (input === el("item-markup") && draft && draft.purchasePrice == null);
    });
    root.querySelectorAll("[data-payment]").forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.payment === paymentMode)); });
    ["save", "save-new", "receipt"].forEach(function (id) { el(id).disabled = busy; });
    ["use-customer-rate", "use-latest-rate", "item-sales-history", "price-retry"].forEach(function (id) { el(id).disabled = busy; });
    if (screen === "search") search();
    if (screen === "item") drawReferencePrices();
    text("search-total", bill.total);
    if (screen === "search") text("footer-label", bill.items.length + " medicine(s) in bill");
    if (screen === "sale") {
      text("save", pending || bill.saving ? "Saving…" : bill.id ? "Update bill" : "Save bill");
    }
    refreshFields = false;
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(function () { frame = 0; draw(); }); }
  function setReceivedFromPaymentMode(value) {
    updatingCashAmount = true;
    try { api.setField("received", value); }
    finally { updatingCashAmount = false; }
  }
  // Changes arrive from the shared bill model, including edits made through
  // desktop controls. Rendering and responsive layout changes only display
  // these values; they must never manufacture another payment.
  window.addEventListener("medicine-bill-change", function (event) {
    if (!api.ready()) return;
    var fieldName = event.detail && event.detail.field;
    var bill = api.snapshot();
    if (fieldName === "newBill" || fieldName === "loadBill" || lastBillId !== bill.id) {
      refreshFields = true;
      saleError = "";
      paymentLocked = false;
      lastBillId = bill.id;
    }
    if (fieldName === "total" && paymentLocked &&
        paymentMode === "cash" && bill.received !== bill.totalAmount) {
      // This follows an explicit item/tax operation, never draw() or resize.
      setReceivedFromPaymentMode(bill.totalAmount);
    }
    schedule();
  });
  var sharedReceivedInput = document.getElementById("bill-received-amount");
  if (sharedReceivedInput) sharedReceivedInput.addEventListener("input", function () {
    if (!updatingCashAmount) paymentLocked = false;
    schedule();
  });
  function bindField(id, key) {
    el(id).addEventListener("input", function () { saleError = ""; api.setField(key, this.value); });
    el(id).addEventListener("blur", function () { api.setField(key, this.value, "blur"); schedule(); });
  }
  bindField("customer", "customerName"); bindField("customer-phone", "customerPhone");
  bindField("notes", "notes"); bindField("opening", "openingBalance"); bindField("tax-input", "gstPercent");
  el("saved-customer").addEventListener("change", function () {
    saleError = "";
    var chosen = api.snapshot().customers.find(function (customer) { return (customer.id || customer.name) === el("saved-customer").value; });
    if (chosen) api.setField("savedCustomer", chosen.name, "change");
    else {
      api.setField("customerName", ""); api.setField("customerPhone", "");
      api.setField("savedCustomer", "", "change");
    }
    draw();
  });
  el("save-customer").addEventListener("click", async function () {
    if (pending || api.snapshot().saving) return;
    pending = true; draw();
    try { await api.saveCustomer(); } finally { pending = false; draw(); }
  });
  el("received").addEventListener("input", function () {
    saleError = "";
    paymentLocked = false;
    api.setField("received", this.value); schedule();
  });
  el("received").addEventListener("blur", function () {
    api.setField("received", this.value, "change"); schedule();
  });
  el("item-search").addEventListener("input", search);
  el("search-results").addEventListener("click", function (event) {
    var button = event.target.closest("[data-medicine]");
    if (button) { var item = api.draft(button.dataset.medicine); if (item) openItem(item); }
  });
  el("billed-items").addEventListener("click", function (event) {
    var button = event.target.closest("[data-row]");
    if (button) { var item = api.snapshot().items.find(function (row) { return row._rowId === button.dataset.row; }); if (item) openItem(item); }
  });
  ["item-qty", "item-rate", "item-mrp"].forEach(function (id) {
    el(id).addEventListener("input", function () {
      updateDraftTotal();
      if (id === "item-rate") {
        text("item-price-note", "Custom rate");
        if (draft.purchasePrice > 0) field("item-markup", round((Number(draft.sellPrice) - draft.purchasePrice) / draft.purchasePrice * 100));
      }
      if (id === "item-mrp") text("item-price-note", "MRP changed · review the selling rate");
    });
  });
  el("item-markup").addEventListener("input", function () {
    if (draft && draft.purchasePrice != null && this.value !== "") {
      text("item-price-note", "Calculated from markup");
      field("item-rate", round(draft.purchasePrice * (1 + Number(this.value) / 100))); updateDraftTotal();
    }
  });
  ["customer", "latest"].forEach(function (kind) {
    el("use-" + kind + "-rate").addEventListener("click", function () {
      if (!draft || pending || api.snapshot().saving) return;
      var info = priceInfo(draft);
      var value = kind === "customer" ? info.customerLastRate : info.latestSoldRate;
      if (value == null || !Number.isFinite(Number(value))) return;
      field("item-rate", value);
      text("item-price-note", kind === "customer" ? "Using this customer’s last rate" : "Using latest sold rate");
      updateDraftTotal();
      if (draft.purchasePrice > 0) field("item-markup", round((Number(value) - draft.purchasePrice) / draft.purchasePrice * 100));
    });
  });
  el("price-retry").addEventListener("click", function () { refreshPrices(true); });
  el("item-sales-history").addEventListener("click", function () {
    if (!draft || pending || api.snapshot().saving) return;
    updateDraftTotal();
    if (api.salesHistory && draft.medicineId) api.salesHistory(draft.medicineId, draft.mrp);
    else if (window.showMedicineSalesModal) window.showMedicineSalesModal(draft.medicineName);
  });
  el("back").addEventListener("click", function () {
    if (screen === "sale") { el("menu").hidden = !el("menu").hidden; return; }
    var next = screen === "item" && draft && !draft._rowId ? "search" : "sale";
    draft = null; document.activeElement.blur(); go(next); draw();
  });
  el("add-items").addEventListener("click", function () { go("search"); });
  el("search-customer").addEventListener("click", function () {
    document.activeElement.blur(); go("sale"); draw();
    el("saved-customer").focus({ preventScroll: true });
    el("saved-customer").scrollIntoView({ block: "center" });
  });
  el("add-only").addEventListener("click", function () { api.newBillOnlyItem(); });
  window.addEventListener("medicine-bill-only-added", function () { draft = null; go("sale"); draw(); });
  el("remove-item").addEventListener("click", function () {
    if (draft && draft._rowId) {
      api.remove(draft._rowId); draft = null; go("sale"); draw();
    }
  });
  el("save").addEventListener("click", function () { if (screen === "item") saveItem(!draft._rowId); else if (screen === "sale") saveSale(false, false); });
  el("save-new").addEventListener("click", function () {
    if (screen === "item") {
      if (draft && draft._rowId) { draft = null; document.activeElement.blur(); go("sale"); draw(); }
      else saveItem(false);
    } else if (screen === "sale") saveSale(true, false);
    else if (screen === "search") { document.activeElement.blur(); go("sale"); draw(); }
  });
  el("receipt").addEventListener("click", function () { saveSale(false, true); });
  el("payment-switch").addEventListener("click", function (event) {
    var button = event.target.closest("[data-payment]"); if (!button) return;
    if (pending || api.snapshot().saving) return;
    lastBillId = api.snapshot().id;
    paymentMode = button.dataset.payment; paymentLocked = paymentMode === "cash";
    setReceivedFromPaymentMode(paymentMode === "cash" ? api.snapshot().totalAmount : 0);
    draw();
  });
  el("history").addEventListener("click", function () { go("history"); api.refreshSavedBills(); });
  el("quick-history").addEventListener("click", function () { go("history"); api.refreshSavedBills(); });
  el("sync-refresh").addEventListener("click", function () { api.refreshSavedBills(); });
  el("sync-reload").addEventListener("click", async function () {
    if (await api.reloadBill()) { draft = null; go("sale"); draw(); }
  });
  document.querySelector("main.page-shell").addEventListener("click", async function (event) {
    var button = event.target.closest("[data-edit-bill]");
    if (!media.matches || !button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    button.disabled = true;
    try { if (await api.editBill(button.dataset.editBill)) { draft = null; go("sale"); draw(); } }
    finally { button.disabled = false; }
  }, true);
  el("new-sale").addEventListener("click", function () {
    api.newBill();
    if (!api.snapshot().items.length) { paymentLocked = false; paymentMode = "credit"; }
    draw(); el("menu").hidden = true;
  });
  window.addEventListener("focus", function () { if (screen === "search" || screen === "item") refreshPrices(false); });
  new MutationObserver(schedule).observe(document.querySelector("main.page-shell"), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["disabled", "class"] });
  media.addEventListener("change", function () { draw(); if (media.matches) go("sale"); });
  if (window.visualViewport) {
    var previousViewportHeight = window.visualViewport.height;
    function keyboard() {
      var offset = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
      root.style.setProperty("--phone-keyboard-offset", offset + "px");
      var shrinking = window.visualViewport.height < previousViewportHeight;
      previousViewportHeight = window.visualViewport.height;
      if (shrinking && media.matches && (screen === "item" || screen === "search")) {
        requestAnimationFrame(function () {
          var input = document.activeElement;
          if (!input || input.tagName !== "INPUT" || !root.contains(input)) return;
          var bounds = input.getBoundingClientRect();
          var top = root.querySelector("header").getBoundingClientRect().bottom + 8;
          var bottom = root.querySelector("footer").getBoundingClientRect().top - 8;
          if (bounds.top < top || bounds.bottom > bottom) input.scrollIntoView({ block: "center", inline: "nearest" });
        });
      }
    }
    window.visualViewport.addEventListener("resize", keyboard);
    window.visualViewport.addEventListener("scroll", keyboard);
    keyboard();
  }
  draw();
})();
