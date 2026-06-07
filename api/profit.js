const {
  allowMethods,
  callSupabaseRest,
  getServerConfig,
  requireAuthContext,
  sendJson,
} = require("../lib/supabase-server");

const BILLS_TABLE = "bills";
const ITEMS_TABLE = "bill_items";

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

  return {
    summary: {
      revenue: round2(totalRevenue),
      cost:    round2(totalCost),
      profit:  round2(totalProfit),
      margin:  totalRevenue > 0 ? round2(totalProfit / totalRevenue * 100) : 0,
    },
    byCustomer: customerList,
    byMedicine: medicineList,
  };
}

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ["GET"])) return;

  const config = getServerConfig();

  try {
    const authContext = await requireAuthContext(req, res, config, { adminOnly: true });
    if (!authContext) return;

    const period = (req.query?.period || "all").toLowerCase();
    const start  = getPeriodStart(period);

    // Step 1: fetch bills in the period
    let billsQuery = `${BILLS_TABLE}?select=id,customer_name,grand_total,created_at&order=created_at.desc&limit=2000`;
    if (start) billsQuery += `&created_at=gte.${encodeURIComponent(start)}`;

    const bills = await callSupabaseRest(config, billsQuery, { method: "GET" });
    if (!Array.isArray(bills) || !bills.length) {
      sendJson(res, 200, { summary: { revenue: 0, cost: 0, profit: 0, margin: 0 }, byCustomer: [], byMedicine: [] });
      return;
    }

    // Step 2: fetch all items for those bills
    const billIds    = bills.map(b => b.id);
    const encodedIds = billIds.map(id => encodeURIComponent(id)).join(",");
    const items = await callSupabaseRest(
      config,
      `${ITEMS_TABLE}?bill_id=in.(${encodedIds})&select=bill_id,medicine_name,sell_price,purchase_price,quantity&limit=5000`,
      { method: "GET" }
    );

    sendJson(res, 200, aggregate(bills, Array.isArray(items) ? items : []));
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Profit API failed." });
  }
};
