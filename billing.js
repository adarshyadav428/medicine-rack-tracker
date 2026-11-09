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

  // How many bills the history table draws. This is now also all the page
  // fetches — balance chaining pulls the one customer it needs on demand.
  var HISTORY_RENDER_LIMIT = 100;

  // -------------------------------------------------------------------------
  // Billing state
  // -------------------------------------------------------------------------
  var bState = {
    lineItems: [],        // current bill being composed
    nextRowId: 1,         // internal DOM key counter
    currentBillId: null,  // null = new bill, uuid string = editing existing
    currentBillNumber: null,
    billHistory: [],       // the rendered window only, not the whole ledger
    initialized: false,
    currentCustomerIdx: null,   // index into saved-customers array, or null
    currentCustomerBalance: 0,  // cached previous balance of selected customer
    openingBalanceTouched: false, // true once the user types in Opening Balance
    balanceCarriedForward: false, // true after first Save Bill; prevents double-add on re-save
    customerLastPrices: Object.create(null),        // { medicineName.toLowerCase(): { sellPrice, markupPercent } }
    soldCounts: Object.create(null),                // { medicineName.toLowerCase(): { count, lastSoldAt } }
    customerLastPricesFor: null,   // lowercase customer name these prices belong to
    customerLastPricesByMrp: Object.create(null),
    soldCountsByMrp: Object.create(null),
    customerPriceStatus: "idle",
    customerPriceRequest: null,
    globalPriceStatus: "idle",
    globalPriceRequest: null,
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
    editBanner:       document.getElementById("bill-edit-banner"),
    editBannerText:   document.getElementById("bill-edit-banner-text"),
    editBannerNew:    document.getElementById("bill-edit-banner-new"),
    historyContainer:      document.getElementById("bill-history-container"),
    historySearch:         document.getElementById("bill-history-search"),
    historyFrom:           document.getElementById("bill-history-from"),
    historyTo:             document.getElementById("bill-history-to"),
    historyClear:          document.getElementById("bill-history-clear"),
    historySummary:        document.getElementById("bill-history-summary"),
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

  function lineMoney(price, quantity) {
    return Math.floor((Math.round(Number(price) * 100) * Math.round(Number(quantity) * 1000) + 500) / 1000) / 100;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /**
   * Money read out of a form field.
   *
   * `parseFloat(x) || 0` let a negative through, and a negative Amount
   * Received *raises* the balance instead of clearing it — a typo of "-500"
   * silently added ₹500 to what the customer owed. The number inputs carry
   * min="0", but that only blocks the spinner, not typing or pasting.
   */
  function readMoney(el) {
    var n = parseFloat(el ? el.value : "0");
    if (!isFinite(n) || n <= 0) return 0;
    return round2(n);
  }

  function receivedAmountValue() {
    return readMoney(bEl.receivedAmount);
  }

  /**
   * The identity of a customer throughout this file. Names are unique
   * case-insensitively — the server upserts on a name key — so this is what
   * every lookup compares, and what the saved-customer dropdown is keyed by.
   */
  function customerKey(name) {
    return normalizeString(name).toLowerCase();
  }

  /** Position of a customer in the current cache, or -1. */
  function findCustomerIdx(name) {
    var key = customerKey(name);
    if (!key) return -1;
    return loadSavedCustomers().findIndex(function (c) {
      return customerKey(c.name) === key;
    });
  }

  /**
   * Escape text bound for innerHTML or a double-quoted attribute.
   * Medicine and customer names are free text: a name containing " or & used
   * to break the row, the edit dialog or the printed receipt it landed in.
   */
  /**
   * A strip is printed "11/27", so expiry is carried as MM/YYYY throughout.
   * The inventory holds a full date; this reduces it to the part that is
   * actually knowable from the pack.
   */
  function toMonthYear(dateish) {
    var raw = normalizeString(dateish);
    if (!raw) return "";
    var iso = /^(\d{4})-(\d{2})/.exec(raw);
    if (iso) return iso[2] + "/" + iso[1];
    return raw;
  }

  /**
   * Markup % from cost and selling price.
   *
   * The line-item table used to leave this box empty on a freshly added
   * medicine — the figure was only carried over when the customer had bought
   * the same item before. Both numbers are known the moment a line is added,
   * so there is no reason for it ever to be blank.
   *
   * null means genuinely unknowable: no purchase price on record, or a zero
   * cost, where a percentage of nothing has no answer. That is left blank on
   * purpose rather than shown as 0%, which would read as "sold at cost".
   */
  function computeMarkup(purchase, sell) {
    var p = parseFloat(purchase);
    var s = parseFloat(sell);
    if (isNaN(p) || isNaN(s) || p <= 0) return null;
    return round2((s - p) / p * 100);
  }

  /**
   * Which band a markup falls in, for colour only. Nothing here touches a
   * price, a line total or the bill — it is a reading aid at the counter.
   *
   * Boundaries are inclusive at the bottom: 5 is "healthy", 15 is still
   * "healthy", 15.01 is "high". Below cost gets its own band rather than
   * sharing "thin" with a small profit, because the two need opposite
   * reactions.
   */
  function markupBand(pct) {
    if (pct === null || pct === undefined || isNaN(pct)) return "none";
    var n = Number(pct);
    if (n < 0)    return "loss";
    if (n < 5)    return "thin";
    if (n <= 15)  return "healthy";
    if (n <= 25)  return "high";
    return "steep";
  }

  var MARKUP_BAND_TITLE = {
    none:    "No purchase price on record — set it in inventory first",
    loss:    "Below cost — this line loses money",
    thin:    "Under 5% — very thin margin",
    healthy: "5–15% — normal margin",
    high:    "15–25% — above normal",
    steep:   "Over 25% — check this price",
  };

  /** Paint one markup box to match its band. Presentation only. */
  function applyMarkupBand(input, pct) {
    if (!input) return;
    var band = markupBand(pct);
    input.classList.remove(
      "markup-none", "markup-loss", "markup-thin",
      "markup-healthy", "markup-high", "markup-steep"
    );
    input.classList.add("markup-" + band);
    input.title = MARKUP_BAND_TITLE[band];
  }

  function escHtml(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * What to put in the Sell box when a medicine is added to a bill.
   *
   * Most specific answer first:
   *
   *   1. What this customer was last charged for it. Their own history beats
   *      everything — a doctor on a standing rate must not be re-quoted.
   *   2. What it last went out at to anybody. This is the case that used to
   *      fall through: a first-time customer got the inventory list price even
   *      though the shop has been selling the item at a settled rate for
   *      months, so every new customer started the price over again.
   *   3. The inventory selling price, then MRP, then zero.
   *
   * Only a price above zero counts as remembered. A line saved at 0 — a sample,
   * a replacement, a half-finished bill — is a real row in the history, but
   * carrying it forward would silently zero out the next customer's bill.
   *
   * Returns the price and where it came from; the caller shows the source on
   * the line so an auto-filled rate is never mistaken for a typed one.
   */
  function pickSellPrice(medicine, customerPrice, soldStats) {
    var med = medicine || {};

    function usable(v) {
      var n = parseFloat(v);
      return isNaN(n) || n <= 0 ? null : n;
    }

    var fromCustomer = customerPrice ? usable(customerPrice.sellPrice) : null;
    if (fromCustomer !== null) {
      return { sellPrice: fromCustomer, source: "customer", soldAt: null };
    }

    var fromHistory = soldStats ? usable(soldStats.lastSellPrice) : null;
    if (fromHistory !== null) {
      return {
        sellPrice: fromHistory,
        source: "history",
        soldAt: soldStats.lastSoldAt || null,
      };
    }

    // Nothing sold yet — fall back to what inventory says the item is worth.
    var listed =
      med.sellingPrice !== null && med.sellingPrice !== undefined ? med.sellingPrice
      : (med.sellPrice !== null && med.sellPrice !== undefined ? med.sellPrice
      : (med.mrp !== null && med.mrp !== undefined ? med.mrp : 0));

    var n = parseFloat(listed);
    return { sellPrice: isNaN(n) ? 0 : n, source: "inventory", soldAt: null };
  }

  /**
   * One line saying why the Sell box holds what it holds. An auto-filled rate
   * that looks typed is the thing to avoid — the counter has to be able to see
   * that the number came from an old bill and decide whether it still stands.
   */
  function priceNoteFor(chosen) {
    if (!chosen) return "";
    if (chosen.source === "customer") return "Their last rate";
    if (chosen.source === "history") {
      return "Last sold at " + fmtMoney(chosen.sellPrice) +
        (chosen.soldAt ? " · " + fmtDate(chosen.soldAt) : "");
    }
    return "";
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
  // Saved customers (database-backed)
  //
  // The list lives in the `customers` table and each balance is DERIVED by the
  // server from that customer's bills and payments. The array below is only a
  // read cache so the synchronous callers throughout this file keep working;
  // `balance` written into it locally is an optimistic value that the next
  // refresh replaces with the server's figure.
  // -------------------------------------------------------------------------
  var savedCustomerCache = [];
  var savedCustomerReadSequence = 0;
  var billSaveInFlight = false;
  var pendingBillOperation = null;
  var pendingImportOperation = null;
  var pendingProfileOperations = Object.create(null);
  var billVersion = null;
  var billRevision = null;
  var billCustomerId = null;
  var billIssuedName = null;
  var billLoadSequence = 0;
  var cleanBillFingerprint = null;
  var billSyncInFlight = false;
  var billSyncMessage = "Saved bills are shared across your devices.";
  var billSyncReloadAvailable = false;

  function billFingerprint() {
    return JSON.stringify({
      items: bState.lineItems,
      fields: [bEl.customerName, bEl.customerPhone, bEl.notes, bEl.gstPercent,
        bEl.receivedAmount, bEl.openingBalance].map(function (el) { return el ? el.value : ""; }),
      previousBalance: bState.currentCustomerBalance
    });
  }

  function phoneItemEditorOpen() {
    var phone = document.getElementById("phone-billing");
    return document.body.classList.contains("phone-billing-active") && phone && phone.dataset.screen === "item";
  }

  function hasUnsavedBillChanges() {
    return phoneItemEditorOpen() || (cleanBillFingerprint !== null
      ? cleanBillFingerprint !== billFingerprint()
      : bState.lineItems.length > 0 || !!bEl.customerName.value || !!bEl.notes.value);
  }

  function setBillSyncStatus(message, canReload) {
    billSyncMessage = message;
    billSyncReloadAvailable = !!canReload;
    var status = document.getElementById("bill-sync-status");
    var reload = document.getElementById("bill-sync-reload");
    if (status) status.textContent = message;
    if (reload) reload.hidden = !canReload;
    notifyBillingChange("syncStatus");
  }

  // Poll only while this page is visible. The existing versioned write RPC
  // remains the authority if another device saves after this read.
  async function syncSavedBills() {
    if (!bState.initialized || !isAdmin() || document.hidden || billSyncInFlight || billSaveInFlight) return;
    billSyncInFlight = true;
    var id = bState.currentBillId, revision = billRevision, sequence = billLoadSequence;
    try {
      await refreshSavedCustomers();
      if (billSaveInFlight || sequence !== billLoadSequence) return;
      await syncSelectedCustomerBalance(true);
      if (await loadBillHistory({ background: true }) === false) throw new Error("History refresh failed");
      if (!id) {
        if (sequence === billLoadSequence) setBillSyncStatus("History refreshed. Open a saved bill to continue on this device.", false);
        return;
      }
      if (pendingBillOperation || billSaveInFlight || sequence !== billLoadSequence) return;
      var result = await requestApi("/api/bills?id=" + encodeURIComponent(id), { method: "GET" });
      if (billSaveInFlight || pendingBillOperation || sequence !== billLoadSequence || id !== bState.currentBillId || revision !== billRevision) return;
      if (!result.bill || !Array.isArray(result.items)) throw new Error("Incomplete bill response");
      if (Number(result.bill.version) !== Number(revision)) {
        if (hasUnsavedBillChanges()) {
          setBillSyncStatus("Updated on another device. Your unsaved changes are kept here. Load latest to discard them and continue with the saved bill.", true);
        } else {
          await loadBillForEdit(id, { background: true, result: result });
        }
      } else {
        setBillSyncStatus("Saved bill is up to date across your devices.", false);
      }
    } catch (error) {
      if (sequence === billLoadSequence && !billSaveInFlight) {
        setBillSyncStatus(error.status === 404
          ? "This bill is no longer available. Your local changes are kept here; check History before continuing."
          : "Could not check for updates. Your changes are kept here; reconnect and refresh before continuing.", error.status !== 404 && !!bState.currentBillId);
      }
    } finally {
      billSyncInFlight = false;
    }
  }

  function loadSavedCustomers() {
    return savedCustomerCache;
  }

  /**
   * Cache locally, then push name/phone/opening balance to the server.
   * Anything the caller touched is marked `_dirty`; rows loaded from the
   * server are clean until edited, so a routine save is not a write storm but
   * a real edit is never dropped.
   */
  async function persistSavedCustomers(list) {
    for (var customer of list) {
      if (!customer || !normalizeString(customer.name) || customer._clean && !customer._dirty) continue;
      var body = { id: customer.id, name: customer.name, phone: customer.phone || "" };
      if (!customer.id && customer.openingBalance !== undefined) body.openingBalance = customer.openingBalance;
      var profileKey = JSON.stringify(body);
      body.operationId = pendingProfileOperations[profileKey] || (pendingProfileOperations[profileKey] = operationId());
      await requestApi("/api/customers", { method: "POST", body: body });
      delete pendingProfileOperations[profileKey];
      customer._dirty = false; customer._clean = true;
    }
    await refreshSavedCustomers();
  }

  /** Pull the customer list and their server-derived balances. */
  async function refreshSavedCustomers() {
    var readSequence = ++savedCustomerReadSequence;
    try {
      var result = await requestApi("/api/customers", { method: "GET" });
      if (readSequence !== savedCustomerReadSequence) return savedCustomerCache;
      if (!Array.isArray(result.customers)) throw new Error("Incomplete customer response");
      savedCustomerCache = result.customers.map(function (c) {
        return {
          id: c.id,
          name: c.name,
          phone: c.phone || "",
          balance: parseFloat(c.balance) || 0,
          openingBalance: parseFloat(c.openingBalance) || 0,
          _clean: true,
        };
      });

      // The server returns the list sorted by name, so any index held from
      // before this refresh now points at the wrong person. Re-resolve it by
      // name. The balance is deliberately left alone: it is this bill's
      // previous balance and must not change under an open bill.
      if (bState.currentCustomerIdx !== null && bEl.customerName) {
        var openName = normalizeString(bEl.customerName.value).toLowerCase();
        bState.currentCustomerIdx = openName
          ? savedCustomerCache.findIndex(function (c) {
              return c.name.toLowerCase() === openName;
            })
          : -1;
        if (bState.currentCustomerIdx < 0) bState.currentCustomerIdx = null;
      }

      renderCustomerSelect();
      notifyBillingChange("customers");
    } catch (error) {
      if (readSequence !== savedCustomerReadSequence) throw error;
      // Carry-forward silently reading zero is worse than a visible failure —
      // it looks like the customer simply owes nothing.
      setSaveCustomerStatus(
        "⚠ Could not load customer balances: " + (error.message || "unknown error") +
          ". Saving is blocked until balances can be verified.",
        "is-warn"
      );
      throw error;
    }
    return savedCustomerCache;
  }

  /**
   * Re-read the selected customer's balance from the server and put it on an
   * open NEW bill.
   *
   * The Customers page records a payment as its own row; the balance is then
   * derived server-side as opening + Σ(bill total − received) − Σ(payments).
   * This page, though, caches that balance at the moment the customer is
   * picked. Take a payment on the Customers page (or on the counter's other
   * device) and the billing tab goes on showing — and, on save, *persisting* —
   * a previous balance that has already been paid down. Syncing on select, on
   * refocus, and once more immediately before the write keeps the two in step.
   *
   * Deliberately does nothing when a saved bill is open (its previous balance
   * is a historical snapshot, not today's figure) or when the Opening Balance
   * was typed by hand, which is the one place a manual correction lives.
   *
   * Returns {from, to} when the figure actually moved, else null.
   */
  async function syncSelectedCustomerBalance(alreadyRefreshed) {
    if (bState.currentBillId) return null;
    if (bState.openingBalanceTouched) return null;

    var name = normalizeString(bEl.customerName ? bEl.customerName.value : "");
    if (!name) return null;
    var lower = name.toLowerCase();

    if (alreadyRefreshed !== true) await refreshSavedCustomers();

    // The request is not instant and the counter does not wait for it: the
    // bill may have been cleared, a different customer typed, or the balance
    // corrected by hand while it was in flight. Any of those makes the answer
    // stale, and writing it back would undo what the user just did.
    if (billSaveInFlight && alreadyRefreshed === true || bState.currentBillId || bState.openingBalanceTouched) return null;
    if (normalizeString(bEl.customerName ? bEl.customerName.value : "").toLowerCase() !== lower) {
      return null;
    }

    var list = loadSavedCustomers();
    var idx = list.findIndex(function (c) { return c.name.toLowerCase() === lower; });
    if (idx < 0) return null;

    var was   = round2(bState.currentCustomerBalance || 0);
    var fresh = round2(parseFloat(list[idx].balance) || 0);

    bState.currentCustomerIdx     = idx;
    bState.currentCustomerBalance = fresh;
    if (bEl.openingBalance) {
      bEl.openingBalance.value = fresh !== 0 ? String(fresh) : "";
    }
    recalcPayment();

    return Math.abs(fresh - was) > 0.005 ? { from: was, to: fresh } : null;
  }

  /** Fire-and-forget sync; failures are already surfaced by the refresh. */
  function syncSelectedCustomerBalanceSoon() {
    syncSelectedCustomerBalance().catch(function () {});
  }

  // -------------------------------------------------------------------------
  // Per-bill ledger snapshots (previous balance / amount received)
  //
  // Previously "am.billPrev.<id>" and "am.billRecv.<id>" in localStorage; now
  // columns on the bills table. This map mirrors them for synchronous reads
  // and is filled from whatever bill rows the page has already loaded.
  // -------------------------------------------------------------------------
  var billLedger = {};

  function noteBillLedger(bill) {
    if (!bill || !bill.id) return;
    if (bill.previous_balance === undefined && bill.amount_received === undefined) return;
    billLedger[bill.id] = {
      prev: parseFloat(bill.previous_balance) || 0,
      recv: parseFloat(bill.amount_received) || 0,
    };
  }

  function noteBillLedgerRows(bills) {
    (bills || []).forEach(noteBillLedger);
  }

  /** Previous-balance snapshot, or null when this bill has none recorded. */
  function billPrev(billId) {
    var entry = billLedger[billId];
    return entry ? entry.prev : null;
  }

  function billRecv(billId) {
    var entry = billLedger[billId];
    return entry ? entry.recv : 0;
  }

  /** Local mirror only — the durable write rides along with the bill save. */
  function setBillLedger(billId, prev, recv) {
    if (!billId) return;
    billLedger[billId] = {
      prev: parseFloat(prev) || 0,
      recv: parseFloat(recv) || 0,
    };
  }

  function renderCustomerSelect() {
    if (!bEl.savedCustomerSelect) return;
    var list = loadSavedCustomers();

    // Every option is rebuilt below, which throws away the browser's current
    // selection. Remember who was picked and put them back afterwards — a
    // background refresh used to leave the box reading "— Select a saved
    // customer —" under a bill that plainly had one.
    var selectedKey = customerKey(bEl.savedCustomerSelect.value);
    if (!selectedKey && bEl.customerName) selectedKey = customerKey(bEl.customerName.value);

    bEl.savedCustomerSelect.textContent = "";
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = list.length ? "— Select a saved customer —" : "— No saved customers yet —";
    bEl.savedCustomerSelect.appendChild(placeholder);
    list.forEach(function (c) {
      var opt = document.createElement("option");
      // Keyed by name, never by position. The cache is replaced wholesale and
      // re-sorted by name on every refresh, so a position captured when the
      // list was drawn could point at somebody else by the time it was read
      // back — and that person's balance was then carried onto the bill.
      opt.value = c.name;
      opt.textContent = c.name + (c.phone ? "  ·  " + c.phone : "");
      bEl.savedCustomerSelect.appendChild(opt);
    });

    var still = selectedKey && list.find(function (c) {
      return customerKey(c.name) === selectedKey;
    });
    bEl.savedCustomerSelect.value = still ? still.name : "";
  }

  function onSavedCustomerChange() {
    var picked = bEl.savedCustomerSelect ? bEl.savedCustomerSelect.value : "";

    if (!customerKey(picked)) {
      bState.currentCustomerIdx = null;
      // Clearing the dropdown on a saved bill must not disturb the previous
      // balance it was raised against; that figure belongs to the bill, not to
      // whoever happens to be picked in the box.
      if (!bState.currentBillId) {
        bState.currentCustomerBalance = 0;
        bState.openingBalanceTouched  = false;
        if (bEl.openingBalance) bEl.openingBalance.value = "";
        recalcPayment();
      }
      return;
    }

    var idx = findCustomerIdx(picked);
    var c   = idx >= 0 ? loadSavedCustomers()[idx] : null;
    if (!c) return;

    bState.currentCustomerIdx = idx;
    if (bEl.customerName)  bEl.customerName.value  = c.name  || "";
    if (bEl.customerPhone) bEl.customerPhone.value = c.phone || "";
    setSaveCustomerStatus("", "");
    loadCustomerLastPrices(c.name);

    // On a saved bill the Previous Balance is the snapshot that bill was raised
    // against — a historical fact. tryAutoFillCustomer has always guarded it;
    // picking from this dropdown did not, so it quietly replaced the snapshot
    // with today's balance and a re-save wrote that onto the stored bill.
    if (bState.currentBillId) {
      recalcPayment();
      return;
    }

    bState.currentCustomerBalance = parseFloat(c.balance) || 0;
    // Picking a customer replaces whatever was in the box, so any earlier
    // manual correction is gone and the auto-sync is free to act again.
    bState.openingBalanceTouched  = false;
    if (bEl.openingBalance) bEl.openingBalance.value = bState.currentCustomerBalance || "";
    recalcPayment();
    // The cached figure shows instantly; the server's replaces it a moment
    // later if a payment has been recorded since this page loaded.
    syncSelectedCustomerBalanceSoon();
  }

  function setSaveCustomerStatus(msg, tone) {
    if (!bEl.saveCustomerStatus) return;
    bEl.saveCustomerStatus.textContent = msg || "";
    bEl.saveCustomerStatus.className = "bill-save-customer-hint" + (tone ? " " + tone : "");
  }

  async function saveCurrentCustomer() {
    if (billSaveInFlight) return;
    var name = normalizeString(bEl.customerName.value);
    if (!name) { setSaveCustomerStatus("Enter a customer name first.", "is-warn"); return; }
    var existing = loadSavedCustomers().find(function(c) { return customerKey(c.name) === customerKey(name); });
    if (!existing && billCustomerId && name === billIssuedName) {
      existing = loadSavedCustomers().find(function(c) { return c.id === billCustomerId; });
    }
    var body = { id: existing && existing.id, name: existing ? existing.name : name, phone: normalizeString(bEl.customerPhone.value) };
    // This field is a historical snapshot on saved bills, not an account target.
    if (!existing && !bState.currentBillId) body.openingBalance = bState.currentCustomerBalance || 0;
    try {
      var profileKey = JSON.stringify(body);
      body.operationId = pendingProfileOperations[profileKey] || (pendingProfileOperations[profileKey] = operationId());
      await requestApi("/api/customers", { method: "POST", body: body });
      delete pendingProfileOperations[profileKey];
      await refreshSavedCustomers();
      setSaveCustomerStatus("Customer saved.", "is-ok");
    } catch (error) { setSaveCustomerStatus("Customer was not saved: " + error.message, "is-warn"); }
  }

  // -------------------------------------------------------------------------
  // Customer ledger timeline
  //
  // A customer's balance moves for two reasons: a bill is raised (and part of
  // it possibly settled at the counter), and a standalone payment is recorded
  // against the account. Every previous-balance figure below is chained over
  // BOTH, merged in date order. Chaining over bills alone — which is what this
  // file used to do — silently overstated the balance of anyone who had ever
  // paid outside a bill, and printed that inflated figure on their receipts.
  // -------------------------------------------------------------------------

  /** Standalone payments for a customer, newest-first. Never throws. */
  async function fetchCustomerPayments(custName) {
    var name = normalizeString(custName);
    if (!name) return [];
    try {
      var result = await requestApi(
        "/api/payments?customer=" + encodeURIComponent(name),
        { method: "GET" }
      );
      return Array.isArray(result.payments) ? result.payments : [];
    } catch (error) {
      throw error;
    }
  }

  /**
   * Every bill for one customer, oldest first. Scoped server-side: the page no
   * longer holds the whole shop's history just to chain one account.
   * Their ledger snapshots are cached on the way through.
   */
  async function fetchCustomerBills(custName) {
    var name = normalizeString(custName);
    if (!name) return [];
    try {
      var result = await requestApi(
        "/api/bills?customer=" + encodeURIComponent(name),
        { method: "GET" }
      );
      var bills = Array.isArray(result.bills) ? result.bills : [];
      noteBillLedgerRows(bills);
      return bills;
    } catch (error) {
      throw error;
    }
  }

  /** Both sides of a customer's ledger, fetched together. */
  async function fetchCustomerLedger(custName) {
    var pair = await Promise.all([
      fetchCustomerBills(custName),
      fetchCustomerPayments(custName),
    ]);
    return { bills: pair[0], payments: pair[1] };
  }

  /** billRecv as the (billId, bill) callback ledger.js expects. */
  function recvFor(billId) {
    return billRecv(billId);
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

      await persistSavedCustomers(existing);
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
  async function reconcileCustomerBalance() {
    if (billSaveInFlight) return;
    var name = normalizeString(bEl.customerName.value);
    if (!name) return;
    var customer = loadSavedCustomers().find(function(c) { return customerKey(c.name) === customerKey(name); });
    if (bEl.repairBalanceBtn) bEl.repairBalanceBtn.disabled = true;
    try {
      await requestApi("/api/bills", { method: "PUT", body: {
        repairCustomerId: customer && customer.id || (name === billIssuedName ? billCustomerId : null),
        repairCustomerName: name,
        operationId: operationId()
      } });
      await refreshSavedCustomers();
      await loadBillHistory();
      if (bState.currentBillId) await loadBillForEdit(bState.currentBillId);
      else { bState.openingBalanceTouched = false; await syncSelectedCustomerBalance(); }
      setSaveCustomerStatus("Balance snapshots repaired and verified.", "is-ok");
    } catch (error) { setSaveCustomerStatus("Repair not confirmed: " + error.message, "is-warn"); }
    finally { if (bEl.repairBalanceBtn) bEl.repairBalanceBtn.disabled = false; }
  }

  // Fetch and cache the last sell price for each medicine sold to a customer.
  // Fires async (fire-and-forget) so it never blocks the UI.
  function loadCustomerLastPrices(custName, options) {
    var cname = normalizeString(custName);
    if (!cname) {
      bState.customerLastPrices    = Object.create(null);
      bState.customerLastPricesFor = null;
      bState.customerPriceRequest = null;
      bState.customerPriceStatus = "none";
      priceHistoryChanged();
      return Promise.resolve();
    }
    var key = cname.toLowerCase();
    if (bState.customerPriceRequest && bState.customerPriceRequest.key === key) return bState.customerPriceRequest.promise;
    if (!(options && options.force) && bState.customerLastPricesFor === key && bState.customerPriceStatus === "ready") return Promise.resolve();
    if (bState.customerLastPricesFor !== key) {
      bState.customerLastPrices = Object.create(null);
      bState.customerLastPricesByMrp = Object.create(null);
    }
    bState.customerLastPricesFor = key;
    bState.customerPriceStatus = "loading";
    var owner = { key: key, promise: null };
    bState.customerPriceRequest = owner;
    priceHistoryChanged();
    // Selecting a different customer also refreshes the shop-wide comparison.
    if (typeof loadSoldCounts === "function") loadSoldCounts({ force: true });
    owner.promise = requestApi("/api/bills?lastprices=1&customer=" + encodeURIComponent(cname), { method: "GET" })
      .then(function (result) {
        if (!result || result.mrpScoped !== true || !result.priceMapByMrp || !result.priceMap || typeof result.priceMap !== "object" || Array.isArray(result.priceMap)) throw new Error("Incomplete customer price history");
        // Request identity also rejects an old Alice reply after Alice → Bob → Alice.
        if (bState.customerPriceRequest === owner && bState.customerLastPricesFor === key) {
          bState.customerLastPrices = Object.assign(Object.create(null), result.priceMap);
          bState.customerLastPricesByMrp = Object.assign(Object.create(null), result.priceMapByMrp);
          bState.customerPriceStatus = "ready";
        }
      })
      .catch(function () {
        if (bState.customerPriceRequest === owner) {
          // Keep a same-customer reference, but label it unavailable/stale.
          bState.customerPriceStatus = "error";
        }
      }).finally(function () {
        if (bState.customerPriceRequest === owner) {
          bState.customerPriceRequest = null;
          priceHistoryChanged();
        }
      });
    return owner.promise;
  }

  function priceHistoryChanged() {
    if (typeof notifyBillingChange === "function") notifyBillingChange("priceHistory");
  }

  function priceCustomerName() {
    var name = normalizeString(bEl.customerName.value);
    if (bState.currentBillId && name === billIssuedName && billCustomerId) {
      var customer = loadSavedCustomers().find(function (c) { return c.id === billCustomerId; });
      if (customer) return customer.name;
    }
    return name;
  }

  function refreshPriceHistory(options) {
    if (options && options.invalidate) {
      // Reads started before a confirmed write cannot become the new reference.
      bState.customerPriceRequest = null;
      bState.globalPriceRequest = null;
    }
    return Promise.all([
      loadCustomerLastPrices(priceCustomerName(), options),
      loadSoldCounts(options)
    ]);
  }

  function priceVariantKey(name, mrp) {
    return normalizeString(name).toLowerCase() + "\u001f" + (mrp == null || mrp === "" ? "?" : Math.round(Number(mrp) * 100));
  }

  function getPriceInfo(medicineId, requestedMrp) {
    var medicine = state.items.find(function (item) { return item.id === medicineId; });
    if (!medicine) return null;
    if (arguments.length > 1) medicine = Object.assign({}, medicine, { mrp: requestedMrp });
    function recorded(value) {
      if (value === null || value === undefined || value === "") return null;
      var number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    }
    var key = priceVariantKey(medicine.medicineName, medicine.mrp);
    var customerName = priceCustomerName();
    var ownsCustomer = bState.customerLastPricesFor === customerName.toLowerCase();
    var customerPrice = ownsCustomer ? (bState.customerLastPricesByMrp || {})[key] : null;
    var sold = (bState.soldCountsByMrp || {})[key];
    var chosen = pickSellPrice(medicine, customerPrice, sold);
    return {
      mrp: recorded(medicine.mrp),
      purchasePrice: recorded(medicine.purchasePrice != null ? medicine.purchasePrice : medicine.rate),
      inventoryRate: recorded(medicine.sellingPrice != null ? medicine.sellingPrice : medicine.sellPrice),
      suggestedRate: chosen.sellPrice,
      source: chosen.source,
      customerLastRate: customerPrice ? recorded(customerPrice.sellPrice) : null,
      latestSoldRate: sold ? recorded(sold.lastSellPrice) : null,
      latestSoldAt: sold && sold.lastSoldAt || null,
      customerStatus: !customerName ? "none" : ownsCustomer ? bState.customerPriceStatus || "idle" : "idle",
      globalStatus: bState.globalPriceStatus || "idle",
      stock: recorded(medicine.quantity),
      seller: medicine.seller || "",
      location: medicine.location || ""
    };
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

  /**
   * How well a medicine name answers what was typed.
   *
   * The search used to be a plain substring test, so results came back in
   * whatever order the inventory happened to be stored in — typing "cro" could
   * put an obscure item above Crocin. Higher score wins; null means no match
   * at all.
   *
   * The tiers, strongest first:
   *   exact name              1000
   *   name starts with query   800
   *   a word starts with query 600   "cro" -> "Tab Crocin"
   *   every typed word appears 400   "cro 650" -> "Crocin 650mg", any order
   *   appears anywhere         200
   */
  function nameMatchScore(name, query, queryWords) {
    var n = String(name || "").toLowerCase().trim();
    var q = String(query || "").toLowerCase().trim();
    if (!n || !q) return null;

    if (n === q) return 1000;
    if (n.indexOf(q) === 0) return 800;

    // Word-start: the typed text begins a word somewhere in the name.
    var words = n.split(/[^a-z0-9]+/).filter(Boolean);
    for (var i = 0; i < words.length; i += 1) {
      if (words[i].indexOf(q) === 0) return 600;
    }

    // Multi-word: every typed word has to appear, in any order. This is what
    // makes "650 crocin" find Crocin 650mg.
    if (queryWords.length > 1) {
      var all = queryWords.every(function (w) { return n.indexOf(w) !== -1; });
      if (all) return 400;
    }

    if (n.indexOf(q) !== -1) return 200;
    return null;
  }

  /**
   * Sales history weight for a medicine, added on top of the name score.
   *
   * The tiers above are 200 apart and this tops out at 190, so history breaks
   * ties between comparable matches but can never float a poor name match
   * above a better one — a medicine sold a thousand times still must not
   * outrank the item whose name was actually typed.
   */
  function soldWeight(nameLower) {
    var weight = 0;

    // Sold to the customer on this bill: the strongest signal there is, since
    // repeat customers reorder the same things. Worth more on its own than
    // any amount of shop-wide volume.
    if (bState.customerLastPrices[nameLower]) weight += 110;

    var stats = bState.soldCounts[nameLower];
    if (stats) {
      // Sold at all, ever. Flat bonus first, then a gentle bump by volume:
      // logarithmic rather than linear, so a fast mover leads without a single
      // runaway item swamping everything else.
      weight += 40;
      weight += Math.min(40, Math.round(Math.log(stats.count + 1) * 12));
    }

    return weight;
  }

  function rankSearchResults(items, query) {
    var queryWords = query.split(/\s+/).filter(Boolean);

    return (items || [])
      .map(function (item) {
        var score = nameMatchScore(item.medicineName, query, queryWords);
        if (score === null) return null;

        var nameLower = String(item.medicineName || "").toLowerCase().trim();
        score += soldWeight(nameLower);

        // In stock beats out of stock among otherwise equal matches — an item
        // that cannot be handed over is rarely the one being looked for.
        var qty = parseFloat(item.quantity);
        if (!isNaN(qty) && qty > 0) score += 15;

        return { item: item, score: score, len: nameLower.length };
      })
      .filter(Boolean)
      .sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        // Shorter name wins: "Crocin" is a better answer to "crocin" than
        // "Crocin Advance Cold & Flu" is.
        if (a.len !== b.len) return a.len - b.len;
        return String(a.item.medicineName).localeCompare(String(b.item.medicineName));
      })
      .map(function (r) { return r.item; });
  }

  function handleSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      var query = (bEl.search ? bEl.search.value : "").trim().toLowerCase();
      if (!query || query.length < 2) {
        hideDropdown();
        return;
      }
      var results = rankSearchResults(state.items, query).slice(0, 12);
      renderDropdown(results, query);
    }, 150);
  }

  /**
   * Sold-counts are a ranking hint, so a failure here is silent — the search
   * still works, it just loses the history weighting.
   */
  function loadSoldCounts(options) {
    if (bState.globalPriceRequest) return bState.globalPriceRequest.promise;
    if (!(options && options.force) && bState.globalPriceStatus === "ready") return Promise.resolve();
    var owner = { promise: null };
    bState.globalPriceRequest = owner;
    bState.globalPriceStatus = "loading";
    priceHistoryChanged();
    owner.promise = requestApi("/api/bills?soldcounts=1", { method: "GET" })
      .then(function (result) {
        if (!result || result.mrpScoped !== true || !result.countsByMrp || !result.counts || typeof result.counts !== "object" || Array.isArray(result.counts)) throw new Error("Incomplete sale price history");
        if (bState.globalPriceRequest === owner) {
          bState.soldCounts = Object.assign(Object.create(null), result.counts);
          bState.soldCountsByMrp = Object.assign(Object.create(null), result.countsByMrp);
          bState.globalPriceStatus = "ready";
        }
      })
      .catch(function () {
        if (bState.globalPriceRequest === owner) bState.globalPriceStatus = "error";
      }).finally(function () {
        if (bState.globalPriceRequest === owner) {
          bState.globalPriceRequest = null;
          priceHistoryChanged();
        }
      });
    return owner.promise;
  }

  /**
   * Fold a bill that was just saved into the in-memory sold-counts.
   *
   * Those counts are fetched once when the page opens, so without this the
   * rate agreed on the first bill of the day would not be offered on the
   * second — the shop would have to reload to see its own price. Only on a new
   * bill: an edit rewrites lines that are already counted, and re-counting
   * them here would inflate the tally the search ranking reads.
   */
  function rememberSoldPrices(lineItems) {
    var now = new Date().toISOString();
    (lineItems || []).forEach(function (item) {
      var key = normalizeString(item.medicineName).toLowerCase();
      if (!key) return;
      var price = parseFloat(item.sellPrice);
      var entry = bState.soldCounts[key];
      if (!entry) {
        entry = { count: 0, lastSoldAt: null, lastSellPrice: null };
        bState.soldCounts[key] = entry;
      }
      entry.count += 1;
      entry.lastSoldAt = now;
      if (Number.isFinite(price)) entry.lastSellPrice = price;
    });
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
      var variantInfo = getPriceInfo(item.id);
      var lastPriceInfo = variantInfo.customerLastRate == null ? null : { sellPrice: variantInfo.customerLastRate };
      var soldStats = bState.soldCountsByMrp[priceVariantKey(item.medicineName,item.mrp)];

      var metaParts = [];
      if (item.seller) metaParts.push("🏢 " + escHtml(item.seller));
      if (item.location) metaParts.push("📍 " + escHtml(item.location));
      if (item.mrp !== null && item.mrp !== undefined) metaParts.push("MRP: ₹" + item.mrp);
      if (purchase !== null) metaParts.push("Buy: ₹" + purchase);
      if (sell !== null) metaParts.push("Sell: ₹" + sell);
      metaParts.push(stockLabel);

      el.innerHTML =
        '<div class="medicine-dropdown-item-content">' +
          '<div class="medicine-dropdown-name-row">' +
            '<span class="medicine-dropdown-name">' + escHtml(item.medicineName) + "</span>" +
            (lastPriceInfo
              ? '<span class="medicine-last-price-badge">Last sold: ₹' + parseFloat(lastPriceInfo.sellPrice).toFixed(2) + '</span>'
              // Says why this one is near the top when it is not this
              // customer's own history doing the lifting.
              // The price it last went out at matters more than the tally, so
              // show it whenever the history has one.
              : (soldStats
                  ? '<span class="medicine-sold-badge" title="Sold ' + soldStats.count +
                    ' time' + (soldStats.count === 1 ? "" : "s") + ' before">Sold ' +
                    soldStats.count + '&times;' +
                    (soldStats.lastSellPrice !== null && soldStats.lastSellPrice !== undefined
                      ? ' · ₹' + parseFloat(soldStats.lastSellPrice).toFixed(2)
                      : "") +
                    '</span>'
                  : "")) +
          '</div>' +
          '<span class="medicine-dropdown-meta">' + metaParts.join(" · ") + "</span>" +
        '</div>' +
        '<button class="medicine-dropdown-history-btn" type="button" title="Who bought this, and at what price">📊</button>' +
        '<button class="medicine-dropdown-edit-btn" type="button" title="Edit medicine in inventory">✏</button>';

      // Use mousedown so blur doesn't hide dropdown before click fires
      el.addEventListener("mousedown", function (e) {
        e.preventDefault();
        if (e.target.closest(".medicine-dropdown-history-btn")) {
          hideDropdown();
          openMedicineSalesModal(item.medicineName,item.mrp);
          return;
        }
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
    if (billSaveInFlight) return;
    var existing = document.getElementById("manual-add-overlay");
    if (existing) existing.parentNode.removeChild(existing);

    var overlay = document.createElement("div");
    overlay.id = "manual-add-overlay";
    overlay.className = "manual-add-overlay";
    overlay.innerHTML = [
      '<div class="manual-add-modal">',
        '<div class="manual-add-header">',
          '<h3>Add medicine to this bill only</h3>',
          '<button class="manual-add-close" id="manual-add-close" type="button" aria-label="Close">✕</button>',
        '</div>',
        '<div class="manual-add-body">',
          '<p class="manual-add-hint">Saved inside this invoice only. Not added to inventory and excluded from profit reports.</p>',
          '<div class="manual-add-fields">',
            '<div class="manual-add-field manual-add-field--wide">',
              '<label for="manual-name">Medicine Name *</label>',
              '<input type="text" id="manual-name" autocomplete="off" maxlength="200" placeholder="e.g. Paracetamol 500mg Tab" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-mrp">MRP (&#8377;) <span class="manual-optional">(optional)</span></label>',
              '<input type="number" id="manual-mrp" min="0" step="0.01" placeholder="0.00" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-purchase">Purchase Price (&#8377;) <span class="manual-optional">(optional)</span></label>',
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
          '<p class="billing-loss-warning" id="manual-loss-warning" role="status" hidden>Warning: negative markup — check this below-cost selling rate.</p>',
          '<p class="manual-add-save-status" id="manual-add-save-status"></p>',
        '</div>',
        '<div class="manual-add-footer">',
          '<button class="btn btn-ghost" id="manual-add-cancel" type="button">Cancel</button>',
          '<button class="btn btn-primary" id="manual-add-submit" type="button">Add to bill only</button>',
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

    function warnManualLoss() { document.getElementById("manual-loss-warning").hidden = !(Number(markupEl.value) < 0); }
    markupEl.addEventListener("input", warnManualLoss);
    sellEl.addEventListener("input", warnManualLoss);
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
        if (document.getElementById("manual-loss-warning")) document.getElementById("manual-loss-warning").hidden = !(Number(markupEl.value) < 0);
      }
    }

    purchaseEl.addEventListener("input", recalcSell);
    markupEl.addEventListener("input", recalcSell);
    sellEl.addEventListener("input", recalcMarkup);

    function closeModal() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      var focus = document.body.classList.contains("phone-billing-active") ? document.getElementById("phone-item-search") : bEl.search;
      if (focus) focus.focus({preventScroll:true});
    }

    async function submitManual() {
      var name = (nameEl.value || "").trim();
      if (!name) { nameEl.focus(); return; }
      var mrpRaw      = parseFloat(mrpEl.value);
      if (mrpEl.value === "") mrpRaw = null;
      else if (!mrpEl.checkValidity()) { mrpEl.reportValidity(); return; }
      var purchaseRaw = parseFloat(purchaseEl.value);
      if (purchaseEl.value === "") purchaseRaw = null;
      else if (!purchaseEl.checkValidity()) { purchaseEl.reportValidity(); return; }

      var markupRaw   = parseFloat(markupEl.value);
      // Sell price defaults to MRP if not set
      var sellRaw     = parseFloat(sellEl.value);
      if (sellEl.value === "" && mrpRaw != null) sellRaw = mrpRaw;
      if (sellRaw == null || !Number.isFinite(sellRaw) || sellRaw < 0 || !sellEl.checkValidity() || !qtyEl.checkValidity() || !markupEl.checkValidity()) {
        saveStatusEl.textContent = "Enter a valid selling rate and quantity with supported precision."; return;
      }
      // Auto-calc markup if not set but purchase & sell are known
      if (isNaN(markupRaw) && purchaseRaw > 0) {
        markupRaw = round2((sellRaw - purchaseRaw) / purchaseRaw * 100);
      }
      var locationVal = (locationEl.value || "").trim() || "—";
      var qty = Number(qtyEl.value);
      if (!Number.isFinite(qty) || qty < 0.001) { qtyEl.reportValidity(); return; }

      var submitBtn = document.getElementById("manual-add-submit");
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }
      if (saveStatusEl) { saveStatusEl.textContent = ""; saveStatusEl.className = "manual-add-save-status"; }

      var rowId = "row-" + (bState.nextRowId++);
      bState.lineItems.push({
        _rowId:        rowId,
        medicineId:    null,
        billOnly:      true,
        medicineName:  name,
        location:      locationVal,
        mrp:           mrpRaw,
        purchasePrice: purchaseRaw,
        sellPrice:     sellRaw,
        markupPercent: isNaN(markupRaw) ? null : markupRaw,
        quantity:      qty,
        batchNo:       "",
        expiry:        "",
      });

      renderLineItems();
      recalcTotals();

      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      window.dispatchEvent(new CustomEvent("medicine-bill-only-added"));
      if (bEl.search) bEl.search.value = "";
      setTimeout(function () { if (bEl.search && !document.body.classList.contains("phone-billing-active")) bEl.search.focus(); }, 0);
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
  // "Who bought this?" — sales history for one medicine
  //
  // The window itself lives in medicine-sales.js so the inventory page can open
  // the same one. Billing supplies the two things only it can: a receipt viewer
  // for the bill numbers, and the search box to hand focus back to.
  // -------------------------------------------------------------------------
  function openMedicineSalesModal(medicineName, mrp) {
    if (typeof window.showMedicineSalesModal !== "function") return;
    window.showMedicineSalesModal(medicineName, {
      mrp: mrp,
      onOpenBill: function (billId) { viewBillInModal(billId); },
      onClose: function () {
        if (document.body.classList.contains("phone-billing-active")) {
          var phone = document.getElementById("phone-billing");
          var focus = document.getElementById(phone && phone.dataset.screen === "item" ? "phone-item-qty" : "phone-item-search");
          if (focus) focus.focus({ preventScroll: true });
        } else if (bEl.search) bEl.search.focus();
      },
    });
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
              '<input type="text" id="manual-name" autocomplete="off" maxlength="200" value="' + escHtml(invItem.medicineName) + '" />',
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
              '<input type="text" id="manual-location" autocomplete="off" maxlength="100" value="' + escHtml(invItem.location) + '" />',
            '</div>',
            '<div class="manual-add-field">',
              '<label for="manual-stock-qty">Stock Qty <span class="manual-optional">(optional)</span></label>',
              '<input type="number" id="manual-stock-qty" min="0" step="1" value="' + (invItem.quantity !== null && invItem.quantity !== undefined ? invItem.quantity : "") + '" placeholder="?" />',
            '</div>',
          '</div>',
          '<p id="inventory-loss-warning" class="billing-loss-warning" role="status" hidden>Warning: negative markup — check the selling price.</p>',
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

    function warnInventoryLoss() {
      var warning = document.getElementById("inventory-loss-warning");
      if (warning) warning.hidden = !(Number(markupEl.value) < 0);
    }
    markupEl.addEventListener("input", warnInventoryLoss);
    sellEl.addEventListener("input", warnInventoryLoss);
    purchaseEl.addEventListener("input", warnInventoryLoss);
    warnInventoryLoss();
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

    // This customer's own rate, else the rate the medicine last went out at to
    // anyone, else the inventory price. See pickSellPrice for why.
    var medicineLower = (medicine.medicineName || "").toLowerCase().trim();
    var info = getPriceInfo(medicine.id);
    var chosen = {sellPrice:info.suggestedRate,source:info.source,soldAt:info.latestSoldAt};
    var sell = chosen.sellPrice;

    // Always derived from what is actually on the line, never left blank. A
    // remembered markup from the customer's last bill is not reused: the cost
    // may have moved since, and the figure shown has to describe this sale.
    var markupPct = computeMarkup(purchase, sell);

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
      // Where that rate came from, shown under the name. Not saved with the
      // bill — it describes how the box was filled, not what was sold.
      priceNote:     priceNoteFor(chosen),
      // No longer entered on the bill — the boxes were removed while the batch
      // data is still not uploaded. The columns and the API still carry these,
      // so a bill saved earlier reopens with its values intact, and putting
      // the inputs back is a matter of restoring the row in renderLineItems.
      batchNo:       "",
      expiry:        "",
    });

    var newRowId = rowId;

    renderLineItems();
    recalcTotals();

    if (bEl.search) bEl.search.value = "";

    setTimeout(function () {
      if (document.body.classList.contains("phone-billing-active")) return;
      var markupInput = document.getElementById("markup-" + newRowId);
      var sellInput   = document.getElementById("sell-"   + newRowId);
      var qtyInput    = document.getElementById("qty-"    + newRowId);
      if (window.matchMedia("(max-width: 640px)").matches && qtyInput) {
        // Price details start collapsed on a phone; focus a visible field.
        qtyInput.focus();
        qtyInput.select();
      } else if (markupInput && !markupInput.disabled) {
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

    if (field === "batchNo") {
      item.batchNo = String(rawValue || "");
      return; // text only — no totals to redraw

    } else if (field === "expiry") {
      item.expiry = String(rawValue || "");
      return;

    } else if (field === "mrp") {
      var mrp = parseFloat(rawValue);
      item.mrp = isNaN(mrp) ? null : mrp;
      return; // MRP doesn't affect totals

    } else if (field === "quantity") {
      item.quantity = Math.max(0.001, parseFloat(rawValue) || 0.001);

    } else if (field === "sellPrice") {
      var sp = parseFloat(rawValue);
      item.sellPrice = isNaN(sp) ? 0 : sp;
      // The note described the rate that was filled in, not this one.
      clearPriceNote(item, rowId);
      // Back-calculate markup %
      var markupInput = document.getElementById("markup-" + rowId);
      item.markupPercent = computeMarkup(item.purchasePrice, item.sellPrice);
      if (markupInput && item.markupPercent !== null) {
        markupInput.value = item.markupPercent;
      }
      applyMarkupBand(markupInput, item.markupPercent);

    } else if (field === "markupPercent") {
      var mp = parseFloat(rawValue);
      if (!isNaN(mp) && item.purchasePrice !== null && item.purchasePrice >= 0) {
        item.markupPercent = mp;
        item.sellPrice = round2(item.purchasePrice * (1 + mp / 100));
        var sellInput = document.getElementById("sell-" + rowId);
        if (sellInput) sellInput.value = item.sellPrice;
        clearPriceNote(item, rowId);
      } else {
        item.markupPercent = isNaN(mp) ? null : mp;
      }
      applyMarkupBand(document.getElementById("markup-" + rowId), item.markupPercent);
    }

    var lossWarning = document.getElementById("loss-" + rowId);
    if (lossWarning) lossWarning.hidden = !(item.markupPercent < 0);

    // Update line total cell
    var totalEl = document.getElementById("total-" + rowId);
    if (totalEl) {
      totalEl.textContent = fmtMoney(lineMoney(item.sellPrice, item.quantity));
    }

    recalcTotals();
  }

  /** Drop the "where this rate came from" caption once the rate is overridden. */
  function clearPriceNote(item, rowId) {
    if (!item.priceNote) return;
    item.priceNote = "";
    var noteEl = document.getElementById("pricenote-" + rowId);
    if (noteEl) noteEl.textContent = "";
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
      tr.setAttribute("role", "row");
      tr.classList.toggle("is-pricing-open", Boolean(item._pricingOpen));
      var hasPurchase = item.purchasePrice !== null && item.purchasePrice !== undefined;
      var lineTotal = lineMoney(item.sellPrice, item.quantity);

      // Recomputed at render rather than trusted from state, so a line loaded
      // from a saved bill or an import shows a figure too.
      if (item.markupPercent === null || item.markupPercent === undefined) {
        item.markupPercent = computeMarkup(item.purchasePrice, item.sellPrice);
      }
      var markupVal = item.markupPercent !== null && item.markupPercent !== undefined
        ? item.markupPercent : "";
      var sellVal = item.sellPrice !== null && item.sellPrice !== undefined
        ? item.sellPrice : "";
      var mrpVal = item.mrp !== null && item.mrp !== undefined ? item.mrp : "";
      var purchaseDisplay = hasPurchase ? fmtMoney(item.purchasePrice) : "—";

      tr.innerHTML =
        '<td role="cell">' +
          '<div class="bill-item-name" title="' + escHtml(item.medicineName) + '">' + escHtml(item.medicineName) + "</div>" +
          '<div id="loss-' + item._rowId + '" class="billing-loss-warning" role="status"' + (item.markupPercent < 0 ? '' : ' hidden') + '>Warning: negative markup — check the selling price.</div>' +
          (item.billOnly ? '<small>Bill only · excluded from profit</small>' : '') +
          '<div class="bill-item-location">' + escHtml(item.location || "—") + "</div>" +
          '<div class="bill-item-mobile-meta">Buy ' + purchaseDisplay + '</div>' +
          '<div class="bill-item-price-note" id="pricenote-' + item._rowId + '">' +
            escHtml(item.priceNote || "") +
          "</div>" +
        "</td>" +
        '<td role="cell" class="num-col bill-extra-price" id="mrp-cell-' + item._rowId + '" data-label="MRP (₹)">' +
          '<input id="mrp-' + item._rowId + '" class="bill-table-input" type="number"' +
          ' data-col="mrp" aria-label="MRP" inputmode="decimal"' +
          ' min="0" step="0.01"' +
          ' value="' + mrpVal + '"' +
          ' placeholder="—"' +
          " />" +
        "</td>" +
        '<td role="cell" class="num-col bill-purchase-col bill-extra-price" id="purchase-cell-' + item._rowId + '" data-label="Purchase (₹)"><span style="font-family:var(--font-mono);font-size:0.85rem;color:#3a5560;">' + purchaseDisplay + "</span></td>" +
        '<td role="cell" class="num-col bill-extra-price" id="markup-cell-' + item._rowId + '" data-label="Markup %">' +
          '<input id="markup-' + item._rowId + '" class="bill-table-input" type="number"' +
          ' data-col="markup" aria-label="Markup percent"' +
          ' min="-100" max="2000" step="0.01"' +
          ' value="' + markupVal + '"' +
          ' placeholder="' + (hasPurchase ? "0" : "N/A") + '"' +
          (hasPurchase ? "" : " disabled") +
          " />" +
        "</td>" +
        '<td role="cell" class="num-col" data-label="Sell price (₹)">' +
          '<input id="sell-' + item._rowId + '" class="bill-table-input bill-table-input--sell" type="number"' +
          ' data-col="sell" aria-label="Sell price" inputmode="decimal"' +
          ' min="0" step="0.01"' +
          ' value="' + sellVal + '"' +
          ' placeholder="0"' +
          " />" +
        "</td>" +
        '<td role="cell" class="num-col" data-label="Quantity">' +
          '<input id="qty-' + item._rowId + '" class="bill-table-input" type="number"' +
          ' data-col="qty" aria-label="Quantity" inputmode="decimal"' +
          ' min="0.001" step="0.001"' +
          ' value="' + item.quantity + '"' +
          ' placeholder="1"' +
          " />" +
        "</td>" +
        '<td role="cell" class="num-col" data-label="Total (₹)"><span id="total-' + item._rowId + '" class="bill-item-line-total">' + fmtMoney(lineTotal) + "</span></td>" +
        '<td role="cell">' +
          '<div class="bill-row-actions">' +
          '<button class="btn btn-ghost btn-xs bill-price-toggle" data-toggle-prices="' + item._rowId +
            '" type="button" aria-label="Price details for ' + escHtml(item.medicineName) +
            '" aria-expanded="' + Boolean(item._pricingOpen) + '" aria-controls="mrp-cell-' + item._rowId +
            ' purchase-cell-' + item._rowId + ' markup-cell-' + item._rowId + '" title="MRP, purchase price and markup">⋯</button>' +
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
    bEl.itemsTbody.querySelectorAll("[data-toggle-prices]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var item = bState.lineItems.find(function (x) { return String(x._rowId) === btn.dataset.togglePrices; });
        if (!item) return;
        item._pricingOpen = !item._pricingOpen;
        btn.closest("tr").classList.toggle("is-pricing-open", item._pricingOpen);
        btn.setAttribute("aria-expanded", String(item._pricingOpen));
      });
    });
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

      applyMarkupBand(markupInput, item.markupPercent);

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
          } else if (e.key === "Escape") {
            // Bail out of the row without reaching for the mouse.
            e.preventDefault();
            if (bEl.search) bEl.search.focus();
          } else if (e.altKey && (e.key === "Delete" || e.key === "Backspace")) {
            // Drop the wrong line the moment it is spotted. Focus goes to the
            // search box because the row under the cursor is about to vanish.
            e.preventDefault();
            removeLineItem(item._rowId);
            if (bEl.search) bEl.search.focus();
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
      // Qty is the last field on a line, so Enter goes straight back to the
      // search box for the next medicine.
      bindInput(qtyInput, "quantity", function () {
        if (bEl.search) bEl.search.focus();
      });
    });
  }

  /**
   * Tidy a typed expiry into MM/YY. Anything that is not recognisably a
   * month/year is left exactly as typed rather than mangled — a pack that
   * genuinely reads something else should still be recordable.
   */
  function normalizeExpiry(raw) {
    var s = normalizeString(raw);
    if (!s) return "";

    var m = /^(\d{1,2})\s*[\/\-.]?\s*(\d{2}|\d{4})$/.exec(s);
    if (!m) return s;

    var month = parseInt(m[1], 10);
    if (month < 1 || month > 12) return s;

    var year = m[2].length === 4 ? m[2].slice(2) : m[2];
    return String(month).padStart(2, "0") + "/" + year;
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

  function notifyBillingChange(field) {
    window.dispatchEvent(new CustomEvent("medicine-bill-change", { detail: { field: field } }));
  }

  function recalcTotals() {
    var subtotalVal = bState.lineItems.reduce(function (sum, item) {
      return sum + lineMoney(item.sellPrice, item.quantity);
    }, 0);
    subtotalVal = round2(subtotalVal);

    var gstPct = parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0;
    var gstAmt = Math.floor((Math.round(subtotalVal * 100) * Math.round(gstPct * 100) + 5000) / 10000) / 100;
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
    notifyBillingChange("total");
  }

  function recalcPayment() {
    var subtotalVal = bState.lineItems.reduce(function (sum, item) {
      return sum + lineMoney(item.sellPrice, item.quantity);
    }, 0);
    var gstPct      = parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0;
    var preRound   = round2(round2(subtotalVal) + Math.floor((Math.round(subtotalVal * 100) * Math.round(gstPct * 100) + 5000) / 10000) / 100);
    var grandTotal = Math.ceil(preRound);
    var prevBal     = bState.currentCustomerBalance || 0;
    var totalDueVal = round2(grandTotal + prevBal);
    var received    = receivedAmountValue();
    var balDue      = round2(totalDueVal - received);

    // Previous balance row — dim it when zero
    var prevRow = document.querySelector(".bill-prev-balance-row");
    if (prevRow) prevRow.style.opacity = prevBal !== 0 ? "1" : "0.38";
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
      billOnlySupported: true,
      customerName:  normalizeString(bEl.customerName  ? bEl.customerName.value  : ""),
      customerPhone: normalizeString(bEl.customerPhone ? bEl.customerPhone.value : ""),
      notes:         normalizeString(bEl.notes         ? bEl.notes.value         : ""),
      gstPercent:    gstPct,
      // Persisted on the bill so balances survive a different device/browser.
      previousBalance: bState.currentCustomerBalance || 0,
      amountReceived:  receivedAmountValue(),
      items: bState.lineItems.map(function (item) {
        return {
          medicineId:    item.medicineId,
          billOnly:      !!item.billOnly,
          medicineName:  item.medicineName,
          location:      item.location,
          mrp:           item.mrp,
          purchasePrice: item.purchasePrice,
          sellPrice:     item.sellPrice,
          markupPercent: item.markupPercent,
          quantity:      item.quantity,
          batchNo:       item.batchNo || "",
          expiry:        normalizeExpiry(item.expiry),
        };
      }),
    };
  }

  function operationId() {
    return window.crypto.randomUUID();
  }

  async function saveBill() {
    if (billSaveInFlight) return;
    if (!bState.lineItems.length || !normalizeString(bEl.customerName.value)) {
      setSaveStatus("Select a customer and add at least one medicine.", "is-warn"); return;
    }
    if (bState.currentBillId && !window.confirm("Update existing bill " + bState.currentBillNumber + "?")) return;
    billSaveInFlight = true;
    billLoadSequence += 1;
    var controls = Array.from(document.querySelectorAll("main.page-shell input, main.page-shell select, main.page-shell textarea, main.page-shell button"));
    var disabled = controls.map(function(el) { return el.disabled; });
    controls.forEach(function(el) { el.disabled = true; });
    setSaveStatus("Saving bill…", "is-info");
    var committed = false;
    try {
      if (!bState.currentBillId && !pendingBillOperation) {
        var moved = await syncSelectedCustomerBalance();
        if (moved && !window.confirm("Previous balance is now " + fmtMoney(moved.to) + ". Save using this balance?")) {
          setSaveStatus("Save cancelled; balance refreshed.", "is-warn"); return;
        }
      }
      var payload = buildSavePayload();
      var customer = loadSavedCustomers().find(function(c) { return customerKey(c.name) === customerKey(payload.customerName); });
      if (bState.currentBillId && !customer && customerKey(payload.customerName) !== customerKey(billIssuedName)) throw new Error("Save the new customer first, then select that customer to reassign this bill.");
      payload.customerId = customer && customer.id || (bState.currentBillId ? billCustomerId : null);
      if (bState.currentBillId) {
        payload.id = bState.currentBillId;
        payload.expectedUpdatedAt = billVersion;
        payload.expectedVersion = billRevision;
        if (payload.customerId && billCustomerId && payload.customerId !== billCustomerId) {
          if (!window.confirm("Move this bill and its recorded receipt to another customer?")) {
            setSaveStatus("Reassignment cancelled.", "is-warn"); return;
          }
          payload.confirmReassignment = true;
          payload.expectedBalance = customer.balance;
        }
      } else {
        payload.expectedBalance = customer ? customer.balance : payload.previousBalance;
        if (!customer || !customer.id) payload.initialOpeningBalance = customer ? customer.openingBalance : payload.previousBalance;
      }
      var fingerprint = JSON.stringify(payload);
      if (!pendingBillOperation) {
        pendingBillOperation = { fingerprint: fingerprint, id: operationId(), payload: JSON.parse(JSON.stringify(payload)) };
      } else if (pendingBillOperation.fingerprint !== fingerprint && !window.confirm("The previous save is unconfirmed. Retry the original submitted bill first? Reload the saved bill before making further changes.")) {
        setSaveStatus("Resolve the previous save before submitting a changed bill.", "is-warn"); return;
      }
      payload = JSON.parse(JSON.stringify(pendingBillOperation.payload));
      payload.operationId = pendingBillOperation.id;
      var result = await requestApi("/api/bills", { method: payload.id ? "PUT" : "POST", body: payload });
      var bill = result.bill;
      if (!bill || !bill.id) throw new Error("Save response is incomplete; retry the same operation.");
      committed = true;
      bState.currentBillId = bill.id;
      bState.currentBillNumber = bill.bill_number || result.billNumber;
      billVersion = bill.updated_at;
      billRevision = bill.version;
      if (bEl.billDateValue) bEl.billDateValue.textContent = fmtDate(bill.created_at);
      billCustomerId = bill.customer_id;
      billIssuedName = bill.customer_name;
      bState.balanceCarriedForward = true;
      noteBillLedger(bill);
      // A replay confirms the submitted snapshot, not edits made after a lost response.
      bState.lineItems = payload.items.map(function(item) { return Object.assign({}, item, { _rowId: "row-" + (bState.nextRowId++) }); });
      bEl.customerName.value = bill.customer_name;
      bEl.customerPhone.value = bill.customer_phone || "";
      bEl.notes.value = bill.notes || "";
      bEl.gstPercent.value = bill.gst_percent;
      bEl.receivedAmount.value = bill.amount_received;
      bState.currentCustomerBalance = Number(bill.previous_balance) || 0;
      bEl.openingBalance.value = bState.currentCustomerBalance || "";
      renderLineItems(); recalcTotals();
      cleanBillFingerprint = billFingerprint();
      setBillSyncStatus("Bill saved. It can now be opened from History on your other devices.", false);
      if (!payload.id) rememberSoldPrices(payload.items);
      pendingBillOperation = null;
      refreshPriceHistory({ force: true, invalidate: true });
      if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = bState.currentBillNumber;
      setSaveStatus("Bill " + bState.currentBillNumber + " saved successfully.", "is-ok");
      try { await loadBillHistory(); await refreshSavedCustomers(); }
      catch (refreshError) { setBillingStatus("Bill saved. Refresh failed: " + refreshError.message, "is-warn"); }
    } catch (error) {
      if (!committed && pendingBillOperation) {
        if (error.status && error.status < 500 && !pendingBillOperation.uncertain) pendingBillOperation = null;
        else if (!error.status || error.status >= 500) pendingBillOperation.uncertain = true;
      }
      setSaveStatus((committed ? "Bill saved, but display update failed: " : "Save not confirmed: ") + error.message, committed ? "is-ok" : "is-error");
      if (!committed && error.status === 409 && bState.currentBillId) {
        setBillSyncStatus("The saved bill or account changed. Your edits are kept here. Load latest before retrying your changes.", true);
      }
    } finally {
      billSaveInFlight = false;
      controls.forEach(function(el,i) { el.disabled = disabled[i]; });
      applyBillMode();
      if (bEl.printBillButton) bEl.printBillButton.disabled = !bState.currentBillId;
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
    var customer  = (overrides && overrides.customerName !== undefined) ? overrides.customerName : normalizeString(bEl.customerName  ? bEl.customerName.value  : "");
    var phone     = (overrides && overrides.customerPhone !== undefined) ? overrides.customerPhone : normalizeString(bEl.customerPhone ? bEl.customerPhone.value : "");
    var notes     = (overrides && overrides.notes !== undefined) ? overrides.notes : normalizeString(bEl.notes         ? bEl.notes.value         : "");
    var gstPct    = (overrides && overrides.gstPercent !== undefined) ? overrides.gstPercent : (parseFloat(bEl.gstPercent ? bEl.gstPercent.value : "0") || 0);
    var items     = (overrides && overrides.items) || bState.lineItems;
    var billNo    = (overrides && overrides.billNumber) || bState.currentBillNumber || "DRAFT";
    var prevBal   = (overrides && overrides.prevBalance  !== undefined) ? overrides.prevBalance  : (bState.currentCustomerBalance || 0);
    var received  = (overrides && overrides.received     !== undefined) ? overrides.received     : receivedAmountValue();
    // A reprinted or re-shared bill must carry the date it was actually
    // issued. Only a live draft, which has no stored date yet, falls back to
    // the clock — otherwise an old bill goes to the customer dated today.
    var issued = (overrides && overrides.createdAt) ? new Date(overrides.createdAt) : new Date();
    if (isNaN(issued.getTime())) issued = new Date();
    var dateStr  = issued.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    var timeStr  = issued.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

    var subtotal   = round2(items.reduce(function (s, it) {
      return s + (it.line_total !== undefined ? Number(it.line_total) : Math.floor((Math.round(Number(it.sell_price !== undefined ? it.sell_price : it.sellPrice) * 100) * Math.round(Number(it.quantity) * 1000) + 500) / 1000) / 100);
    }, 0));
    var gstAmt     = Math.floor((Math.round(subtotal * 100) * Math.round(Number(gstPct) * 100) + 5000) / 10000) / 100;
    var preRound   = round2(subtotal + gstAmt);
    var grandTotal = Math.ceil(preRound);
    // Shown on the receipt whenever it is non-zero. Without it the customer
    // reads "Subtotal + GST" that does not add up to the Bill Amount.
    var roundOff   = round2(grandTotal - preRound);

    var totalDue    = round2(grandTotal + prevBal);
    var balanceDue  = round2(totalDue - received);

    // A customer in credit makes totalDue negative. numToWords only handles
    // non-negative amounts — feeding it a negative one indexed past the start
    // of its word tables and printed "undefined" on the receipt.
    var absDue   = Math.abs(totalDue);
    var intPart  = Math.floor(absDue);
    var decPart  = Math.round((absDue - intPart) * 100);
    var amtWords = "Rupees " + numToWords(intPart) +
      (decPart ? " and " + numToWords(decPart) + " Paise" : "") + " Only" +
      (totalDue < 0 ? " (in credit)" : "");

    var rowsHtml = items.map(function (it, idx) {
      var name  = escHtml(it.medicine_name || it.medicineName || "—");
      var mrp   = (it.mrp !== null && it.mrp !== undefined) ? "&#8377;" + Number(it.mrp).toFixed(2) : "—";
      var qty   = it.quantity;
      var price = it.sell_price !== undefined ? it.sell_price : it.sellPrice;
      var total = it.line_total !== undefined ? Number(it.line_total) : Math.floor((Math.round(Number(price) * 100) * Math.round(Number(qty) * 1000) + 500) / 1000) / 100;
      var bg    = idx % 2 === 0 ? "#ffffff" : "#f5faf9";

      // Batch and expiry are captured and stored against the line, but they are
      // deliberately not printed: the stock data behind them has not been
      // uploaded yet, so most lines would print blank and the few that did not
      // would look inconsistent. Put the packLine back under the name here once
      // the batch data is in.

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
              // Not "TAX INVOICE": that is a document only a GST-registered
              // dealer may issue, and it has to carry a GSTIN. This shop is
              // not registered, so the receipt is a plain invoice.
              "<div style='font-size:9.5px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:rgba(255,255,255,0.55);'>INVOICE</div>" +
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
            ? "<div style='font-size:14px;font-weight:700;color:#0d2a28;'>" + escHtml(customer) + "</div>"
            : "<div style='font-size:13px;color:#7a9a96;font-style:italic;'>—</div>") +
          (phone ? "<div style='font-size:11.5px;color:#3d6560;margin-top:2px;'>Mob: " + escHtml(phone) + "</div>" : "") +
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
            (roundOff !== 0
              ? "<div style='display:flex;justify-content:space-between;padding:5px 12px;border-bottom:1px solid #dff0ed;color:#7a9a96;'>" +
                  "<span>Round Off</span><span style='font-family:monospace;'>" +
                    (roundOff > 0 ? "+" : "−") + "&#8377;" + Math.abs(roundOff).toFixed(2) +
                  "</span>" +
                "</div>"
              : "") +
            "<div style='display:flex;justify-content:space-between;padding:6px 12px;border-bottom:1px solid #dff0ed;font-size:13.5px;font-weight:700;color:#0d2a28;'>" +
              "<span>Bill Amount</span><span style='font-family:monospace;'>&#8377;" + grandTotal.toFixed(2) + "</span>" +
            "</div>" +
            (prevBal !== 0
              ? "<div style='display:flex;justify-content:space-between;padding:5px 12px;border-bottom:1px solid #dff0ed;color:#8a5500;background:#fffbf2;'>" +
                  "<span>" + (prevBal < 0 ? "Previous Credit" : "Previous Balance") + "</span><span style='font-family:monospace;'>&#8377;" + prevBal.toFixed(2) + "</span>" +
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
              "<strong>Note:</strong> " + escHtml(notes) +
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
        "<div style='text-align:center;margin-top:10px;padding-top:7px;border-top:1px dashed #c4e2de;font-size:10px;color:#9abfbb;letter-spacing:0.3px;'>This is a computer generated invoice.</div>" +

      "</div>"
    );
  }

  async function printBill() {
    if (billSaveInFlight || !bState.currentBillId) return;
    await loadAndPrintBill(bState.currentBillId);
  }

  // -------------------------------------------------------------------------
  // New-bill vs edit mode
  //
  // The form stays bound to a bill after it is saved, so that a mistake caught
  // straight away can be corrected with another Save. The cost is that the next
  // Save also targets that bill: composing the next customer's bill without
  // pressing New Bill used to overwrite the one just saved, which looked like
  // the new bill never reaching history. Nothing here changes that binding —
  // it makes it visible, and pairs it with a confirm on the overwrite itself.
  // -------------------------------------------------------------------------
  function applyBillMode() {
    var editing = !!bState.currentBillId;
    var ref     = bState.currentBillNumber || "";

    if (bEl.saveBillButton) {
      bEl.saveBillButton.textContent = editing
        ? "💾 Update Bill " + ref
        : "💾 Save Bill";
    }

    if (bEl.editBanner) bEl.editBanner.classList.toggle("hidden", !editing);
    if (bEl.editBannerText) {
      bEl.editBannerText.textContent = editing
        ? "Editing bill " + ref + " — saving will overwrite it, not create a new bill."
        : "";
    }
  }

  // -------------------------------------------------------------------------
  // New Bill
  // -------------------------------------------------------------------------
  function newBill(savedSuccessfully) {
    if (billSaveInFlight) return;
    if (savedSuccessfully !== true && bState.lineItems.length) {
      if (!window.confirm("Start a new bill? Current bill will be discarded if not saved.")) {
        return;
      }
    }

    billLoadSequence += 1;
    billVersion = null;
    billRevision = null;
    billCustomerId = null;
    billIssuedName = null;
    pendingBillOperation = null;
    cleanBillFingerprint = null;
    setBillSyncStatus("Saved bills are shared across your devices.", false);

    bState.lineItems         = [];
    bState.currentBillId     = null;
    bState.currentBillNumber = null;

    if (bEl.customerName)   bEl.customerName.value   = "";
    if (bEl.customerPhone)  bEl.customerPhone.value  = "";
    if (bEl.notes)          bEl.notes.value          = "";
    if (bEl.gstPercent)     bEl.gstPercent.value     = "0";
    if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = "New Bill";
    if (bEl.billDateValue) bEl.billDateValue.textContent = todayLong();
    if (bEl.printBillButton)   bEl.printBillButton.disabled = true;
    if (bEl.savedCustomerSelect) bEl.savedCustomerSelect.value = "";
    if (bEl.openingBalance)      bEl.openingBalance.value      = "";
    if (bEl.receivedAmount)      bEl.receivedAmount.value      = "0";
    bState.currentCustomerIdx     = null;
    bState.currentCustomerBalance = 0;
    bState.openingBalanceTouched   = false;
    bState.balanceCarriedForward   = false;
    bState.customerLastPrices      = {};
    bState.customerLastPricesFor   = null;

    setSaveStatus("", "");
    setSaveCustomerStatus("", "");
    notifyBillingChange("newBill");
    applyBillMode();
    renderLineItems();
    recalcTotals();
    if (bEl.search && !document.body.classList.contains("phone-billing-active")) bEl.search.focus();
  }

  // -------------------------------------------------------------------------
  // Import Bills
  // -------------------------------------------------------------------------
  // amount_received is read from the first row of each bill. Leaving it blank
  // imports the bill as fully unpaid, which is what an old credit ledger means.
  var CSV_HEADERS = ["date","bill_number","customer_name","customer_phone","notes","gst_percent","medicine_name","location","batch_no","expiry","quantity","mrp","purchase_price","sell_price","amount_received"];
  var CSV_TEMPLATE = CSV_HEADERS.join(",") + "\r\n" +
    "2026-06-01,AM-20260601-001,Dr. Yaswant,9616095373,,0,Calpol 500 Tab,A1,B2231,11/27,3,14.26,8.00,10.55,100\r\n" +
    "2026-06-01,AM-20260601-001,Dr. Yaswant,9616095373,,0,Cefitaxe O Tab,A2,,,2,140.60,50.00,63.00,\r\n" +
    "2026-06-01,,Dr. Sanjay,,,,Amul 500g New,,,,1,263.00,200.00,247.00,247\r\n";

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
        // `x ? ... : fallback` rewrote a genuinely parsed 0 — a zero quantity
        // became 1, and a free line's 0 price became blank. Test for "unset"
        // rather than for falsiness.
        quantity:       assigned.qty      === "" ? "1" : String(assigned.qty),
        mrp:            assigned.mrp      === "" ? ""  : String(assigned.mrp),
        purchase_price: assigned.purchase === "" ? ""  : String(assigned.purchase),
        sell_price:     assigned.sell     === "" ? ""  : String(assigned.sell),
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

  function setImportInfo(message) {
    var preview = document.getElementById("import-preview");
    var info    = document.getElementById("import-preview-info");
    if (preview) preview.classList.remove("hidden");
    if (info) info.textContent = message;
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
      try {
        importParsedRows = parseCSV(e.target.result);
        renderImportPreview(importParsedRows);
      } catch (err) {
        setImportInfo("Could not read that file: " + (err.message || "unknown error"));
      }
    };
    // Without this, an unreadable file simply did nothing and looked ignored.
    reader.onerror = function () {
      setImportInfo("Could not read that file. Check it is not open in another program.");
    };
    reader.readAsText(file);
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
      var importFingerprint = JSON.stringify(importParsedRows);
      if (!pendingImportOperation || pendingImportOperation.fingerprint !== importFingerprint) pendingImportOperation = { fingerprint: importFingerprint, id: operationId() };
      var data = await requestApi("/api/import-bills", { method: "POST", body: { rows: importParsedRows, operationId: pendingImportOperation.id } });
      pendingImportOperation = null;
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
  /** Current search box / date range, as query parameters. */
  function historyQuery() {
    var params = [];
    var term = normalizeString(bEl.historySearch ? bEl.historySearch.value : "");
    var from = bEl.historyFrom ? bEl.historyFrom.value : "";
    var to   = bEl.historyTo   ? bEl.historyTo.value   : "";
    if (term) params.push("search=" + encodeURIComponent(term));
    if (from) params.push("from=" + encodeURIComponent(from));
    if (to)   params.push("to="   + encodeURIComponent(to));
    return { qs: params.length ? "?" + params.join("&") : "", active: params.length > 0, term: term };
  }

  function setHistorySummary(msg, tone) {
    if (!bEl.historySummary) return;
    bEl.historySummary.textContent = msg || "";
    bEl.historySummary.className = "bill-history-summary" + (tone ? " " + tone : "");
  }

  // A search is a round trip, so a stale reply must not overwrite a newer one.
  var historyRequestSeq = 0;

  async function loadBillHistory(options) {
    var background = options && options.background;
    var query = historyQuery();
    var mySeq = ++historyRequestSeq;

    if (query.active && !background) setHistorySummary("Searching…");

    try {
      // Only the matching window. Balance chaining used to force the whole
      // table down the wire here on every save; it now fetches just the one
      // customer it is chaining, via fetchCustomerLedger().
      var result = await requestApi("/api/bills" + query.qs, { method: "GET" });
      if (mySeq !== historyRequestSeq) return; // a later search already answered
      if (!Array.isArray(result.bills)) throw new Error("Incomplete bill history response");

      bState.billHistory = result.bills || [];
      noteBillLedgerRows(bState.billHistory);
      renderBillHistory();

      if (!query.active) {
        setHistorySummary(
          bState.billHistory.length >= HISTORY_RENDER_LIMIT
            ? "Showing the " + HISTORY_RENDER_LIMIT + " most recent bills. Search to reach older ones."
            : bState.billHistory.length + " bill(s)."
        );
      } else if (!bState.billHistory.length) {
        setHistorySummary(
          "No bills match" + (query.term ? ' "' + query.term + '"' : " that date range") + ".",
          "is-warn"
        );
      } else {
        var total = bState.billHistory.reduce(function (sum, b) {
          return sum + Math.ceil(parseFloat(b.grand_total) || 0);
        }, 0);
        setHistorySummary(
          bState.billHistory.length + " bill(s) found · total " + fmtMoney(total) +
            (result.truncated ? " — showing the most recent matches only; narrow the search to see the rest." : ""),
          result.truncated ? "is-warn" : ""
        );
      }
      return true;
    } catch (error) {
      if (mySeq !== historyRequestSeq) return;
      if (background) return false;
      setHistorySummary("");
      if (bEl.historyContainer) {
        bEl.historyContainer.innerHTML =
          '<p class="status-message is-error">Could not load bill history: ' +
          escHtml(error.message || "Unknown error") + "</p>";
      }
    }
  }

  function initHistorySearch() {
    var timer = null;
    function debounced() {
      clearTimeout(timer);
      timer = setTimeout(loadBillHistory, 300);
    }

    if (bEl.historySearch) {
      bEl.historySearch.addEventListener("input", debounced);
      bEl.historySearch.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); loadBillHistory(); }
        // A search box's native clear button fires "search", but Escape does
        // not always, so reset explicitly.
        if (e.key === "Escape") { bEl.historySearch.value = ""; clearTimeout(timer); loadBillHistory(); }
      });
      bEl.historySearch.addEventListener("search", function () {
        clearTimeout(timer);
        loadBillHistory();
      });
    }

    // Dates change one whole step at a time, so they reload immediately.
    if (bEl.historyFrom) bEl.historyFrom.addEventListener("change", loadBillHistory);
    if (bEl.historyTo)   bEl.historyTo.addEventListener("change", loadBillHistory);

    if (bEl.historyClear) {
      bEl.historyClear.addEventListener("click", function () {
        if (bEl.historySearch) bEl.historySearch.value = "";
        if (bEl.historyFrom)   bEl.historyFrom.value   = "";
        if (bEl.historyTo)     bEl.historyTo.value     = "";
        clearTimeout(timer);
        loadBillHistory();
      });
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
  // Only used for old bills that predate the per-bill ledger snapshot.
  async function inferPrevBalanceFromHistory(bill) {
    if (!bill || !bill.customer_name) return 0;
    var cname = bill.customer_name.toLowerCase();
    var custList = loadSavedCustomers();
    var custIdx = custList.findIndex(function(c) { return c.name.toLowerCase() === cname; });
    if (custIdx < 0) return 0;

    // Walk the merged bill+payment timeline backwards from today's balance.
    var ledger = await fetchCustomerLedger(bill.customer_name);
    var events = Ledger.buildTimeline(ledger.bills, ledger.payments, "desc");
    var snaps  = Ledger.chainBackward(events, custList[custIdx].balance, recvFor);

    var match = snaps.find(function (s) { return s.id === bill.id; });
    return match ? match.previousBalance : 0;
  }

  /**
   * The previous balance and amount received to print on a stored bill.
   * Uses the bill's own snapshot where it has one; only bills that predate the
   * snapshot columns fall back to inferring it from the ledger.
   */
  async function resolveBillLedger(billId, bill) {
    if (billPrev(billId) !== null) {
      return { prev: billPrev(billId) || 0, recv: billRecv(billId) };
    }
    return { prev: await inferPrevBalanceFromHistory(bill), recv: 0 };
  }

  async function viewBillInModal(billId) {
    try {
      var result = await requestApi("/api/bills?id=" + encodeURIComponent(billId), { method: "GET" });
      var bill   = result.bill;
      noteBillLedger(bill);
      var items  = result.items || [];
      var ledger = await resolveBillLedger(billId, bill);
      var prevBal = ledger.prev, received = ledger.recv;
      var html   = buildReceiptHtml({
        billNumber:    bill.bill_number,
        createdAt:     bill.created_at,
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
      noteBillLedger(bill);
      var items  = result.items || [];
      var ledger = await resolveBillLedger(billId, bill);
      var prevBal = ledger.prev, received = ledger.recv;
      var html   = buildReceiptHtml({
        billNumber:    bill.bill_number,
        createdAt:     bill.created_at,
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
      // A filtered-to-nothing list is not an empty shop; the summary line
      // above says which it is.
      bEl.historyContainer.innerHTML = historyQuery().active
        ? '<p class="empty-state">No bills match this search.</p>'
        : '<p class="empty-state">No bills created yet.</p>';
      return;
    }

    // The server already bounds this — the plain list to the most recent
    // window, a search to a wider one — so everything returned is drawn.
    var rowsHtml = bState.billHistory.map(function (bill) {
      return (
        "<tr>" +
          '<td><span class="bill-history-number">' + escHtml(bill.bill_number) + "</span></td>" +
          "<td>" + fmtDate(bill.created_at) + "</td>" +
          "<td>" + (bill.customer_name
            ? escHtml(bill.customer_name)
            : '<span style="color:var(--muted)">Walk-in</span>') +
          "</td>" +
          '<td style="font-family:var(--font-mono);font-size:0.78rem;color:var(--muted);">' +
            escHtml(bill.created_by) +
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
      if (billSaveInFlight) return;
      var target = bState.billHistory.find(function(b) { return b.id === billId; });
      await requestApi("/api/bills?id=" + encodeURIComponent(billId) + "&operationId=" + encodeURIComponent(operationId()) + (target && target.updated_at ? "&expectedUpdatedAt=" + encodeURIComponent(target.updated_at) : "") + (target && target.version ? "&expectedVersion=" + encodeURIComponent(target.version) : ""), { method: "DELETE" });
      // If the deleted bill is the one currently being edited, reset the form
      if (bState.currentBillId === billId) {
        bState.currentBillId     = null;
        bState.currentBillNumber = null;
        if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = "New Bill";
    if (bEl.billDateValue) bEl.billDateValue.textContent = todayLong();
        if (bEl.printBillButton)   bEl.printBillButton.disabled = true;
        setSaveStatus("Deleted bill " + billNumber + ".", "is-info");
        applyBillMode();
      }
      await loadBillHistory();
    } catch (err) {
      window.alert("Could not delete bill: " + (err.message || "Unknown error"));
    }
  }

  async function loadBillForEdit(billId, options) {
    options = options || {};
    if (billSaveInFlight) return false;
    if (pendingBillOperation) {
      setSaveStatus("Resolve the unconfirmed save before loading another bill. Retry Save to confirm the original transaction.", "is-warn");
      return false;
    }
    if (!options.background && hasUnsavedBillChanges() && !window.confirm("Discard your unsaved changes and load the latest saved bill?")) return false;
    var startingFingerprint = billFingerprint();
    var loadSequence = ++billLoadSequence;
    try {
      if (!options.background) setBillingStatus("Loading bill for editing…", "is-info");
      var result = options.result || await requestApi("/api/bills?id=" + encodeURIComponent(billId), { method: "GET" });
      var bill  = result.bill;
      if (loadSequence !== billLoadSequence || billSaveInFlight) return false;
      if (startingFingerprint !== billFingerprint()) {
        setBillSyncStatus("You edited while the bill was loading. Your changes are kept here; choose the saved bill again when ready.", !!bState.currentBillId);
        return false;
      }
      if (!bill || bill.id !== billId || !Array.isArray(result.items)) throw new Error("Incomplete bill response");
      pendingBillOperation = null;
      billVersion = bill.updated_at;
      billRevision = bill.version;
      if (bEl.billDateValue) bEl.billDateValue.textContent = fmtDate(bill.created_at);
      billCustomerId = bill.customer_id;
      billIssuedName = bill.customer_name;
      noteBillLedger(bill);
      var items = result.items || [];

      bState.currentBillId     = bill.id;
      bState.currentBillNumber = bill.bill_number;
      applyBillMode();
      bState.balanceCarriedForward  = true; // prevent new-bill balance logic on re-save

      bState.lineItems = items.map(function (it) {
        return {
          _rowId:        "row-" + (bState.nextRowId++),
          medicineId:    it.medicine_id,
          billOnly:      !!it.bill_only,
          medicineName:  it.medicine_name,
          location:      it.location,
          mrp:           it.mrp !== null ? Number(it.mrp) : null,
          purchasePrice: it.purchase_price !== null ? Number(it.purchase_price) : null,
          sellPrice:     Number(it.sell_price) || 0,
          markupPercent: it.markup_percent !== null ? Number(it.markup_percent) : null,
          quantity:      Number(it.quantity) || 1,
          batchNo:       it.batch_no || "",
          expiry:        it.expiry   || "",
        };
      });

      if (bEl.customerName)   bEl.customerName.value   = bill.customer_name  || "";
      if (bEl.customerPhone)  bEl.customerPhone.value  = bill.customer_phone || "";
      if (bEl.notes)          bEl.notes.value          = bill.notes          || "";
      if (bEl.gstPercent)     bEl.gstPercent.value     = bill.gst_percent    || "0";
      if (bEl.receivedAmount) bEl.receivedAmount.value = bill.amount_received == null ? "0" : String(bill.amount_received);
      if (bEl.billNumberPreview) bEl.billNumberPreview.textContent = bill.bill_number;
      if (bEl.printBillButton)   bEl.printBillButton.disabled = false;

      // Restore the previous-balance snapshot so the form & receipt show the
      // correct "Previous Balance" for this specific bill. Account adjustments
      // are separate; editing this field must not rewrite historical balances.
      var _storedPrev = (billPrev(bill.id) || 0);
      bState.currentCustomerBalance  = _storedPrev;
      bState.openingBalanceTouched   = false;
      if (bEl.openingBalance) bEl.openingBalance.value = _storedPrev !== 0 ? String(_storedPrev) : "";

      // Mark the customer as already resolved so tryAutoFillCustomer doesn't
      // fire on blur and overwrite the opening balance with the customer's
      // current stored balance.
      if (bill.customer_name) {
        var _cl2 = loadSavedCustomers();
        var _ci2 = _cl2.findIndex(function (c) {
          return c.name.toLowerCase() === bill.customer_name.toLowerCase();
        });
        if (_ci2 >= 0) bState.currentCustomerIdx = _ci2;
        var priceCustomer = _cl2.find(function(c) { return c.id === bill.customer_id; });
        loadCustomerLastPrices(priceCustomer ? priceCustomer.name : bill.customer_name);
      }

      notifyBillingChange("loadBill");
      renderLineItems();
      recalcTotals();
      cleanBillFingerprint = billFingerprint();
      setBillSyncStatus(options.background ? "Latest changes from your other device loaded." : "Latest saved bill loaded. Changes you save here will be available on your other devices.", false);

      var editMsg = items.length === 0
        ? "Bill loaded for editing. No saved line items found — please re-add medicines above, then click Save Bill."
        : "Bill loaded for editing. Make changes then click Save Bill.";
      setSaveStatus(editMsg, "is-info");
      setBillingStatus("", "");

      // Scroll to top of form
      if (bEl.billFormSection && !options.background) {
        bEl.billFormSection.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return true;
    } catch (error) {
      setBillingStatus("Could not load bill: " + (error.message || "Unknown error"), "is-error");
      return false;
    }
  }

  async function loadAndPrintBill(billId) {
    try {
      var result = await requestApi("/api/bills?id=" + encodeURIComponent(billId), { method: "GET" });
      var bill  = result.bill;
      noteBillLedger(bill);
      var items = result.items || [];

      if (!bEl.printArea) return;
      var ledger = await resolveBillLedger(billId, bill);
      var prevBal = ledger.prev, received = ledger.recv;
      bEl.printArea.innerHTML = buildReceiptHtml({
        billNumber:    bill.bill_number,
        createdAt:     bill.created_at,
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
    var addOnlyButton = document.getElementById("bill-add-only");
    if (addOnlyButton) addOnlyButton.addEventListener("click", function () { showManualAddModal(bEl.search.value); });
    initImportModal();
    initHistorySearch();

    // Opening balance field directly drives recalcPayment. Typing here is also
    // what pins the figure: a hand-entered correction outranks the server's
    // derived balance, so the auto-sync stands down until the customer is
    // re-picked or the bill is cleared.
    if (bEl.openingBalance) {
      bEl.openingBalance.addEventListener("input", function () {
        bState.currentCustomerBalance = parseFloat(bEl.openingBalance.value) || 0;
        bState.openingBalanceTouched  = true;
        recalcPayment();
      });
    }

    // Coming back to this tab is the moment a payment taken on the Customers
    // page — or on the shop's other device — needs to land on the open bill.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") syncSelectedCustomerBalanceSoon();
    });
    window.addEventListener("focus", syncSelectedCustomerBalanceSoon);

    // Auto-fill the balance when the finished customer name (or, for an unnamed
    // bill, the phone) exactly matches a saved customer.
    //
    // This deliberately runs on blur only. A debounced version used to run
    // while typing: "Ram Kumar" matched saved customer "Ram" after 400ms,
    // replaced the phone with Ram's, and pinned currentCustomerIdx to Ram — so
    // the finished bill printed Ram's previous balance and Ram Kumar was never
    // created. It also never overwrites the name that was typed; only a field
    // the user left blank is filled in.
    function tryAutoFillCustomer() {
      var name  = (bEl.customerName  ? bEl.customerName.value  : "").trim();
      var phone = (bEl.customerPhone ? bEl.customerPhone.value : "").trim();
      if (!name && !phone) return;

      var list = loadSavedCustomers();
      // Name is the identity. Phone only resolves a customer when no name has
      // been typed, because a household commonly shares one number.
      var idx = name
        ? findCustomerIdx(name)
        : list.findIndex(function (c) { return c.phone && c.phone === phone; });

      if (idx < 0) {
        // Typing a name that is not on file means this is a new customer, so
        // any customer resolved earlier must be released — otherwise their
        // balance would be carried onto this bill.
        //
        // Not while editing a saved bill: there the Opening Balance box holds
        // that bill's own previous-balance snapshot, which is not derived from
        // the customer list and must not be cleared out from under the user.
        if (name && !bState.currentBillId && bState.currentCustomerIdx !== null) {
          bState.currentCustomerIdx     = null;
          bState.currentCustomerBalance = 0;
          bState.openingBalanceTouched  = false;
          if (bEl.openingBalance)      bEl.openingBalance.value      = "";
          if (bEl.savedCustomerSelect) bEl.savedCustomerSelect.value = "";
          bState.customerLastPrices    = Object.create(null);
          bState.customerLastPricesFor = null;
          recalcPayment();
        }
        return;
      }
      var c = list[idx];

      // Compare who is resolved, not where they sit. A refresh re-sorts the
      // cache, so the same position can be a different person — and matching
      // on it skipped the work for a customer that had genuinely changed.
      if (bState.currentCustomerIdx !== null &&
          list[bState.currentCustomerIdx] &&
          customerKey(list[bState.currentCustomerIdx].name) === customerKey(c.name)) {
        bState.currentCustomerIdx = idx;
        return;
      }

      bState.currentCustomerIdx = idx;
      if (bEl.customerName  && !name)  bEl.customerName.value  = c.name  || "";
      if (bEl.customerPhone && !phone) bEl.customerPhone.value = c.phone || "";
      if (bEl.savedCustomerSelect) bEl.savedCustomerSelect.value = c.name;
      loadCustomerLastPrices(c.name);

      // On a saved bill the Previous Balance is the snapshot that bill was
      // raised against — a historical fact. Only a new bill picks up the
      // customer's balance as it stands today.
      if (!bState.currentBillId) {
        bState.currentCustomerBalance = parseFloat(c.balance) || 0;
        bState.openingBalanceTouched  = false;
        if (bEl.openingBalance) {
          bEl.openingBalance.value = bState.currentCustomerBalance !== 0 ? bState.currentCustomerBalance : "";
        }
        recalcPayment();
        syncSelectedCustomerBalanceSoon();
      }
    }
    if (bEl.customerName)  bEl.customerName.addEventListener("blur",  tryAutoFillCustomer);
    if (bEl.customerPhone) bEl.customerPhone.addEventListener("blur", tryAutoFillCustomer);

    // Search events
    if (bEl.search) {
      bEl.search.addEventListener("input", handleSearchInput);
      bEl.search.addEventListener("blur", function () {
        setTimeout(function () {
          // A quick return to search must not close newly rendered results.
          if (document.activeElement !== bEl.search &&
              !(bEl.dropdown && bEl.dropdown.contains(document.activeElement))) {
            hideDropdown();
          }
        }, 200);
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
    if (bEl.receivedAmount) {
      bEl.receivedAmount.addEventListener("input", function () { recalcPayment(); notifyBillingChange("received"); });
      // The totals already ignore a negative or unparseable entry; put the
      // field itself straight once the user leaves it, so what is on screen is
      // what the bill will carry.
      bEl.receivedAmount.addEventListener("change", function () {
        var clean = receivedAmountValue();
        var typed = (bEl.receivedAmount.value || "").trim();
        if (typed !== "" && String(clean) !== typed) bEl.receivedAmount.value = String(clean);
        recalcPayment();
        notifyBillingChange("received");
      });
    }

    // Action buttons
    if (bEl.saveBillButton)  bEl.saveBillButton.addEventListener("click", saveBill);
    if (bEl.printBillButton) bEl.printBillButton.addEventListener("click", printBill);
    if (bEl.newBillButton)   bEl.newBillButton.addEventListener("click", newBill);
    if (bEl.editBannerNew)   bEl.editBannerNew.addEventListener("click", newBill);

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

    initKeyboardShortcuts();

    // Initial render
    setBillingStatus("Ready. Search for medicines to start a new bill.", "is-ok");
    applyBillMode();
    renderLineItems();
    recalcTotals();
    loadBillHistory();
    refreshSavedCustomers().catch(function () { /* visible error already displayed */ });
    loadSoldCounts();
    var syncRefresh = document.getElementById("bill-sync-refresh");
    var syncReload = document.getElementById("bill-sync-reload");
    if (syncRefresh) syncRefresh.addEventListener("click", syncSavedBills);
    if (syncReload) syncReload.addEventListener("click", function () {
      if (bState.currentBillId) loadBillForEdit(bState.currentBillId);
    });
    setInterval(syncSavedBills, 2000);
    window.addEventListener("focus", syncSavedBills);
    window.addEventListener("focus", function () { if (isAdmin()) refreshPriceHistory({ force: true }); });
    window.addEventListener("online", syncSavedBills);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        syncSavedBills();
        if (isAdmin()) refreshPriceHistory({ force: true });
      }
    });

    // A bill always starts with a medicine, so start with the cursor there.
    setTimeout(function () {
      // The phone adapter may not have rendered its body class yet. Never
      // focus the hidden desktop search and scroll a newly opened phone page.
      if (bEl.search && !window.matchMedia("(max-width: 980px) and (pointer: coarse)").matches) bEl.search.focus();
    }, 0);
  }

  // -------------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------------

  /**
   * Whole-bill keyboard control, so a counter sale never needs the trackpad.
   *
   * Alt+letter rather than plain letters, because every field on this page is
   * a text box and a bare hotkey would be unusable. AltGr is explicitly not
   * treated as Alt: on an Indian layout AltGr produces characters, and the
   * browser reports it as Ctrl+Alt, so ctrlKey must be false for a match.
   */
  function initKeyboardShortcuts() {
    function focusField(el) {
      if (!el || el.disabled) return;
      el.focus();
      if (typeof el.select === "function") el.select();
    }

    function clickIfEnabled(btn) {
      if (btn && !btn.disabled) btn.click();
    }

    document.addEventListener("keydown", function (e) {
      // A modal owns the keyboard while it is open — it has its own Escape and
      // Enter handling, and stealing focus out from under it would be worse
      // than no shortcut at all.
      if (document.querySelector(".manual-add-overlay")) return;
      if (bEl.receiptModal && !bEl.receiptModal.classList.contains("hidden")) return;
      // Only while the billing page is the one on screen.
      if (bEl.billFormSection && bEl.billFormSection.offsetParent === null) return;

      // Ctrl shortcuts. These take over three keys the browser already owns —
      // Ctrl+F (find in page), Ctrl+S (save page) — on purpose: on this page
      // "find" means find a medicine and "save" means save the bill, and the
      // browser's versions are of no use at a shop counter. preventDefault is
      // what stops the browser dialog appearing behind ours.
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key === "Enter") {
          e.preventDefault();
          clickIfEnabled(bEl.saveBillButton);
        } else if (e.code === "KeyF") {
          e.preventDefault();
          focusField(bEl.search);
        } else if (e.code === "KeyS") {
          e.preventDefault();
          clickIfEnabled(bEl.saveBillButton);
        }
        return;
      }

      // ctrlKey is still rejected here: anything reaching this line with both
      // Ctrl and Alt is AltGr, which on an Indian layout is typing, not a
      // shortcut.
      if (!e.altKey || e.ctrlKey || e.metaKey) {
        // F2 is the one no-modifier shortcut: back to the medicine box, which
        // is where the next line always starts.
        if (e.key === "F2") {
          e.preventDefault();
          focusField(bEl.search);
        }
        return;
      }

      // e.code, not e.key: Alt+letter reports an accented or dead key on some
      // layouts, but the physical key code stays KeyC either way.
      switch (e.code) {
        case "KeyM": e.preventDefault(); focusField(bEl.search); break;
        case "KeyC": e.preventDefault(); focusField(bEl.customerName); break;
        case "KeyH": e.preventDefault(); focusField(bEl.customerPhone); break;
        case "KeyO": e.preventDefault(); focusField(bEl.notes); break;
        case "KeyR": e.preventDefault(); focusField(bEl.receivedAmount); break;
        case "KeyS": e.preventDefault(); clickIfEnabled(bEl.saveBillButton); break;
        case "KeyI": e.preventDefault(); clickIfEnabled(bEl.printBillButton); break;
        case "KeyN": e.preventDefault(); clickIfEnabled(bEl.newBillButton); break;
        case "KeyF": e.preventDefault(); focusField(bEl.historySearch); break;
        default: break;
      }
    });
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
  // The phone screens use the same bill, customer events and save path as the
  // counter UI. Item edits stay in a draft until the user saves that item.
  window.MedicineBilling = {
    ready: function () { return bState.initialized && isAdmin(); },
    snapshot: function () {
      return {
        canViewProfit: isAdmin() && !!state.auth.user && state.auth.user.canViewProfit === true,
        items: bState.lineItems.map(function (item) { return Object.assign({}, item); }),
        customers: loadSavedCustomers().map(function (customer) { return Object.assign({}, customer); }),
        id: bState.currentBillId,
        number: bState.currentBillNumber || "New bill",
        date: bEl.billDateValue ? bEl.billDateValue.textContent : "",
        customerName: bEl.customerName.value,
        customerId: billCustomerId,
        issuedCustomerName: billIssuedName,
        customerPhone: bEl.customerPhone.value,
        notes: bEl.notes.value,
        gstPercent: bEl.gstPercent.value,
        received: receivedAmountValue(),
        receivedInput: bEl.receivedAmount.value,
        openingInput: bEl.openingBalance.value,
        previousBalance: bState.currentCustomerBalance || 0,
        subtotal: bEl.subtotal.textContent,
        tax: bEl.gstAmount.textContent,
        total: bEl.grandTotal.textContent,
        totalAmount: Number(bEl.grandTotal.textContent.replace(/[^0-9.-]/g, "")),
        balance: bEl.balanceDue.textContent,
        roundOff: bEl.roundOffAmount.textContent,
        saving: bEl.saveBillButton.disabled,
        status: bEl.saveStatus.textContent,
        statusTone: bEl.saveStatus.className,
        customerStatus: bEl.saveCustomerStatus.textContent,
        syncStatus: billSyncMessage,
        syncReloadAvailable: billSyncReloadAvailable,
        error: bEl.status.classList.contains("is-error") ? bEl.status.textContent : "",
      };
    },
    setField: function (field, value, eventName) {
      if (billSaveInFlight) return;
      var fields = { customerName: bEl.customerName, customerPhone: bEl.customerPhone,
        notes: bEl.notes, gstPercent: bEl.gstPercent, received: bEl.receivedAmount,
        openingBalance: bEl.openingBalance, savedCustomer: bEl.savedCustomerSelect };
      var input = fields[field];
      if (!input) return;
      input.value = value;
      input.dispatchEvent(new Event(eventName || "input", { bubbles: true }));
    },
    search: function (query) { return rankSearchResults(state.items, query.toLowerCase().trim()).slice(0, 40); },
    priceInfo: getPriceInfo,
    refreshPriceHistory: refreshPriceHistory,
    lineTotal: lineMoney,
    salesHistory: function (medicineId, mrp) {
      var medicine = state.items.find(function (item) { return item.id === medicineId; });
      if (medicine) return openMedicineSalesModal(medicine.medicineName,arguments.length > 1 ? mrp : medicine.mrp);
    },
    draft: function (medicineId) {
      var medicine = state.items.find(function (item) { return item.id === medicineId; });
      if (!medicine) return null;
      var info = getPriceInfo(medicineId);
      var chosen = { sellPrice: info.suggestedRate, source: info.source, soldAt: info.source === "history" ? info.latestSoldAt : null };
      var purchase = info.purchasePrice;
      return { medicineId: medicine.id, medicineName: medicine.medicineName, quantity: 1,
        sellPrice: Number(chosen.sellPrice) || 0, purchasePrice: purchase == null ? null : Number(purchase),
        mrp: medicine.mrp, markupPercent: computeMarkup(purchase, chosen.sellPrice),
        priceNote: priceNoteFor(chosen), location: medicine.location || "" };
    },
    commit: function (draft) {
      if (billSaveInFlight) return false;
      if (!draft || !Number.isFinite(Number(draft.quantity)) || Number(draft.quantity) <= 0 ||
          !Number.isFinite(Number(draft.sellPrice)) || Number(draft.sellPrice) < 0) return false;
      var item = draft._rowId && bState.lineItems.find(function (line) { return line._rowId === draft._rowId; });
      if (draft._rowId && !item) return false;
      if (!item) {
        var medicine = state.items.find(function (line) { return line.id === draft.medicineId; });
        if (!medicine) return false;
        addLineItem(medicine);
        item = bState.lineItems[bState.lineItems.length - 1];
      }
      item.quantity = Number(draft.quantity);
      if (item.sellPrice !== Number(draft.sellPrice)) item.priceNote = "";
      item.sellPrice = Number(draft.sellPrice);
      item.mrp = draft.mrp === "" || draft.mrp == null ? null : Number(draft.mrp);
      item.markupPercent = computeMarkup(item.purchasePrice, item.sellPrice);
      if (draft.batchNo !== undefined) item.batchNo = String(draft.batchNo || "");
      if (draft.expiry !== undefined) item.expiry = normalizeExpiry(draft.expiry);
      renderLineItems();
      recalcTotals();
      return true;
    },
    remove: function(id) { if (!billSaveInFlight) removeLineItem(id); },
    editBill: loadBillForEdit,
    saveCustomer: saveCurrentCustomer,
    newBillOnlyItem: function () { showManualAddModal("", true); },
    refreshSavedBills: syncSavedBills,
    reloadBill: function () { return bState.currentBillId ? loadBillForEdit(bState.currentBillId) : Promise.resolve(false); },
    newBill: newBill,
    save: async function (andNew) {
      await saveBill();
      var success = bEl.saveStatus.classList.contains("is-ok");
      if (success && andNew) newBill(true);
      return success;
    },
    receipt: function () { if (bState.currentBillId) return viewBillInModal(bState.currentBillId); },
  };
})();
