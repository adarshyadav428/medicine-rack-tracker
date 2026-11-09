// Browser regression for saved-invoice ownership and printing. Local fixture only.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const medicine = { id: "medicine-1", medicineName: "Fixture medicine", quantity: 100, sellPrice: 100, mrp: 100, purchasePrice: 50 };
const customers = [{ id: "alice", name: "Alice", openingBalance: 0 }, { id: "bob", name: "Bob", openingBalance: 0 }];
const bills = [];
const operations = new Map();
let loseNextResponse = false;
let releaseSave;
let saveReached;
const reached = new Promise(resolve => { saveReached = resolve; });
const saveGate = new Promise(resolve => { releaseSave = resolve; });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let data;
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/supabase-config") data = { enabled: true, backendManaged: true };
      else if (url.pathname.startsWith("/api/auth/")) data = { authenticated: true, user: { email: "fixture@example.test", role: "admin" } };
      else if (url.pathname === "/api/medicines") data = { items: [medicine] };
      else if (url.pathname === "/api/customers") data = { customers: customers.map(c => ({ ...c, phone: "", balance: bills.filter(b => b.customer_id === c.id).reduce((sum, b) => sum + b.grand_total - b.amount_received, c.openingBalance) })) };
      else if (url.pathname === "/api/payments") data = { payments: [] };
      else if (url.pathname === "/api/bills") {
        if (req.method === "POST") {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          saveReached();
          await saveGate;
          if (operations.has(body.operationId)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(operations.get(body.operationId)));
            return;
          }
          const subtotal = body.items.reduce((sum, item) => sum + item.quantity * item.sellPrice, 0);
          const bill = {
            id: "saved-" + (bills.length + 1), bill_number: "FIXTURE-ISSUED-" + String(bills.length + 1).padStart(3, "0"), customer_id: body.customerId,
            customer_name: body.customerName, customer_phone: body.customerPhone, notes: body.notes,
            subtotal, gst_percent: body.gstPercent, gst_amount: 0, grand_total: subtotal,
            previous_balance: body.previousBalance, amount_received: body.amountReceived,
            balance_due: body.previousBalance + subtotal - body.amountReceived,
            created_at: "2024-01-01T04:00:00Z", updated_at: "2026-11-08T04:00:00Z", version: 1,
            items: body.items.map(item => ({ ...item, medicine_name: item.medicineName, medicine_id: item.medicineId, sell_price: item.sellPrice, purchase_price: item.purchasePrice })),
          };
          bills.push(bill);
          data = { bill, billNumber: bill.bill_number };
          operations.set(body.operationId, data);
          if (loseNextResponse) {
            loseNextResponse = false;
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Response lost after the transaction committed." }));
            return;
          }
        } else if (url.searchParams.has("soldcounts")) data = { counts: {} };
        else if (url.searchParams.has("lastprices")) data = { priceMap: {} };
        else if (url.searchParams.has("id")) {
          const bill = bills.find(b => b.id === url.searchParams.get("id"));
          data = { bill, items: bill ? bill.items : [] };
        } else data = { bills };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data || {}));
      return;
    }
    const file = path.resolve(root, "." + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "text/plain");
    res.end(fs.readFileSync(file));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Kolkata" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    await page.route("https://**/*", route => route.abort());
    await page.goto("http://127.0.0.1:" + server.address().port + "/billing.html");
    await page.waitForFunction(() => window.MedicineBilling?.ready() && window.MedicineBilling.snapshot().customers.some(c => c.name === "Alice"));
    await page.locator("#bill-saved-customer-select").selectOption("Alice");
    await page.evaluate(() => {
      const api = window.MedicineBilling;
      api.commit({ ...api.draft("medicine-1"), quantity: 1, sellPrice: 100 });
      api.setField("received", "20");
    });
    await page.locator("#save-bill-button").click();
    let reachedTimeout;
    try {
      await Promise.race([reached, new Promise((_, reject) => {
        reachedTimeout = setTimeout(() => reject(new Error("Save request did not reach the fixture")), 10000);
      })]);
    } finally { clearTimeout(reachedTimeout); }
    assert.equal(await page.locator("#new-bill-button").isDisabled(), true, "New Bill is disabled during the pending save");
    const guarded = await page.evaluate(() => {
      const api = window.MedicineBilling;
      api.newBill(true);
      api.setField("customerName", "Bob");
      api.setField("received", "999");
      const committed = api.commit({ ...api.draft("medicine-1"), quantity: 5, sellPrice: 100 });
      const bill = api.snapshot();
      return { committed, customer: bill.customerName, received: bill.received, quantities: bill.items.map(item => item.quantity) };
    });
    assert.deepEqual(guarded, { committed: false, customer: "Alice", received: 20, quantities: [1] });
    releaseSave();
    await page.waitForFunction(() => window.MedicineBilling.snapshot().id === "saved-1" && !window.MedicineBilling.snapshot().saving);
    assert.deepEqual([bills.length, bills[0].customer_name, bills[0].amount_received, bills[0].items[0].quantity], [1, "Alice", 20, 1]);
    console.log("PASS pending save preserves its original customer, items and receipt");

    await page.evaluate(() => {
      const api = window.MedicineBilling;
      api.commit({ ...api.snapshot().items[0], quantity: 2 });
      window.print = () => { window.fixturePrint = document.querySelector("#print-receipt-area").innerText; };
    });
    await page.locator("#print-bill-button").click();
    await page.waitForFunction(() => window.fixturePrint);
    const receipt = await page.evaluate(() => window.fixturePrint);
    assert.match(receipt, /FIXTURE-ISSUED-001/);
    assert.match(receipt, /Bill Amount\s*₹100\.00/);
    assert.match(receipt, /01 Jan 2024/);
    assert.deepEqual([bills[0].grand_total, bills[0].amount_received], [100, 20]);
    assert.equal((await page.evaluate(() => window.MedicineBilling.snapshot())).items[0].quantity, 2, "printing does not silently save an edited draft");
    console.log("PASS issued receipt uses saved amount and original issue date");

    await page.evaluate(() => window.MedicineBilling.newBill(true));
    await page.locator("#bill-saved-customer-select").selectOption("Bob");
    await page.evaluate(() => {
      const api = window.MedicineBilling;
      api.commit({ ...api.draft("medicine-1"), quantity: 1, sellPrice: 100 });
      api.setField("received", "20");
    });
    loseNextResponse = true;
    assert.equal(await page.evaluate(() => window.MedicineBilling.save(false)), false);
    assert.equal(bills.length, 2, "the unconfirmed request actually committed once");
    assert.equal((await page.evaluate(() => window.MedicineBilling.snapshot())).id, null);
    // A refresh would now include that bill's own balance. The retry must use
    // its original request/operation ID rather than create another sale.
    await page.evaluate(() => window.MedicineBilling.setField("received", "40"));
    assert.equal(await page.evaluate(() => window.MedicineBilling.save(false)), true);
    assert.deepEqual([bills.length, bills[1].customer_name, bills[1].amount_received], [2, "Bob", 20]);
    assert.deepEqual(await page.evaluate(() => {
      const bill = window.MedicineBilling.snapshot();
      return [bill.id, bill.received, bill.customerName];
    }), ["saved-2", 20, "Bob"], "successful replay restores what was actually committed");
    console.log("PASS lost-response retry reuses the original operation and committed form values");
    assert.deepEqual(errors, []);
  } finally {
    releaseSave();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); releaseSave?.(); server.close(); process.exitCode = 1; });
