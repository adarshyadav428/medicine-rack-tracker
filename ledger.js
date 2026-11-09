/**
 * ledger.js — customer balance chaining.
 *
 * A customer's balance moves for two reasons: a bill is raised (and part of it
 * possibly settled at the counter), and a standalone payment is recorded
 * against the account. Everything here walks BOTH, merged in date order.
 * Chaining over bills alone overstates the balance of anyone who has ever paid
 * outside a bill, and that inflated figure ends up printed on their receipts.
 *
 * Loaded as a plain script in the browser (window.Ledger) and required by the
 * test suite. No DOM or network access — pure arithmetic, so it is testable.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Ledger = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function toNum(v) {
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  // Postgres timestamps retain microseconds, while Date only retains
  // milliseconds. Keep the remaining fraction so two distinct cash movements
  // within the same millisecond are not silently reordered.
  function timestampParts(value) {
    var text = String(value || "");
    var ms = new Date(value).getTime();
    var match = /\d{2}:\d{2}:\d{2}\.(\d+)/.exec(text);
    return {
      ms: isFinite(ms) ? ms : 0,
      fraction: match ? match[1].slice(3).replace(/0+$/, "") : "",
    };
  }

  function compareTimestamps(a, b) {
    if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
    var length = Math.max(a.fraction.length, b.fraction.length);
    var left = a.fraction.padEnd(length, "0");
    var right = b.fraction.padEnd(length, "0");
    return left === right ? 0 : (left < right ? -1 : 1);
  }

  function sequenceKey(value) {
    var key = String(value === null || value === undefined ? "" : value);
    return /^\d+$/.test(key) ? key.replace(/^0+(?=\d)/, "") : null;
  }

  /**
   * Merge a customer's bills and payments into one chronological list.
   * `direction` is "asc" (oldest first) or "desc" (newest first).
   */
  function buildTimeline(bills, payments, direction) {
    var events = [];

    function add(event, id, sequence) {
      events.push({
        event: event,
        timestamp: timestampParts(event.at),
        id: String(id || ""),
        sequence: sequenceKey(sequence),
        index: events.length,
      });
    }

    (bills || []).forEach(function (b) {
      add({ type: "bill", at: b.created_at, bill: b }, b.id, b.ledger_sequence);
    });

    (payments || []).forEach(function (p) {
      add({ type: "payment", at: p.created_at, amount: toNum(p.amount) }, p.id, p.ledger_sequence);
    });

    events.sort(function (x, y) {
      var diff = compareTimestamps(x.timestamp, y.timestamp);
      if (!diff && x.sequence !== null && y.sequence !== null && x.sequence !== y.sequence) {
        diff = x.sequence.length === y.sequence.length
          ? (x.sequence < y.sequence ? -1 : 1)
          : x.sequence.length - y.sequence.length;
      }
      // At exactly the same instant retain the existing bill-before-payment
      // convention when no distinct durable ledger sequence is available.
      // IDs make each source's order deterministic. Reverse
      // that complete order for backward walks, rather than sorting ties the
      // same way in both directions and reconstructing different snapshots.
      if (!diff && x.event.type !== y.event.type) {
        diff = x.event.type === "bill" ? -1 : 1;
      }
      if (!diff && x.id !== y.id) diff = x.id < y.id ? -1 : 1;
      if (!diff) diff = x.index - y.index;
      return direction === "desc" ? -diff : diff;
    });
    return events.map(function (entry) { return entry.event; });
  }

  /**
   * Re-chain every bill from an anchor forward, producing the previous-balance
   * snapshot each bill should carry.
   *
   * `recvFor(billId, bill)` supplies the amount received against a bill.
   * Returns { updates, finalBalance, billCount, paymentCount }.
   */
  function chainForward(events, startingBalance, recvFor) {
    var running = round2(toNum(startingBalance));
    var updates = [];
    var paymentCount = 0;

    (events || []).forEach(function (ev) {
      if (ev.type === "payment") {
        running = round2(running - ev.amount);
        paymentCount += 1;
        return;
      }

      var bill = ev.bill;
      var grandTotal = Math.ceil(toNum(bill.grand_total));
      var received = toNum(recvFor(bill.id, bill));

      updates.push({
        id: bill.id,
        previousBalance: running,
        amountReceived: received,
        grandTotal: grandTotal,
      });

      running = round2(running + grandTotal - received);
    });

    return {
      updates: updates,
      finalBalance: running,
      billCount: updates.length,
      paymentCount: paymentCount,
    };
  }

  /**
   * Walk a newest-first timeline backwards from today's balance, recovering the
   * previous-balance each bill was raised against.
   *
   * Returns [{ id, previousBalance, amountReceived, grandTotal }] in the order
   * walked (newest first). Negative snapshots preserve customer credit, just
   * as the forward walk and the current account balance do.
   */
  function chainBackward(events, currentBalance, recvFor) {
    var running = round2(toNum(currentBalance));
    var out = [];

    (events || []).forEach(function (ev) {
      if (ev.type === "payment") {
        // Going backwards, undo the payment: before it was taken the customer
        // owed this much more.
        running = round2(running + ev.amount);
        return;
      }

      var bill = ev.bill;
      var grandTotal = Math.ceil(toNum(bill.grand_total));
      var received = toNum(recvFor(bill.id, bill));
      var prev = round2(running - grandTotal + received);

      out.push({
        id: bill.id,
        previousBalance: prev,
        amountReceived: received,
        grandTotal: grandTotal,
      });

      running = prev;
    });

    return out;
  }

  /**
   * The opening balance to store when the user types a balance for a customer.
   *
   * A customer's balance is DERIVED: opening + everything billed, less
   * everything received and paid. Writing a typed balance straight into the
   * opening anchor counts all of that activity a second time and roughly
   * doubles what they owe. Back the activity out first, so the figure typed
   * reads back as the balance.
   */
  function openingBalanceFor(typedBalance, currentBalance, currentOpening) {
    var activity = round2(toNum(currentBalance) - toNum(currentOpening));
    return round2(toNum(typedBalance) - activity);
  }

  return {
    round2: round2,
    buildTimeline: buildTimeline,
    chainForward: chainForward,
    chainBackward: chainBackward,
    openingBalanceFor: openingBalanceFor,
  };
});
