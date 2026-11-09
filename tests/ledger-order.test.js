const assert = require("node:assert/strict");
const Ledger = require("../ledger");

function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  console.log("PASS " + label);
}

const microBills = [{
  id: "after-payment", created_at: "2026-11-08T04:00:00.000200Z", grand_total: 100,
}];
const microPayments = [{
  id: "earlier-payment", created_at: "2026-11-08T04:00:00.000100Z", amount: 50,
}];
const asc = Ledger.buildTimeline(microBills, microPayments, "asc");
check("payment with an earlier microsecond precedes the bill", asc.map(e => e.type), ["payment", "bill"]);
const forward = Ledger.chainForward(asc, 200, () => 0);
check("opening 200 less earlier 50 payment carries 150", forward.updates[0].previousBalance, 150);
check("submillisecond chain ends at 250", forward.finalBalance, 250);
const backward = Ledger.chainBackward(Ledger.buildTimeline(microBills, microPayments, "desc"), 250, () => 0);
check("backward submillisecond chain restores the same snapshot", backward[0].previousBalance, 150);

const offsetBills = [{ ...microBills[0], created_at: "2026-11-08T09:30:00.000200+05:30" }];
check("fraction ordering preserves equivalent timezone offsets",
  Ledger.buildTimeline(offsetBills, microPayments, "asc").map(e => e.type), ["payment", "bill"]);
check("Date and numeric timestamp inputs keep their existing chronology",
  Ledger.buildTimeline([{ id: "numeric", created_at: Date.parse("2026-11-08T04:00:01Z"), grand_total: 1 }],
    [{ created_at: new Date("2026-11-08T04:00:00Z"), amount: 1 }], "asc").map(e => e.type), ["payment", "bill"]);

const at = "2026-11-08T04:00:00.000100Z";
const tiedBills = [
  { id: "b2", created_at: at, grand_total: 20 },
  { id: "b1", created_at: at, grand_total: 100 },
];
const tiedPayments = [
  { id: "p2", created_at: at, amount: 7 },
  { id: "p1", created_at: "2026-11-08T09:30:00.0001000+05:30", amount: 5 },
];
const label = e => e.type === "bill" ? e.bill.id : "payment:" + e.amount;
const tiedAsc = Ledger.buildTimeline(tiedBills, tiedPayments, "asc");
const tiedDesc = Ledger.buildTimeline(tiedBills, tiedPayments, "desc");
check("equal instants use stable IDs and bill-before-payment convention",
  tiedAsc.map(label), ["b1", "b2", "payment:5", "payment:7"]);
check("descending order is the exact reverse even for equal instants",
  tiedDesc.map(label), tiedAsc.map(label).reverse());
const sequencedAsc = Ledger.buildTimeline(
  [{ ...tiedBills[0], ledger_sequence: "90071992547409930" }],
  [{ ...tiedPayments[0], ledger_sequence: "90071992547409929" }], "asc");
check("durable ledger sequence resolves exact ties without number precision loss",
  sequencedAsc.map(e => e.type), ["payment", "bill"]);
const tiedForward = Ledger.chainForward(tiedAsc, -50, id => id === "b1" ? 150 : 0);
check("forward walk retains initial credit", tiedForward.updates[0].previousBalance, -50);
check("counter receipt may leave further credit", tiedForward.updates[1].previousBalance, -100);
check("credit plus both standalone payments reaches the expected account balance", tiedForward.finalBalance, -92);
const tiedBack = Ledger.chainBackward(tiedDesc, -92, id => id === "b1" ? 150 : 0);
check("backward walk retains signed snapshots at exact ties",
  Object.fromEntries(tiedBack.map(b => [b.id, b.previousBalance])), { b2: -100, b1: -50 });

const credit = Ledger.chainBackward(Ledger.buildTimeline([
  { id: "credit-sale", created_at: at, grand_total: 100 },
], [], "desc"), -100, () => 0);
check("a prior 200 credit is not erased from an old receipt", credit[0].previousBalance, -200);
