/* Phone sale / item-entry screens, backed by billing.js's existing bill. */
(function () {
  "use strict";
  if (document.body.dataset.page !== "billing" || !window.MedicineBilling) return;
  var api = window.MedicineBilling;
  var media = window.matchMedia("(max-width: 980px) and (pointer: coarse)");
  var screen = "sale", draft = null, paymentMode = "credit", paymentLocked = false;
  var lastBillId = null, started = false, frame = 0, saleScroll = 0, pending = false;
  var updatingCashAmount = false;
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
    </nav>
    <p id="phone-global-error" class="phone-feedback is-error" role="alert"></p>
    <aside class="phone-sync" aria-label="Device sync">
      <p id="phone-sync-status" class="phone-feedback" role="status"></p>
      <button id="phone-sync-refresh" class="phone-history-link" type="button">Refresh saved bills</button>
      <button id="phone-sync-reload" class="phone-history-link" type="button" hidden>Load latest saved bill</button>
    </aside>
    <main id="phone-sale-screen" class="phone-screen">
      <div class="phone-invoice-strip"><div><small>Bill number</small><strong id="phone-invoice">New bill</strong></div><div><small>Bill date</small><span id="phone-date"></span></div></div>
      <section class="phone-sale-customer">
        <div class="phone-card-heading"><h2>Customer</h2><div class="phone-party-balance">Previous balance <strong id="phone-party-balance">₹0.00</strong></div></div>
        <label class="phone-field"><span>Customer / Business Name *</span><input id="phone-customer" autocomplete="off" list="phone-customers" placeholder="Select or enter customer" required /><datalist id="phone-customers"></datalist></label>
        <label class="phone-field"><span>Phone Number</span><input id="phone-customer-phone" type="tel" autocomplete="tel" placeholder="Phone number" /></label>
        <details class="phone-sale-options"><summary>Notes &amp; opening balance</summary>
          <label class="phone-field"><span>Order / Notes</span><input id="phone-notes" maxlength="240" placeholder="Order reference or notes" /></label>
          <label class="phone-field"><span>Previous balance (₹)</span><input id="phone-opening" type="number" inputmode="decimal" min="0" step="0.01" /></label>
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
      <p class="phone-screen-intro">Find a medicine from your inventory. Your saved selling rates are filled in automatically.</p>
      <label class="phone-field phone-search-field"><span>Search medicines</span><input id="phone-item-search" type="search" autocomplete="off" placeholder="Medicine name…" /></label>
      <div class="phone-search-heading"><strong>Your medicine database</strong><span id="phone-search-count"></span></div>
      <div id="phone-search-results" class="phone-search-results"></div>
    </main>
    <main id="phone-item-screen" class="phone-screen" hidden>
      <section class="phone-item-fields">
        <div class="phone-field phone-selected-name"><span>Medicine</span><strong id="phone-item-name"></strong></div>
        <p id="phone-item-location" class="phone-location-chip"></p>
        <div class="phone-two-fields">
          <label class="phone-field"><span>Quantity</span><input id="phone-item-qty" type="number" inputmode="decimal" min="0.001" step="0.001" /></label>
          <label class="phone-field"><span>Sell price (₹)</span><input id="phone-item-rate" type="number" inputmode="decimal" min="0" step="0.01" /></label>
        </div>
        <p id="phone-item-price-note" class="phone-price-note"></p>
        <details class="phone-item-details"><summary>Purchase price, MRP &amp; markup</summary>
          <p>Purchase price: <strong id="phone-item-purchase"></strong></p>
          <div class="phone-two-fields">
            <label class="phone-field"><span>MRP (₹)</span><input id="phone-item-mrp" type="number" inputmode="decimal" min="0" step="0.01" /></label>
            <label class="phone-field"><span>Markup (%)</span><input id="phone-item-markup" type="number" min="-100" max="2000" step="0.01" /></label>
          </div>
        </details>
      </section>
      <section class="phone-item-totals"><h2>Medicine total</h2><div><span>Sell price × quantity</span><strong id="phone-item-subtotal">₹0.00</strong></div></section>
      <p id="phone-item-error" class="phone-feedback is-warn" role="alert"></p>
      <button id="phone-remove-item" class="phone-remove-item" type="button" hidden>Remove item from bill</button>
    </main>
    <footer class="phone-sale-footer">
      <button id="phone-save-new" class="phone-secondary" type="button">Save &amp; new</button>
      <button id="phone-save" class="phone-primary" type="button">Save bill</button>
      <button id="phone-receipt" class="phone-receipt" type="button" aria-label="Save and open receipt" title="Save and view receipt">▤</button>
    </footer>`;
  document.body.appendChild(root);
  function el(id) { return document.getElementById("phone-" + id); }
  function money(value) { return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(value) || 0); }
  function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function round(value) { return Math.round(value * 100) / 100; }
  function text(id, value) { el(id).textContent = value; }
  function field(id, value) {
    // Selecting a customer can auto-fill the phone just as it receives focus.
    if (document.activeElement !== el(id) || (id === "customer-phone" && !el(id).value && value)) {
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
    text("save-new", next === "search" ? "Back to bill" : next === "item" ? "Add another" : "Save & new");
    text("save", next === "sale" ? (api.snapshot().id ? "Update bill" : "Save bill") : "Add to bill");
    window.scrollTo(0, next === "sale" ? saleScroll : 0);
    if (next === "search") {
      el("item-search").value = "";
      search();
      el("item-search").focus();
    }
  }
  function openItem(item) {
    draft = Object.assign({}, item);
    go("item");
    text("title", draft._rowId ? "Edit medicine" : "Medicine details");
    text("save", draft._rowId ? "Save changes" : "Add to bill");
    el("back").setAttribute("aria-label", draft._rowId ? "Back to sale" : "Back to medicine search");
    text("item-name", draft.medicineName);
    text("item-location", draft.location ? "Rack: " + draft.location : "");
    field("item-qty", draft.quantity); field("item-rate", draft.sellPrice);
    field("item-mrp", draft.mrp); field("item-markup", draft.markupPercent);
    text("item-purchase", draft.purchasePrice == null ? "Not recorded" : money(draft.purchasePrice));
    text("item-price-note", draft.priceNote || "");
    el("item-markup").disabled = draft.purchasePrice == null;
    el("item-error").textContent = "";
    el("remove-item").hidden = !draft._rowId;
    root.querySelector(".phone-item-details").open = false;
    updateDraftTotal();
    el("item-qty").focus(); el("item-qty").select();
  }
  function search() {
    var query = el("item-search").value.trim();
    var results = api.search(query);
    text("search-count", results.length ? (results.length === 40 ? "First 40 matches" : results.length + " found") : "");
    el("search-results").innerHTML = results.length ? results.map(function (item) {
      var purchase = item.purchasePrice != null ? item.purchasePrice : item.rate;
      return '<button type="button" class="phone-search-item" data-medicine="' + esc(item.id) + '"><strong>' + esc(item.medicineName) +
        '</strong><span><span>Purchase: ' + (purchase == null ? "—" : esc(money(purchase))) + '</span><span>In stock: ' + esc(item.quantity) +
        '</span>' + (item.location ? '<span class="phone-search-rack">Rack: ' + esc(item.location) + '</span>' : '') + '</span></button>';
    }).join("") : '<p class="phone-empty">' + (query ? "No matching medicine. Try another name." : "Your medicine inventory is empty.") + '</p>';
  }
  function updateDraftTotal() {
    if (!draft) return;
    draft.quantity = el("item-qty").value;
    draft.sellPrice = el("item-rate").value;
    draft.mrp = el("item-mrp").value;
    text("item-subtotal", money(round(Number(draft.quantity) * Number(draft.sellPrice))));
  }
  function saveItem(andNew) {
    updateDraftTotal();
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
    if (!el("customer").value.trim()) {
      text("save-status", "Select a customer, or enter their name, before saving.");
      el("customer").focus(); return;
    }
    if (!el("tax-input").checkValidity()) {
      text("save-status", "Enter a tax percentage between 0 and 100.");
      el("tax-input").focus(); return;
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
    if (!paymentLocked) paymentMode = bill.totalAmount > 0 && bill.received >= bill.totalAmount ? "cash" : "credit";
    field("customer", bill.customerName); field("customer-phone", bill.customerPhone);
    field("notes", bill.notes); field("tax-input", bill.gstPercent);
    field("received", bill.received); field("opening", bill.previousBalance);
    text("invoice", bill.number); text("date", bill.date);
    text("party-balance", money(bill.previousBalance)); text("item-count", bill.items.length);
    text("total-qty", round(bill.items.reduce(function (sum, item) { return sum + Number(item.quantity); }, 0)));
    text("subtotal", bill.subtotal); text("tax", bill.tax); text("roundoff", bill.roundOff);
    text("total", bill.total); text("balance", bill.balance);
    text("customer-status", bill.customerStatus || "");
    text("global-error", bill.error || "");
    text("sync-status", bill.syncStatus || "Saved bills are shared across your devices.");
    el("sync-reload").hidden = !bill.syncReloadAvailable;
    el("sync-refresh").disabled = pending || bill.saving;
    el("sync-reload").disabled = pending || bill.saving;
    text("save-status", bill.status); el("save-status").className = "phone-feedback " + bill.statusTone;
    text("edit-message", "Editing " + bill.number + ". Save updates this bill; use Save & New to start the next sale.");
    el("edit-message").hidden = !bill.id;
    var customerOptions = bill.customers.map(function (customer) { return '<option value="' + esc(customer.name) + '">' + esc(customer.phone || "") + '</option>'; }).join("");
    if (el("customers").innerHTML !== customerOptions) el("customers").innerHTML = customerOptions;
    el("billed-items").innerHTML = bill.items.length ? bill.items.map(function (item, index) {
      return '<button class="phone-billed-item" data-row="' + esc(item._rowId) + '" type="button" aria-label="Edit ' + esc(item.medicineName) + '"><span class="phone-item-title"><span><small>' + (index + 1) + '</small> ' + esc(item.medicineName) + '</span><strong>' + esc(money(round(item.quantity * item.sellPrice))) + '</strong></span><span class="phone-item-calculation"><span>' + esc(item.quantity) + ' × ' + esc(money(item.sellPrice)) + '</span><span class="phone-edit-hint">Edit →</span></span></button>';
    }).join("") : '<p class="phone-empty">Your bill is ready for its first medicine.</p>';
    var busy = pending || bill.saving;
    root.querySelectorAll("input, [data-payment], [data-row], #phone-new-sale, #phone-add-items, #phone-remove-item").forEach(function (input) {
      input.disabled = busy || (input === el("item-markup") && draft && draft.purchasePrice == null);
    });
    root.querySelectorAll("[data-payment]").forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.payment === paymentMode)); });
    ["save", "save-new", "receipt"].forEach(function (id) { el(id).disabled = busy; });
    if (screen === "sale") {
      text("save", pending || bill.saving ? "Saving…" : bill.id ? "Update bill" : "Save bill");
    }
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
    el(id).addEventListener("input", function () { api.setField(key, this.value); });
    el(id).addEventListener("blur", function () { api.setField(key, this.value, "blur"); schedule(); });
  }
  bindField("customer", "customerName"); bindField("customer-phone", "customerPhone");
  bindField("notes", "notes"); bindField("opening", "openingBalance"); bindField("tax-input", "gstPercent");
  el("received").addEventListener("input", function () {
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
        text("item-price-note", "");
        if (draft.purchasePrice > 0) field("item-markup", round((Number(draft.sellPrice) - draft.purchasePrice) / draft.purchasePrice * 100));
      }
    });
  });
  el("item-markup").addEventListener("input", function () {
    if (draft && draft.purchasePrice != null && this.value !== "") {
      text("item-price-note", "");
      field("item-rate", round(draft.purchasePrice * (1 + Number(this.value) / 100))); updateDraftTotal();
    }
  });
  el("back").addEventListener("click", function () {
    if (screen === "sale") { el("menu").hidden = !el("menu").hidden; return; }
    var next = screen === "item" && draft && !draft._rowId ? "search" : "sale";
    draft = null; document.activeElement.blur(); go(next); draw();
  });
  el("add-items").addEventListener("click", function () { go("search"); });
  el("remove-item").addEventListener("click", function () {
    if (draft && draft._rowId) {
      api.remove(draft._rowId); draft = null; go("sale"); draw();
    }
  });
  el("save").addEventListener("click", function () { if (screen === "item") saveItem(false); else if (screen === "sale") saveSale(false, false); });
  el("save-new").addEventListener("click", function () { if (screen === "item") saveItem(true); else if (screen === "sale") saveSale(true, false); else if (screen === "search") { document.activeElement.blur(); go("sale"); draw(); } });
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
  new MutationObserver(schedule).observe(document.querySelector("main.page-shell"), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["disabled", "class"] });
  media.addEventListener("change", function () { draw(); if (media.matches) go("sale"); });
  if (window.visualViewport) {
    function keyboard() {
      var offset = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
      root.style.setProperty("--phone-keyboard-offset", offset + "px");
    }
    window.visualViewport.addEventListener("resize", keyboard);
    window.visualViewport.addEventListener("scroll", keyboard);
    keyboard();
  }
  draw();
})();
