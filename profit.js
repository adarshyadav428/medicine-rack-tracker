(function () {
  "use strict";

  // ── PIN helpers (Web Crypto SHA-256) ──────────────────────────────────────
  var PIN_HASH_KEY   = "am.profitPinHash";
  var SESSION_KEY    = "am.profitOk";
  var PIN_SALT       = "adarsh-medicals-profit-2026";

  async function sha256(str) {
    var buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(PIN_SALT + str)
    );
    return Array.from(new Uint8Array(buf))
      .map(function (b) { return b.toString(16).padStart(2, "0"); })
      .join("");
  }

  function getStoredHash()   { return localStorage.getItem(PIN_HASH_KEY) || ""; }
  function isSessionOpen()   { return sessionStorage.getItem(SESSION_KEY) === "1"; }
  function markSessionOpen() { sessionStorage.setItem(SESSION_KEY, "1"); }

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
  var loadingEl    = document.getElementById("dashboard-loading");
  var errorEl      = document.getElementById("dashboard-error");

  var currentPeriod = "month";

  // ── Lock screen logic ────────────────────────────────────────────────────
  function showLock(isSetup) {
    lockScreen.classList.remove("hidden");
    dashboard.classList.add("hidden");
    if (isSetup) {
      pinTitle.textContent = "Set a Profit PIN";
      pinConfirmRow.classList.remove("hidden");
      pinSubmit.textContent = "Set PIN";
    } else {
      pinTitle.textContent = "Profit Dashboard";
      pinConfirmRow.classList.add("hidden");
      pinSubmit.textContent = "Unlock";
    }
    pinInput.value   = "";
    if (pinConfirm) pinConfirm.value = "";
    pinMsg.textContent = "";
    pinInput.focus();
  }

  function showDashboard() {
    lockScreen.classList.add("hidden");
    dashboard.classList.remove("hidden");
    loadData(currentPeriod);
  }

  async function handlePinSubmit() {
    var pin = pinInput.value.trim();
    if (!pin || pin.length < 4) {
      pinMsg.textContent = "PIN must be at least 4 digits.";
      return;
    }

    var storedHash = getStoredHash();

    // Setup mode
    if (!storedHash) {
      var confirm = pinConfirm ? pinConfirm.value.trim() : pin;
      if (pin !== confirm) {
        pinMsg.textContent = "PINs do not match.";
        return;
      }
      var hash = await sha256(pin);
      localStorage.setItem(PIN_HASH_KEY, hash);
      markSessionOpen();
      showDashboard();
      return;
    }

    // Verify mode
    var entered = await sha256(pin);
    if (entered === storedHash) {
      markSessionOpen();
      showDashboard();
    } else {
      pinMsg.textContent = "Incorrect PIN. Try again.";
      pinInput.value = "";
      pinInput.focus();
    }
  }

  pinSubmit.addEventListener("click", handlePinSubmit);
  pinInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") handlePinSubmit();
  });

  if (changeBtn) {
    changeBtn.addEventListener("click", function () {
      // Reset PIN: clear stored hash and show setup screen
      localStorage.removeItem(PIN_HASH_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      showLock(true);
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  var storedHash = getStoredHash();
  if (!storedHash) {
    showLock(true);
  } else if (isSessionOpen()) {
    showDashboard();
  } else {
    showLock(false);
  }

  // ── Period tabs ───────────────────────────────────────────────────────────
  periodBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      periodBtns.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      currentPeriod = btn.dataset.period;
      loadData(currentPeriod);
    });
  });

  // ── API ───────────────────────────────────────────────────────────────────
  async function loadData(period) {
    if (loadingEl) loadingEl.classList.remove("hidden");
    if (errorEl)   errorEl.classList.add("hidden");
    clearTables();

    try {
      var res = await fetch("/api/profit?period=" + period, { credentials: "include" });
      if (!res.ok) {
        var err = await res.json().catch(function () { return {}; });
        throw new Error(err.error || "Request failed (" + res.status + ")");
      }
      var data = await res.json();
      render(data, period);
    } catch (e) {
      if (errorEl) {
        errorEl.textContent = "Failed to load data: " + e.message;
        errorEl.classList.remove("hidden");
      }
    } finally {
      if (loadingEl) loadingEl.classList.add("hidden");
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  var PERIOD_LABELS = {
    today: "Today",
    week:  "This Week",
    month: "This Month",
    year:  "This Year",
    all:   "All Time",
  };

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
    if (elRevenue) elRevenue.textContent = "—";
    if (elCost)    elCost.textContent    = "—";
    if (elProfit)  elProfit.textContent  = "—";
    if (elMargin)  elMargin.textContent  = "—";
  }

  function render(data, period) {
    var s = data.summary || {};
    if (elRevenue) elRevenue.textContent = fmt(s.revenue);
    if (elCost)    elCost.textContent    = fmt(s.cost);
    if (elProfit)  elProfit.textContent  = fmt(s.profit);
    if (elMargin)  elMargin.textContent  = pct(s.margin);
    if (elBillLabel) elBillLabel.textContent = PERIOD_LABELS[period] || "Selected Period";

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
      bills.forEach(function (b) {
        var dateStr = b.date ? new Date(b.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
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
