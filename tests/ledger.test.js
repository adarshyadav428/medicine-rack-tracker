/**
 * Covers ledger.js — the balance chaining that the billing page runs on.
 *
 * The three faults these lock down, all of which printed wrong money:
 *   1. A typed balance written straight into the opening anchor, which
 *      re-counted every bill and roughly doubled what a customer owed.
 *   2. Chains that walked bills only, ignoring standalone payments, so anyone
 *      who paid outside a bill had an inflated Previous Balance on receipts.
 *   3. Forward and backward walks disagreeing about the same ledger.
 */
const path = require("path");
const Ledger = require(path.join(__dirname, "..", "ledger.js"));

let fails = 0;
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

// created_at values only need to sort correctly.
const at = (d) => `2026-06-${String(d).padStart(2, "0")}T10:00:00.000Z`;
const bill = (id, day, total) => ({ id, created_at: at(day), grand_total: total });
const pay = (day, amount) => ({ created_at: at(day), amount });

// Amount received against each bill, as the billing page supplies it.
const received = {};
const recvFor = (id) => received[id] || 0;

(async () => {
  console.log("--- opening balance: typing a balance must not re-count activity ---");
  {
    // Sita: opening 500, then billed 100 and paid 200 → derived balance 400.
    const currentOpening = 500, currentBalance = 400;

    // The old code stored the typed figure as the opening balance outright.
    const broken = 400;
    eq("old behaviour re-counted activity", Math.round(broken + (currentBalance - currentOpening)), 300);

    // Correct: back the activity out, so the typed figure reads back unchanged.
    const opening = Ledger.openingBalanceFor(400, currentBalance, currentOpening);
    eq("opening adjusted for activity", opening, 500);
    const rederived = Ledger.round2(opening + (currentBalance - currentOpening));
    eq("typed balance survives the round trip", rederived, 400);
  }

  console.log("\n--- editing only the phone leaves the balance untouched ---");
  {
    // Same figure typed back in must be a no-op.
    const opening = Ledger.openingBalanceFor(400, 400, 500);
    eq("opening unchanged", opening, 500);
  }

  console.log("\n--- a customer with no activity: typed balance IS the opening ---");
  {
    eq("new customer", Ledger.openingBalanceFor(250, 0, 0), 250);
  }

  console.log("\n--- timeline merges bills and payments in date order ---");
  {
    const bills = [bill("b2", 10, 200), bill("b1", 5, 300)];
    const payments = [pay(7, 150)];

    const asc = Ledger.buildTimeline(bills, payments, "asc");
    eq("oldest first", asc.map((e) => e.type + ":" + (e.bill ? e.bill.id : e.amount)),
       ["bill:b1", "payment:150", "bill:b2"]);

    const desc = Ledger.buildTimeline(bills, payments, "desc");
    eq("newest first", desc.map((e) => e.type + ":" + (e.bill ? e.bill.id : e.amount)),
       ["bill:b2", "payment:150", "bill:b1"]);
  }

  console.log("\n--- forward chain subtracts standalone payments ---");
  {
    // Opening 0. Bill 300 (paid 100 at counter) → owes 200.
    // Standalone payment 150            → owes 50.
    // Bill 200 (nothing paid)           → owes 250.
    received.b1 = 100; received.b2 = 0;
    const events = Ledger.buildTimeline(
      [bill("b1", 5, 300), bill("b2", 10, 200)], [pay(7, 150)], "asc"
    );
    const chain = Ledger.chainForward(events, 0, recvFor);

    eq("two bills chained", chain.billCount, 2);
    eq("one payment seen", chain.paymentCount, 1);
    eq("first bill opened at 0", chain.updates[0].previousBalance, 0);
    eq("second bill opened at 50, not 200", chain.updates[1].previousBalance, 50);
    eq("final balance", chain.finalBalance, 250);
  }

  console.log("\n--- ignoring payments is exactly the old overstatement ---");
  {
    received.b1 = 100; received.b2 = 0;
    const noPayments = Ledger.chainForward(
      Ledger.buildTimeline([bill("b1", 5, 300), bill("b2", 10, 200)], [], "asc"), 0, recvFor
    );
    eq("without the payment the second bill opens at 200", noPayments.updates[1].previousBalance, 200);
    eq("and the balance is 150 too high", noPayments.finalBalance, 400);
  }

  console.log("\n--- backward chain recovers the same snapshots ---");
  {
    received.b1 = 100; received.b2 = 0;
    const bills = [bill("b1", 5, 300), bill("b2", 10, 200)];
    const payments = [pay(7, 150)];

    const forward = Ledger.chainForward(
      Ledger.buildTimeline(bills, payments, "asc"), 0, recvFor
    );
    const backward = Ledger.chainBackward(
      Ledger.buildTimeline(bills, payments, "desc"), forward.finalBalance, recvFor
    );

    const backMap = {};
    backward.forEach((s) => { backMap[s.id] = s.previousBalance; });
    forward.updates.forEach((u) => {
      eq(`round trip agrees for ${u.id}`, backMap[u.id], u.previousBalance);
    });
  }

  console.log("\n--- grand totals are ceiled the way bills store them ---");
  {
    received.c1 = 0;
    const chain = Ledger.chainForward(
      Ledger.buildTimeline([bill("c1", 1, 99.2)], [], "asc"), 0, recvFor
    );
    eq("99.2 counts as 100", chain.finalBalance, 100);
  }

  console.log("\n--- a past snapshot is never negative ---");
  {
    received.d1 = 0;
    // Customer is in credit today; the bill before it must still read 0, not -50.
    const backward = Ledger.chainBackward(
      Ledger.buildTimeline([bill("d1", 1, 100)], [], "desc"), 50, recvFor
    );
    eq("floored at zero", backward[0].previousBalance, 0);
  }

  console.log("\n--- an empty ledger is safe ---");
  {
    const chain = Ledger.chainForward(Ledger.buildTimeline([], [], "asc"), 0, recvFor);
    eq("no updates", chain.updates.length, 0);
    eq("balance stays at the anchor", chain.finalBalance, 0);
    eq("backward is empty too",
       Ledger.chainBackward(Ledger.buildTimeline([], [], "desc"), 0, recvFor).length, 0);
  }

  console.log(fails ? `\n${fails} FAILED` : "\nall ledger assertions passed");
  process.exit(fails ? 1 : 0);
})();
