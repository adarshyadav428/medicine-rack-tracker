(function () {
  "use strict";

  // ── PIN state ─────────────────────────────────────────────────────────────
  //
  // The PIN hash lives in the database and is checked on the server, which
  // also refuses to return any figures without a valid unlock. Nothing about
  // the PIN is kept in this browser: it used to sit in localStorage, which
  // meant the dashboard was only protected on whichever machine had set it.
  var pinState = { isSet: false, unlocked: false, lockedOutMinutes: 0 };

  // This page does not load app.js, so it carries its own small fetch helper.
  async function requestApi(path, options) {
    options = options || {};
    var hasBody = options.body !== undefined;
    var response = await fetch(path, {
      method: options.method || "GET",
      cache: "no-store",
      credentials: "include",
      headers: hasBody ? { "Content-Type": "application/json" } : {},
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });

    var text = await response.text();
    var payload = {};
    if (text) { try { payload = JSON.parse(text); } catch (_) { payload = {}; } }

    if (!response.ok) {
      var error = new Error(payload.error || "Request failed (" + response.status + ").");
      error.status = response.status;
      error.code = payload.code;
      throw error;
    }
    return payload;
  }

  async function fetchPinState() {
    pinState = await requestApi("/api/profit-pin", { method: "GET" });
    return pinState;
  }

  // ── DOM refs ─────────────────────────────────────────────────────────────
  var lockScreen   = document.getElementById("lock-screen");
  var dashboard    = document.getElementById("dashboard");
  var pinInput     = document.getElementById("pin-input");
  var pinSubmit    = document.getElementById("pin-submit");
  var pinMsg       = document.getElementById("pin-msg");
  var pinTitle     = document.getElementById("pin-title");
  var pinConfirmRow = document.getElementById("pin-confirm-row");
  var pinConfirm   = document.getElementById("pin-confirm");
  var changeBtn    = document.getElementById("change-pin-btn");
  var resetBtn     = document.getElementById("pin-reset-btn");
  var lockBtn      = document.getElementById("profit-lock-btn");
  var rangeForm    = document.getElementById("profit-range-form");
  var fromInput    = document.getElementById("profit-from");
  var toInput      = document.getElementById("profit-to");

  // Period tabs
  var periodBtns   = document.querySelectorAll(".period-btn");

  // Summary cards
  var elRevenue    = document.getElementById("stat-revenue");
  var elCost       = document.getElementById("stat-cost");
  var elProfit     = document.getElementById("stat-profit");
  var elMargin     = document.getElementById("stat-margin");
  var elBillLabel  = document.getElementById("stat-period-label");

  // Tables
  var custBody     = document.getElementById("cust-body");
  var medBody      = document.getElementById("med-body");
  var billBody     = document.getElementById("bill-body");
  var custEmpty    = document.getElementById("cust-empty");
  var medEmpty     = document.getElementById("med-empty");
  var billEmpty    = document.getElementById("bill-empty");
  var billFilter   = document.getElementById("bill-customer-filter");
  var loadingEl    = document.getElementById("dashboard-loading");
  var errorEl      = document.getElementById("dashboard-error");

  var allBillRows  = []; // [{el, customer}] — kept for filter reuse

  if (billFilter) {
    billFilter.addEventListener("change", function () {
      var selected = billFilter.value;
      var anyVisible = false;
      allBillRows.forEach(function (row) {
        var show = !selected || row.customer === selected;
        row.el.style.display = show ? "" : "none";
        if (show) anyVisible = true;
      });
      if (billEmpty) billEmpty.classList.toggle("hidden", anyVisible || !allBillRows.length);
    });
  }

  var currentPeriod = "month";
  var currentRange = null;
  var requestSeq = 0;
  var restricted = false;
  var locking = false;
  var today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  function todayPart(type) { return today.find(function (part) { return part.type === type; }).value; }
  var todayDate = todayPart("year") + "-" + todayPart("month") + "-" + todayPart("day");
  fromInput.value = todayDate.slice(0, 8) + "01";
  toInput.value = todayDate;

  // ── Lock screen logic ────────────────────────────────────────────────────
  function showLock(isSetup) {
    requestSeq++;
    clearTables();
    lockScreen.classList.remove("hidden");
    dashboard.classList.add("hidden");
    if (isSetup) {
      pinTitle.textContent = "Set a Profit PIN";
      pinConfirmRow.classList.remove("hidden");
      pinSubmit.textContent = "Set PIN";
      if (resetBtn) resetBtn.style.display = "none";
    } else {
      pinTitle.textContent = "Profit Dashboard";
      pinConfirmRow.classList.add("hidden");
      pinSubmit.textContent = "Unlock";
      if (resetBtn) resetBtn.style.display = "";
    }
    pinInput.value   = "";
    if (pinConfirm) pinConfirm.value = "";
    pinMsg.textContent = "";
    pinInput.focus();
  }

  function showRestricted(error) {
    restricted = true;
    showLock(false);
    pinTitle.textContent = "Owner access only";
    document.getElementById("pin-description").textContent = "Sign in with the business owner's account to view profit.";
    pinInput.disabled = pinConfirm.disabled = pinSubmit.disabled = true;
    resetBtn.style.display = "none";
    pinMsg.textContent = error.message;
  }

  function showDashboard() {
    lockScreen.classList.add("hidden");
    dashboard.classList.remove("hidden");
    loadData(currentPeriod);
  }

  async function handlePinSubmit() {
    if (restricted || locking || pinSubmit.disabled) return;
    var pin = pinInput.value.trim();
    if (!pin || pin.length < 4) {
      pinMsg.textContent = "PIN must be at least 4 digits.";
      return;
    }

    // Setup mode is checked here for a quick message; the server checks it
    // again, so a mistyped confirmation can never be stored.
    if (!pinState.isSet || changingPin) {
      var confirmValue = pinConfirm ? pinConfirm.value.trim() : pin;
      if (pin !== confirmValue) {
        pinMsg.textContent = "PINs do not match.";
        return;
      }
    }

    pinSubmit.disabled = true;
    pinMsg.textContent = pinState.isSet ? "Checking…" : "Saving…";

    try {
      if (changingPin) {
        await requestApi("/api/profit-pin", {
          method: "PUT",
          body: { currentPin: currentPinForChange, newPin: pin },
        });
        changingPin = false;
        currentPinForChange = "";
      } else {
        await requestApi("/api/profit-pin", {
          method: "POST",
          body: { pin: pin, confirm: pinConfirm ? pinConfirm.value.trim() : pin },
        });
      }
      pinState.isSet = true;
      pinState.unlocked = true;
      pinMsg.textContent = "";
      showDashboard();
    } catch (error) {
      if (error.status === 403 && error.code === "PROFIT_OWNER_REQUIRED") { showRestricted(error); return; }
      pinMsg.textContent = error.message || "Could not verify the PIN.";
      pinInput.value = "";
      pinInput.focus();
    } finally {
      pinSubmit.disabled = restricted || locking;
    }
  }

  pinSubmit.addEventListener("click", handlePinSubmit);
  pinInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") handlePinSubmit();
  });

  if (changeBtn) {
    changeBtn.addEventListener("click", function () {
      // Changing the PIN requires the current one. Without that, "Change PIN"
      // would be an unlock button for anyone who reached the dashboard.
      var current = prompt("Enter your current PIN:");
      if (current === null) return;
      current = current.trim();
      if (!current) return;

      changingPin = true;
      currentPinForChange = current;
      showLock(true);
      pinTitle.textContent = "Set a New PIN";
      pinSubmit.textContent = "Change PIN";
    });
  }

  lockBtn.addEventListener("click", async function () {
    if (locking) return;
    locking = true;
    changingPin = false;
    currentPinForChange = "";
    pinState.unlocked = false;
    showLock(false);
    pinSubmit.disabled = true;
    pinMsg.textContent = "Locking…";
    try {
      await requestApi("/api/profit-pin", { method: "DELETE" });
      pinMsg.textContent = "Locked. Enter your PIN to continue.";
    } catch (error) {
      pinMsg.textContent = "Could not lock the server session: " + error.message;
    } finally {
      locking = false;
      pinSubmit.disabled = restricted;
    }
  });

  if (resetBtn) {
    // This used to wipe the saved PIN and offer to set a fresh one, which let
    // anyone at the lock screen walk straight past it.
    resetBtn.addEventListener("click", function () {
      pinMsg.textContent =
        "A forgotten PIN has to be cleared in Supabase: delete the " +
        "'profit_pin' row from app_settings, then reload this page to set a new one.";
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  var changingPin = false;
  var currentPinForChange = "";

  (async function boot() {
    try {
      await fetchPinState();
    } catch (error) {
      if (error.status === 401 || error.code === "PROFIT_OWNER_REQUIRED") { showRestricted(error); return; }
      showLock(false);
      pinMsg.textContent = error.message || "Could not reach the server.";
      return;
    }

    if (!pinState.isSet) {
      showLock(true);
    } else if (pinState.unlocked) {
      showDashboard();
    } else {
      showLock(false);
      if (pinState.lockedOutMinutes) {
        pinMsg.textContent =
          "Too many wrong attempts. Try again in " + pinState.lockedOutMinutes + " minute(s).";
      }
    }
  })();

  // ── Period tabs ───────────────────────────────────────────────────────────
  periodBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      periodBtns.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      currentPeriod = btn.dataset.period;
      currentRange = null;
      loadData(currentPeriod);
    });
  });

  rangeForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!rangeForm.reportValidity()) return;
    if (fromInput.value > toInput.value) {
      errorEl.textContent = "From date must not be after To date.";
      errorEl.classList.remove("hidden");
      return;
    }
    currentRange = { from: fromInput.value, to: toInput.value };
    currentPeriod = "custom";
    periodBtns.forEach(function (btn) { btn.classList.remove("active"); });
    loadData(currentPeriod);
  });

  // ── API ───────────────────────────────────────────────────────────────────
  async function loadData(period) {
    var seq = ++requestSeq;
    var range = currentRange;
    var label = period === "custom" ? formatDay(range.from) + " – " + formatDay(range.to) + " (IST)" : PERIOD_LABELS[period];
    if (loadingEl) loadingEl.classList.remove("hidden");
    if (errorEl)   errorEl.classList.add("hidden");
    clearTables();

    try {
      var query = "period=" + encodeURIComponent(period);
      if (period === "custom") query += "&from=" + encodeURIComponent(range.from) + "&to=" + encodeURIComponent(range.to);
      var res = await fetch("/api/profit?" + query, { credentials: "include", cache: "no-store" });
      if (seq !== requestSeq) return;
      if (!res.ok) {
        var err = await res.json().catch(function () { return {}; });
        if (seq !== requestSeq) return;
        if (res.status === 401 || err.code === "PROFIT_OWNER_REQUIRED") { showRestricted(new Error(err.error || "Sign in to continue.")); return; }
        // The unlock expires on its own, so a dashboard left open overnight
        // returns here rather than showing a stale error.
        if (err.pinRequired) {
          pinState.isSet = Boolean(err.pinSet);
          pinState.unlocked = false;
          showLock(!pinState.isSet);
          pinMsg.textContent = pinState.isSet ? "Session expired — enter your PIN again." : "";
          return;
        }
        throw new Error(err.error || "Request failed (" + res.status + ")");
      }
      var data = await res.json();
      if (seq !== requestSeq) return;
      render(data, label);
    } catch (e) {
      if (seq !== requestSeq) return;
      if (errorEl) {
        errorEl.textContent = "Failed to load data: " + e.message;
        errorEl.classList.remove("hidden");
      }
    } finally {
      if (loadingEl && seq === requestSeq) loadingEl.classList.add("hidden");
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  var PERIOD_LABELS = {
    today: "Today",
    week:  "Last 7 days",
    month: "This Month",
    year:  "This Year",
    all:   "All Time",
  };

  function formatDay(day) {
    return new Date(day + "T00:00:00+05:30").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
  }

  function fmt(n) {
    return "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function pct(n) {
    return (n || 0).toFixed(1) + "%";
  }

  function clearTables() {
    if (custBody)  custBody.innerHTML  = "";
    if (medBody)   medBody.innerHTML   = "";
    if (billBody)  billBody.innerHTML  = "";
    if (custEmpty) custEmpty.classList.add("hidden");
    if (medEmpty)  medEmpty.classList.add("hidden");
    if (billEmpty) billEmpty.classList.add("hidden");
    if (billFilter) { billFilter.innerHTML = "<option value=''>All Customers</option>"; }
    allBillRows = [];
    if (elRevenue) elRevenue.textContent = "—";
    if (elCost)    elCost.textContent    = "—";
    if (elProfit)  elProfit.textContent  = "—";
    if (elMargin)  elMargin.textContent  = "—";
  }

  function render(data, label) {
    var s = data.summary || {};
    if (elRevenue) elRevenue.textContent = fmt(s.revenue);
    if (elCost)    elCost.textContent    = fmt(s.cost);
    if (elProfit)  elProfit.textContent  = fmt(s.profit);
    if (elMargin)  elMargin.textContent  = pct(s.margin);
    if (elBillLabel) elBillLabel.textContent = label || "Selected Period";

    // Profit card color
    var profitCard = document.getElementById("card-profit");
    if (profitCard) {
      profitCard.classList.toggle("card-loss", (s.profit || 0) < 0);
    }

    // Customer table
    var customers = data.byCustomer || [];
    if (!customers.length) {
      if (custEmpty) custEmpty.classList.remove("hidden");
    } else {
      var maxRev = Math.max.apply(null, customers.map(function (c) { return c.revenue; })) || 1;
      customers.forEach(function (c) {
        var pctWidth = Math.round(c.revenue / maxRev * 100);
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" +
            "<div class='profit-cust-name'>" + escHtml(c.name) + "</div>" +
            "<div class='profit-bar-wrap'><div class='profit-bar' style='width:" + pctWidth + "%'></div></div>" +
          "</td>" +
          "<td class='num'>" + c.billCount + "</td>" +
          "<td class='num'>" + fmt(c.revenue) + "</td>" +
          "<td class='num'>" + (c.cost ? fmt(c.cost) : "<span class='muted'>—</span>") + "</td>" +
          "<td class='num profit-val" + (c.profit < 0 ? " loss" : "") + "'>" +
            (c.cost ? fmt(c.profit) : "<span class='muted'>—</span>") +
          "</td>" +
          "<td class='num'>" + (c.cost ? pct(c.margin) : "<span class='muted'>—</span>") + "</td>";
        custBody.appendChild(tr);
      });
    }

    // Medicine table
    var medicines = data.byMedicine || [];
    if (!medicines.length) {
      if (medEmpty) medEmpty.classList.remove("hidden");
    } else {
      var maxProfit = Math.max.apply(null, medicines.map(function (m) { return m.profit || 0; })) || 1;
      medicines.forEach(function (m) {
        var pctWidth = m.profit > 0 ? Math.round(m.profit / maxProfit * 100) : 0;
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" +
            "<div class='profit-cust-name'>" + escHtml(m.name) + "</div>" +
            "<div class='profit-bar-wrap'><div class='profit-bar profit-bar-green' style='width:" + pctWidth + "%'></div></div>" +
          "</td>" +
          "<td class='num'>" + m.qty + "</td>" +
          "<td class='num'>" + fmt(m.revenue) + "</td>" +
          "<td class='num'>" + (m.cost ? fmt(m.cost) : "<span class='muted'>—</span>") + "</td>" +
          "<td class='num profit-val" + (m.profit < 0 ? " loss" : "") + "'>" +
            (m.cost ? fmt(m.profit) : "<span class='muted'>—</span>") +
          "</td>" +
          "<td class='num'>" + (m.cost ? pct(m.margin) : "<span class='muted'>—</span>") + "</td>";
        medBody.appendChild(tr);
      });
    }

    // Bill table
    var bills = data.byBill || [];
    if (!bills.length) {
      if (billEmpty) billEmpty.classList.remove("hidden");
    } else {
      // Populate customer filter dropdown
      if (billFilter) {
        var custSet = {};
        bills.forEach(function (b) { custSet[b.customer] = true; });
        Object.keys(custSet).sort().forEach(function (name) {
          var opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          billFilter.appendChild(opt);
        });
      }

      bills.forEach(function (b) {
        var dateStr = b.date ? new Date(b.date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }) : "—";
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td><strong>" + escHtml(b.billNumber || "—") + "</strong></td>" +
          "<td style='white-space:nowrap;color:#64748b;font-size:0.82rem;'>" + dateStr + "</td>" +
          "<td>" + escHtml(b.customer) + "</td>" +
          "<td class='num'>" + fmt(b.revenue) + "</td>" +
          "<td class='num'>" + (b.cost !== null ? fmt(b.cost) : "<span class='muted'>—</span>") + "</td>" +
          "<td class='num profit-val" + (b.profit !== null && b.profit < 0 ? " loss" : "") + "'>" +
            (b.profit !== null ? fmt(b.profit) : "<span class='muted'>—</span>") +
          "</td>" +
          "<td class='num'>" + (b.margin !== null ? pct(b.margin) : "<span class='muted'>—</span>") + "</td>";
        billBody.appendChild(tr);
        allBillRows.push({ el: tr, customer: b.customer });
      });
    }
  }

  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
