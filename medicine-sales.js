/**
 * "Who bought this, and at what rate" — the sale history for one medicine.
 *
 * The mirror of the per-customer last-price memory: that decides what to charge
 * the person at the counter, this shows what the medicine has been going out at
 * across everyone, so an odd quote can be checked before it is repeated.
 *
 * Lifted out of billing.js so the inventory list can open the same window. The
 * question ("what has this been selling for?") comes up wherever a medicine is
 * on screen, not only while a bill is open, and two copies of this table would
 * drift apart.
 *
 * Depends on `requestApi` from app.js, which both pages already load.
 *
 *   window.showMedicineSalesModal(name, {
 *     onOpenBill: function (billId, close) { ... },  // omit → bill shown as text
 *     onClose:    function () { ... },               // e.g. restore focus
 *   });
 */
(function () {
  "use strict";

  function norm(value) {
    if (typeof window.normalizeString === "function") return window.normalizeString(value);
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

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

  function escHtml(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showMedicineSalesModal(medicineName, options) {
    var opts = options || {};
    var name = norm(medicineName);
    if (!name) return;

    var existing = document.getElementById("medicine-sales-overlay");
    if (existing) existing.parentNode.removeChild(existing);

    var overlay = document.createElement("div");
    overlay.id = "medicine-sales-overlay";
    overlay.className = "manual-add-overlay";
    overlay.innerHTML = [
      '<div class="manual-add-modal medicine-sales-modal">',
        '<div class="manual-add-header">',
          "<h3>Sales history — " + escHtml(name) + "</h3>",
          '<button class="manual-add-close" id="medicine-sales-close" type="button" aria-label="Close">✕</button>',
        '</div>',
        '<div class="manual-add-body">',
          '<div id="medicine-sales-summary" class="medicine-sales-summary">Loading…</div>',
          '<div id="medicine-sales-body"></div>',
        '</div>',
        '<div class="manual-add-footer">',
          '<button class="btn btn-ghost" id="medicine-sales-done" type="button">Close</button>',
        '</div>',
      '</div>',
    ].join("");

    document.body.appendChild(overlay);

    function closeModal() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (typeof opts.onClose === "function") opts.onClose();
    }
    document.getElementById("medicine-sales-close").addEventListener("click", closeModal);
    document.getElementById("medicine-sales-done").addEventListener("click", closeModal);
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeModal(); });
    overlay.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

    loadMedicineSales(name, closeModal, opts);
  }

  async function loadMedicineSales(name, closeModal, opts) {
    var summaryEl = document.getElementById("medicine-sales-summary");
    var bodyEl    = document.getElementById("medicine-sales-body");

    var sales;
    try {
      var result = await window.requestApi(
        "/api/bills?medicine=" + encodeURIComponent(name),
        { method: "GET" }
      );
      sales = result.sales || [];
    } catch (err) {
      if (summaryEl) {
        summaryEl.textContent = "Could not load sales history: " + (err.message || "unknown error");
        summaryEl.className = "medicine-sales-summary is-warn";
      }
      return;
    }

    if (!document.getElementById("medicine-sales-body")) return; // modal closed

    if (!sales.length) {
      if (summaryEl) summaryEl.textContent = "This medicine has not been sold yet.";
      if (bodyEl) bodyEl.innerHTML = "";
      return;
    }

    var prices  = sales.map(function (s) { return s.sellPrice; });
    var lowest  = Math.min.apply(null, prices);
    var highest = Math.max.apply(null, prices);
    var totalQty = sales.reduce(function (sum, s) { return sum + s.quantity; }, 0);
    var buyers   = new Set(sales.map(function (s) {
      return (s.customerName || "walk-in").toLowerCase();
    })).size;

    if (summaryEl) {
      summaryEl.className = "medicine-sales-summary";
      summaryEl.innerHTML =
        '<span><strong>' + sales.length + '</strong> sale(s)</span>' +
        '<span><strong>' + buyers + '</strong> buyer(s)</span>' +
        '<span><strong>' + round2(totalQty) + '</strong> units</span>' +
        '<span>Rate ' +
          (lowest === highest
            ? '<strong>' + fmtMoney(lowest) + '</strong>'
            : '<strong>' + fmtMoney(lowest) + '</strong> – <strong>' + fmtMoney(highest) + '</strong>') +
        '</span>' +
        '<span>Last sold <strong>' + escHtml(fmtDate(sales[0].soldAt)) + '</strong></span>';
    }

    var canOpenBill = typeof opts.onOpenBill === "function";

    var rows = sales.map(function (s) {
      // The spread between what this went out at and the dearest it has ever
      // gone out at is the number worth noticing, so it is marked rather than
      // left to be eyeballed down a column.
      var isLow  = highest !== lowest && s.sellPrice === lowest;
      var isHigh = highest !== lowest && s.sellPrice === highest;
      var priceClass = isLow ? " medicine-sales-price--low" : (isHigh ? " medicine-sales-price--high" : "");

      return "<tr>" +
        "<td>" + escHtml(fmtDate(s.soldAt)) + "</td>" +
        "<td>" + (s.customerName
          ? escHtml(s.customerName)
          : '<span style="color:var(--muted)">Walk-in</span>') + "</td>" +
        '<td class="num-col">' + round2(s.quantity) + "</td>" +
        '<td class="num-col"><span class="medicine-sales-price' + priceClass + '">' +
          fmtMoney(s.sellPrice) + "</span></td>" +
        "<td>" + (s.batchNo ? escHtml(s.batchNo) : '<span style="color:var(--muted)">—</span>') + "</td>" +
        "<td>" +
          // Only a button where there is a receipt viewer to open it in. On the
          // inventory page the number is still worth showing — it is what the
          // bill is looked up by — but a button that did nothing would not be.
          (canOpenBill
            ? '<button class="btn btn-ghost btn-xs" type="button" data-open-bill="' + escHtml(s.billId) + '">' +
                escHtml(s.billNumber) +
              "</button>"
            : '<span class="medicine-sales-billno">' + escHtml(s.billNumber) + "</span>") +
        "</td>" +
      "</tr>";
    }).join("");

    if (bodyEl) {
      bodyEl.innerHTML =
        '<div class="medicine-sales-table-wrap">' +
          '<table class="medicine-sales-table">' +
            "<thead><tr>" +
              "<th>Date</th><th>Customer</th>" +
              '<th class="num-col">Qty</th><th class="num-col">Rate</th>' +
              "<th>Batch</th><th>Bill</th>" +
            "</tr></thead>" +
            "<tbody>" + rows + "</tbody>" +
          "</table>" +
        "</div>";

      if (canOpenBill) {
        bodyEl.querySelectorAll("[data-open-bill]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            // Close this first — two stacked modals would trap the scroll lock.
            closeModal();
            opts.onOpenBill(btn.dataset.openBill);
          });
        });
      }
    }
  }

  window.showMedicineSalesModal = showMedicineSalesModal;
})();
