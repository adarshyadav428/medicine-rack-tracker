"use strict";
const DAY = 86400000;
const IST = 330 * 60000;

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Use valid From and To dates (YYYY-MM-DD).");
  }
  const time = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new Error("Use valid calendar dates.");
  }
  return value;
}

function midnight(day) { return Date.parse(day + "T00:00:00+05:30"); }
function dateString(time) { return new Date(time).toISOString().slice(0, 10); }

function profitPeriod(query = {}, now = new Date()) {
  const period = query.period || (query.from || query.to ? "custom" : "all");
  if (!["today","week","month","year","all","custom"].includes(period)) throw new Error("Choose a valid profit period.");
  if (period === "custom") {
    const from = validDate(query.from), to = validDate(query.to);
    if (from > to) throw new Error("From date must not be after To date.");
    // >= local midnight and < the next midnight includes the final day even
    // when database timestamps have sub-millisecond precision.
    return { from: new Date(midnight(from)).toISOString(), to: new Date(midnight(to) + DAY).toISOString(), period };
  }
  if (query.from || query.to) throw new Error("Use the custom period with From and To dates.");
  if (period === "all") return { from: null, to: null, period };
  const today = dateString(now.getTime() + IST), current = new Date(today + "T00:00:00Z");
  let from = today, end = dateString(current.getTime() + DAY);
  if (period === "week") from = dateString(current.getTime() - 6 * DAY);
  if (period === "month") {
    from = today.slice(0, 8) + "01";
    end = dateString(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
  }
  if (period === "year") {
    from = today.slice(0, 4) + "-01-01";
    end = String(current.getUTCFullYear() + 1) + "-01-01";
  }
  return { from: new Date(midnight(from)).toISOString(), to: new Date(midnight(end)).toISOString(), period };
}

module.exports = { profitPeriod };
