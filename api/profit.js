const {
  allowMethods,
  callSupabaseRest,
  getCookie,
  getServerConfig,
  requireAuthContext,
  sendJson,
} = require("../lib/supabase-server");

const {
  UNLOCK_COOKIE,
  getStoredPinHash,
  isUnlockTokenValid,
} = require("../lib/profit-pin");

const BILLS_TABLE = "bills";
const ITEMS_TABLE = "bill_items";
const PAGE_SIZE = 1000;
// Keep the bill_id=in.(...) filter well inside URL length limits.
const BILL_ID_CHUNK = 200;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function getPeriodStart(period) {
  const now = new Date();
  switch (period) {
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    case "week": {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    }
    case "month":
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    case "year":
      return new Date(now.getFullYear(), 0, 1).toISOString();
    default:
      return null;
  }
}

function aggregate(bills, items) {
  const billMap = {};
  for (const b of bills) billMap[b.id] = b;

  let totalRevenue = 0, totalCost = 0, totalProfit = 0;
  const byCustomer = {};
  const byMedicine = {};
  const byBill     = {};

  for (const item of items) {
    const bill = billMap[item.bill_id];
    if (!bill) continue;

    const qty      = parseFloat(item.quantity)       || 0;
    const sell     = parseFloat(item.sell_price)     || 0;
    const buy      = item.purchase_price != null ? parseFloat(item.purchase_price) : null;

    const revenue  = round2(sell * qty);
    const cost     = buy !== null ? round2(buy * qty) : null;
    const profit   = cost !== null ? round2(revenue - cost) : null;

    totalRevenue += revenue;
    if (cost !== null) { totalCost += cost; totalProfit += profit; }

    // By customer
    const custKey = (bill.customer_name || "Walk-in").trim() || "Walk-in";
    if (!byCustomer[custKey]) {
      byCustomer[custKey] = { name: custKey, revenue: 0, cost: 0, profit: 0, billIds: new Set() };
    }
    byCustomer[custKey].revenue += revenue;
    if (cost !== null) { byCustomer[custKey].cost += cost; byCustomer[custKey].profit += profit; }
    byCustomer[custKey].billIds.add(item.bill_id);

    // By medicine
    const medKey = (item.medicine_name || "Unknown").trim();
    if (!byMedicine[medKey]) {
      byMedicine[medKey] = { name: medKey, revenue: 0, cost: 0, profit: 0, qty: 0 };
    }
    byMedicine[medKey].revenue += revenue;
    byMedicine[medKey].qty    += qty;
    if (cost !== null) { byMedicine[medKey].cost += cost; byMedicine[medKey].profit += profit; }

    // By bill
    if (!byBill[item.bill_id]) {
      byBill[item.bill_id] = {
        billNumber: bill.bill_number,
        customer:   (bill.customer_name || "Walk-in").trim() || "Walk-in",
        date:       bill.created_at,
        revenue: 0, cost: 0, profit: 0, hasCost: false,
      };
    }
    byBill[item.bill_id].revenue += revenue;
    if (cost !== null) {
      byBill[item.bill_id].cost    += cost;
      byBill[item.bill_id].profit  += profit;
      byBill[item.bill_id].hasCost  = true;
    }
  }

  const customerList = Object.values(byCustomer).map(c => ({
    name:       c.name,
    revenue:    round2(c.revenue),
    cost:       round2(c.cost),
    profit:     round2(c.profit),
    margin:     c.revenue > 0 ? round2(c.profit / c.revenue * 100) : 0,
    billCount:  c.billIds.size,
  })).sort((a, b) => b.revenue - a.revenue);

  const medicineList = Object.values(byMedicine).map(m => ({
    name:    m.name,
    revenue: round2(m.revenue),
    cost:    round2(m.cost),
    profit:  round2(m.profit),
    margin:  m.revenue > 0 ? round2(m.profit / m.revenue * 100) : 0,
    qty:     round2(m.qty),
  })).sort((a, b) => b.profit - a.profit).slice(0, 25);

  const billList = Object.values(byBill).map(b => ({
    billNumber: b.billNumber,
    customer:   b.customer,
    date:       b.date,
    revenue:    round2(b.revenue),
    cost:       b.hasCost ? round2(b.cost)   : null,
    profit:     b.hasCost ? round2(b.profit) : null,
    margin:     b.hasCost && b.revenue > 0 ? round2(b.profit / b.revenue * 100) : null,
  })).sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    summary: {
      revenue: round2(totalRevenue),
      cost:    round2(totalCost),
      profit:  round2(totalProfit),
      margin:  totalRevenue > 0 ? round2(totalProfit / totalRevenue * 100) : 0,
    },
    byCustomer: customerList,
    byMedicine: medicineList,
    byBill:     billList,
  };
}

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["GET"])) return;

  const config = getServerConfig();

  try {
    const authContext = await requireAuthContext(req, res, config, { adminOnly: true });
    if (!authContext) return;

    // The PIN has to gate the figures, not just the page. Checking it only in
    // the browser left this endpoint answering anyone who was logged in.
    const storedHash = await getStoredPinHash(config);
    if (!storedHash) {
      sendJson(res, 403, { error: "Set a profit PIN first.", pinRequired: true, pinSet: false });
      return;
    }
    if (!isUnlockTokenValid(config, getCookie(req, UNLOCK_COOKIE), authContext.user.email)) {
      sendJson(res, 403, { error: "Enter your profit PIN.", pinRequired: true, pinSet: true });
      return;
    }

    const period = (req.query?.period || "all").toLowerCase();
    const start  = getPeriodStart(period);

    // Step 1: fetch bills in the period.
    // Paged rather than capped: a fixed limit silently drops the oldest bills
    // and reports profit lower than it really was, with nothing to show that
    // anything was missed.
    const bills = [];
    let billOffset = 0;
    for (;;) {
      let billsQuery =
        `${BILLS_TABLE}?select=id,bill_number,customer_name,grand_total,created_at` +
        `&order=created_at.desc&limit=${PAGE_SIZE}&offset=${billOffset}`;
      if (start) billsQuery += `&created_at=gte.${encodeURIComponent(start)}`;

      const page = await callSupabaseRest(config, billsQuery, { method: "GET" });
      const batch = Array.isArray(page) ? page : [];
      bills.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      billOffset += PAGE_SIZE;
    }

    if (!bills.length) {
      sendJson(res, 200, { summary: { revenue: 0, cost: 0, profit: 0, margin: 0 }, byCustomer: [], byMedicine: [], byBill: [] });
      return;
    }

    // Step 2: fetch the line items for those bills, in chunks — both to page
    // past the row limit and to keep the bill_id=in.(...) URL a sane length.
    const items = [];
    for (let i = 0; i < bills.length; i += BILL_ID_CHUNK) {
      const chunk = bills.slice(i, i + BILL_ID_CHUNK);
      const encodedIds = chunk.map((b) => encodeURIComponent(b.id)).join(",");

      let itemOffset = 0;
      for (;;) {
        const page = await callSupabaseRest(
          config,
          `${ITEMS_TABLE}?bill_id=in.(${encodedIds})` +
            `&select=bill_id,medicine_name,sell_price,purchase_price,quantity` +
            `&order=id.asc&limit=${PAGE_SIZE}&offset=${itemOffset}`,
          { method: "GET" }
        );
        const batch = Array.isArray(page) ? page : [];
        items.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        itemOffset += PAGE_SIZE;
      }
    }

    sendJson(res, 200, aggregate(bills, items));
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Profit API failed." });
  }
};
