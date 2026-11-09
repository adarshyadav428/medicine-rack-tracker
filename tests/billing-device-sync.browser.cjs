"use strict";
// Separate PC/phone browser sessions share the real API and PostgreSQL ledger.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const assert = require("node:assert/strict");
const { createFixture } = require("./helpers/financial-fixture");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const ROOT = path.resolve(__dirname, "..");
const MEDICINE_ID = "00000000-0000-4000-8000-000000000001";

(async () => {
  const fixture = await createFixture(), errors = [];
  let failReads = false, delayRead = null;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname.startsWith("/api/")) {
        let status = 200, json;
        if (url.pathname === "/api/supabase-config") json = { enabled: true, backendManaged: true };
        else if (url.pathname.startsWith("/api/auth/")) json = { authenticated: true, user: { email: "admin@example.test", role: "admin" } };
        else if (url.pathname === "/api/medicines") json = { items: [{ id: MEDICINE_ID, medicineName: "Test medicine", quantity: 1000, location: "A1", mrp: 100, purchasePrice: 50, sellPrice: 100 }] };
        else {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          if (failReads && req.method === "GET" && url.pathname === "/api/bills") {
            status = 503; json = { error: "Fixture offline" };
          } else {
            const result = await fixture.request(url.pathname.split("/").pop(), req.method, {
              body: raw ? JSON.parse(raw) : null, query: Object.fromEntries(url.searchParams)
            });
            status = result.status; json = result.json;
            if (delayRead && req.method === "GET" && url.searchParams.has("id")) {
              const gate = delayRead; delayRead = null; gate.reached(); await gate.wait;
            }
          }
        }
        res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); return;
      }
      const file = path.resolve(ROOT, "." + url.pathname);
      if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
      res.end(fs.readFileSync(file));
    } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const base = "http://127.0.0.1:" + server.address().port;
  let checks = 0;
  function check(label, actual, expected) { assert.deepEqual(actual, expected, label); checks++; console.log("PASS " + label); }
  async function open(phone) {
    const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: phone, hasTouch: phone, timezoneId: "Asia/Kolkata" });
    await ctx.route("https://**/*", r => r.abort());
    const page = await ctx.newPage(); page.setDefaultTimeout(10000);
    page.on("pageerror", e => errors.push(e.message)); page.on("dialog", d => d.accept());
    await page.goto(base + "/billing.html");
    await page.waitForFunction(() => window.MedicineBilling?.ready() && window.MedicineBilling.snapshot().customers.some(c => c.name === "Alice"));
    return page;
  }
  const snapshot = p => p.evaluate(() => window.MedicineBilling.snapshot());
  const refresh = p => p.evaluate(() => window.MedicineBilling.refreshSavedBills());
  try {
    await fixture.createCustomer("Alice", 200);
    const pc = await open(false), phone = await open(true);
    const aliceId = (await snapshot(phone)).customers.find(c => c.name === "Alice").id;
    await phone.locator("#phone-saved-customer").selectOption(aliceId);
    await phone.waitForFunction(() => window.MedicineBilling.snapshot().previousBalance === 200);
    check("visible phone dropdown selects the existing account and due", [(await snapshot(phone)).customerName, await phone.locator("#phone-saved-customer").inputValue()], ["Alice", aliceId]);
    await phone.evaluate(() => window.MedicineBilling.newBill(true));
    await pc.locator("#bill-saved-customer-select").selectOption("Alice");
    await pc.evaluate(id => {
      const b = window.MedicineBilling;
      b.commit({ ...b.draft(id), quantity: 2, sellPrice: 100 });
      b.setField("notes", "PC original"); b.setField("received", "20");
    }, MEDICINE_ID);
    check("PC creates one saved invoice", await pc.evaluate(() => window.MedicineBilling.save(false)), true);
    const original = await snapshot(pc), billId = original.id;
    await phone.locator("#phone-quick-history").click();
    await phone.locator('[data-edit-bill="' + billId + '"]').click();
    await phone.waitForFunction(id => window.MedicineBilling.snapshot().id === id && document.querySelector("#phone-billing").dataset.screen === "sale", billId);
    let s = await snapshot(phone);
    check("phone History opens the same saved bill and fields", [s.id, s.customerName, s.notes, s.received, s.items[0].quantity, s.previousBalance], [billId, "Alice", "PC original", 20, 2, 200]);

    // Edit through the actual phone item and payment controls.
    await phone.locator("#phone-billed-items [data-row]").first().click();
    await phone.locator("#phone-item-qty").fill("3"); await phone.locator("#phone-save").click();
    await phone.locator("#phone-billed-items [data-row]").first().click();
    await phone.locator("#phone-item-qty").fill("0.0001"); await phone.locator("#phone-save").click();
    check("phone rejects unsupported item precision before adding", [await phone.locator("#phone-billing").getAttribute("data-screen"), (await snapshot(phone)).items[0].quantity], ["item", 3]);
    await phone.locator("#phone-item-qty").fill("3");
    await phone.locator("#phone-item-batch").fill("PHONE-B123"); await phone.locator("#phone-item-expiry").fill("11/27");
    await phone.locator("#phone-save").click();
    await phone.locator("#phone-received").fill("-5"); await phone.locator("#phone-save").click();
    check("phone rejects negative received before it can become zero", [(await fixture.request("bills", "GET", { query: { id: billId } })).json.bill.amount_received, (await phone.locator("#phone-save-status").innerText()).includes("non-negative")], [20, true]);
    await phone.locator("#phone-received").fill("50");
    await phone.locator(".phone-sale-options summary").click();
    await phone.locator("#phone-notes").fill("Updated on phone");
    check("phone updates the existing invoice", await phone.evaluate(() => window.MedicineBilling.save(false)), true);
    await pc.evaluate(() => window.dispatchEvent(new Event("focus")));
    await pc.waitForFunction(() => window.MedicineBilling.snapshot().notes === "Updated on phone");
    s = await snapshot(pc);
    check("returning to PC loads clean editor from phone", [s.id, s.received, s.items[0].quantity, s.totalAmount], [billId, 50, 3, 300]);
    check("phone batch and expiry edits sync to PC", [s.items[0].batchNo, s.items[0].expiry], ["PHONE-B123", "11/27"]);
    check("shared ledger counts edits once", Number((await fixture.customer("Alice")).balance), 450);

    await pc.locator("#bill-notes").fill("Unsaved PC edit");
    await phone.locator("#phone-received").fill("60");
    await phone.evaluate(() => window.MedicineBilling.save(false));
    await refresh(pc); s = await snapshot(pc);
    check("remote update preserves unsaved PC fields", [s.notes, s.received, s.syncReloadAvailable], ["Unsaved PC edit", 50, true]);
    check("stale PC save is rejected by real ledger", await pc.evaluate(() => window.MedicineBilling.save(false)), false);
    const saved = await fixture.request("bills", "GET", { query: { id: billId } });
    check("conflict leaves phone changes authoritative", [saved.json.bill.notes, Number(saved.json.bill.amount_received)], ["Updated on phone", 60]);
    await pc.locator("#bill-sync-reload").click();
    await pc.waitForFunction(() => window.MedicineBilling.snapshot().received === 60);
    check("explicit reload resolves conflict", (await snapshot(pc)).notes, "Updated on phone");

    // The phone's not-yet-committed item editor must also block auto replacement.
    await phone.locator("#phone-billed-items [data-row]").first().click();
    await phone.locator("#phone-item-qty").fill("9");
    await pc.locator("#bill-notes").fill("New PC revision");
    await pc.evaluate(() => window.MedicineBilling.save(false));
    await refresh(phone);
    check("sync preserves an open phone item draft", [await phone.locator("#phone-item-qty").inputValue(), (await snapshot(phone)).syncReloadAvailable], ["9", true]);
    await phone.locator("#phone-sync-reload").click();
    await phone.waitForFunction(() => window.MedicineBilling.snapshot().notes === "New PC revision");
    check("phone reload returns to latest saved sale", [await phone.locator("#phone-billing").getAttribute("data-screen"), (await snapshot(phone)).items[0].quantity], ["sale", 3]);

    // A late read cannot replace typing or a different selected bill.
    let reached, release;
    const waiting = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    delayRead = { reached, wait: gate };
    const loading = phone.evaluate(() => window.MedicineBilling.reloadBill());
    await waiting;
    await phone.locator("#phone-received").fill("75"); release(); await loading;
    check("typing during a delayed load survives", (await snapshot(phone)).received, 75);
    await phone.evaluate(() => window.MedicineBilling.reloadBill());

    // Rejected New Bill must preserve the existing optimistic version.
    await phone.locator("#phone-received").fill("70");
    await phone.evaluate(() => { const old = window.confirm; window.confirm = () => false; window.MedicineBilling.newBill(); window.confirm = old; });
    check("cancelled New Bill keeps the revision usable", await phone.evaluate(() => window.MedicineBilling.save(false)), true);
    await refresh(pc);
    check("PC sees the final phone receipt", (await snapshot(pc)).received, 70);

    // No data disappears when refresh fails, and reconnect checks again.
    failReads = true; await refresh(pc);
    check("failed reads retain bill and history", [(await snapshot(pc)).id, await pc.locator('[data-edit-bill="' + billId + '"]').count(), (await snapshot(pc)).syncStatus.includes("Could not check")], [billId, 1, true]);
    failReads = false;
    await pc.evaluate(() => window.dispatchEvent(new Event("online")));
    await pc.waitForFunction(() => window.MedicineBilling.snapshot().syncStatus.includes("up to date"));

    await phone.reload();
    await phone.waitForFunction(() => window.MedicineBilling?.ready());
    await phone.locator("#phone-quick-history").click(); await phone.locator('[data-edit-bill="' + billId + '"]').click();
    await phone.waitForFunction(id => window.MedicineBilling.snapshot().id === id && document.querySelector("#phone-billing").dataset.screen === "sale", billId);
    s = await snapshot(phone);
    check("reload and History preserve saved cross-device changes", [s.id, s.notes, s.received, s.items[0].quantity], [billId, "New PC revision", 70, 3]);
    check("cross-device updates never duplicate the invoice", (await fixture.pg.query("SELECT count(*)::int n FROM public.bills")).rows[0].n, 1);
    check("final account remains consolidated", Number((await fixture.customer("Alice")).balance), 430);

    await fixture.updateBill(billId, { notes: "Periodic remote update" });
    await pc.waitForFunction(() => window.MedicineBilling.snapshot().notes === "Periodic remote update", null, { timeout: 6000 });
    check("visible page automatically polls for saved changes", (await snapshot(pc)).notes, "Periodic remote update");
    await pc.locator("#bill-history-search").fill("NO-MATCH");
    await pc.waitForFunction(() => document.querySelector("#bill-history-container").textContent.includes("No bills match"));
    await refresh(pc);
    check("refresh preserves History search filters", [await pc.locator("#bill-history-search").inputValue(), await pc.locator('[data-edit-bill="' + billId + '"]').count()], ["NO-MATCH", 0]);
    await refresh(phone);
    await phone.waitForFunction(() => window.MedicineBilling.snapshot().notes === "Periodic remote update");
    await phone.locator('[data-payment="cash"]').click();
    check("phone saves Paid in full against the latest version", await phone.evaluate(() => window.MedicineBilling.save(false)), true);
    await phone.locator("#phone-received").focus();
    await fixture.updateBill(billId, { amountReceived: 80 });
    await refresh(phone);
    await phone.waitForFunction(() => window.MedicineBilling.snapshot().received === 80 && document.querySelector("#phone-received").value === "80", null, { timeout: 6000 });
    check("remote partial payment replaces a previous Paid in full mode exactly", (await snapshot(phone)).received, 80);
    check("saved remote changes update a focused untouched phone field", await phone.locator("#phone-received").inputValue(), "80");

    // Existing accounts and their full histories must refresh on Customers too.
    const accountPC = await open(false), accountPhone = await open(true);
    for (const p of [accountPC, accountPhone]) {
      await p.goto(base + "/customers.html");
      await p.locator(".cust-card").filter({ hasText: "Alice" }).first().click();
      await p.waitForFunction(() => document.querySelector("#cust-profile-balance").textContent === "₹420.00" && !document.querySelector("#cust-pay-btn").disabled);
    }
    check("both devices read the pre-existing account and bill", [await accountPhone.locator("#cust-profile-balance").innerText(), (await accountPhone.locator("#cust-bills-container").innerText()).includes(original.number)], ["₹420.00", true]);
    await accountPC.locator("#cust-edit-btn").click();
    await accountPC.locator("#cust-edit-phone-input").fill("Unsaved contact");
    await accountPC.locator("#cust-pay-amount").fill("5");
    await accountPhone.locator("#cust-pay-amount").fill("20");
    await accountPhone.locator("#cust-pay-btn").click();
    await accountPhone.waitForFunction(() => document.querySelector("#cust-profile-balance").textContent === "₹400.00" && !document.querySelector("#cust-pay-btn").disabled);
    await accountPC.waitForFunction(() => document.querySelector("#cust-profile-balance").textContent === "₹400.00" && Array.from(document.querySelectorAll(".payment-row .cust-received")).some(el => el.textContent === "₹20.00"), null, { timeout: 6000 });
    check("payment syncs automatically without refresh or focus", await accountPC.locator("#cust-profile-balance").innerText(), "₹400.00");
    check("phone standalone payment syncs PC dues and history", [(await accountPC.locator("#cust-bills-container").innerText()).includes("20.00"), await accountPC.locator("#cust-edit-phone-input").inputValue(), await accountPC.locator("#cust-pay-amount").inputValue()], [true, "Unsaved contact", "5"]);
    check("received payments and debt increases have distinct readable colours", await accountPC.evaluate(() => ({
      received: getComputedStyle(document.querySelector(".payment-row .cust-received")).color,
      added: getComputedStyle(document.querySelector(".cust-debt-added")).color,
      label: document.querySelector(".payment-history-label").textContent.includes("Payment received")
    })), { received: "rgb(22, 101, 52)", added: "rgb(180, 35, 44)", label: true });
    check("phone history uses financial labels instead of medicine-entry labels", await accountPhone.evaluate(() => [
      getComputedStyle(document.querySelector(".payment-row td:nth-child(6)"), "::before").content,
      getComputedStyle(document.querySelector(".payment-row td:nth-child(7)"), "::before").content,
      document.documentElement.scrollWidth <= innerWidth
    ]), ['"Received"', '"Net change"', true]);
    await accountPC.screenshot({path:require("node:os").tmpdir()+"/medicine-customers-colours-desktop.png",fullPage:true});
    await accountPhone.screenshot({path:require("node:os").tmpdir()+"/medicine-customers-colours-phone.png",fullPage:true});
    await refresh(phone);
    check("Billing refreshes its existing customer cache", (await snapshot(phone)).customers.find(c => c.name === "Alice").balance, 400);
    check("current dues do not rewrite historical previous balance", (await snapshot(phone)).previousBalance, 200);
    await phone.evaluate(() => window.MedicineBilling.newBill(true));
    await phone.evaluate(() => window.MedicineBilling.setField("savedCustomer", "Alice", "change"));
    await phone.waitForFunction(() => window.MedicineBilling.snapshot().previousBalance === 400);
    await phone.evaluate(id => {
      const b = window.MedicineBilling; b.commit({ ...b.draft(id), quantity: 1, sellPrice: 100 }); b.setField("received", "10");
    }, MEDICINE_ID);
    check("new phone bill uses the freshly consolidated due", await phone.evaluate(() => window.MedicineBilling.save(false)), true);
    await accountPC.locator("#cust-sync-refresh").click();
    await accountPC.waitForFunction(() => document.querySelector("#cust-profile-balance").textContent === "₹490.00" && !document.querySelector("#cust-pay-btn").disabled);
    check("new bill updates existing account across devices", Number((await fixture.customer("Alice")).balance), 490);
    await accountPhone.locator("#cust-edit-btn").click();
    await accountPhone.locator("#cust-edit-name-input").fill("Alice Renamed");
    await accountPhone.locator("#cust-edit-phone-input").fill("1234567890");
    await accountPhone.locator("#cust-edit-save-btn").click();
    await accountPhone.waitForFunction(() => document.querySelector("#cust-profile-name").textContent === "Alice Renamed" && document.querySelector("#cust-edit-form").classList.contains("hidden"));
    await accountPC.locator("#cust-sync-refresh").click();
    await accountPC.waitForFunction(() => document.querySelector("#cust-profile-name").textContent === "Alice Renamed");
    check("renamed account stays selected with synchronized contact and history", [await accountPC.locator("#cust-profile-phone").innerText(), (await accountPC.locator("#cust-bills-container").innerText()).includes(original.number), await accountPC.locator("#cust-edit-phone-input").inputValue()], ["1234567890", true, "Unsaved contact"]);
    await refresh(phone);
    check("Billing picks up renamed customer without page reload", (await snapshot(phone)).customers.some(c => c.name === "Alice Renamed" && c.balance === 490), true);
    check("dropdown keeps the stable customer on a historical renamed bill", await phone.locator("#phone-saved-customer").inputValue(), aliceId);
    await fixture.createCustomer("New remote account", 75);
    await accountPC.waitForFunction(() => document.querySelector("#cust-list").textContent.includes("New remote account"), null, { timeout: 6000 });
    check("Customers periodically syncs additions while a profile is open", (await accountPC.locator("#cust-list").innerText()).includes("New remote account"), true);
    await accountPC.evaluate(() => {
      localStorage.setItem("medicineRackTracker.balancesImported.v1", "1");
      localStorage.setItem("medicineRackTracker.customers.v1", JSON.stringify([{ name: "Legacy zero account", phone: "123", balance: 0 }]));
    });
    await accountPC.locator("#cust-review-browser").click();
    await accountPC.waitForFunction(() => document.querySelector("#cust-list").textContent.includes("Legacy zero account"));
    check("review publishes an old browser-only zero-due profile through real RPC", Number((await fixture.customer("Legacy zero account")).balance), 0);
    await refresh(phone);
    check("recovered browser profile becomes available on the other device", (await snapshot(phone)).customers.some(c => c.name === "Legacy zero account"), true);
    await phone.locator("#phone-saved-customer").selectOption("");
    check("New customer option clears the old party", [(await snapshot(phone)).customerName, (await snapshot(phone)).customerPhone], ["", ""]);
    await phone.locator("#phone-customer").fill("Created from phone picker");
    await phone.locator("#phone-customer-phone").fill("5555555555");
    await phone.locator("#phone-save-customer").click();
    await phone.waitForFunction(() => window.MedicineBilling.snapshot().customers.some(c => c.name === "Created from phone picker"));
    check("phone can save a customer without issuing a bill", [(await fixture.customer("Created from phone picker")).phone, (await fixture.pg.query("SELECT count(*)::int n FROM public.bills")).rows[0].n], ["5555555555", 2]);
    await fixture.createCustomer("Credit account", -25); await refresh(phone);
    const creditId = (await snapshot(phone)).customers.find(c => c.name === "Credit account").id;
    await phone.evaluate(() => window.MedicineBilling.newBill(true));
    await phone.locator("#phone-saved-customer").selectOption(creditId);
    await phone.waitForFunction(() => window.MedicineBilling.snapshot().previousBalance === -25);
    check("customer dropdown preserves credit balances", [await phone.locator("#phone-opening").inputValue(), await phone.locator("#phone-opening").evaluate(el => el.checkValidity())], ["-25", true]);
    check("no uncaught browser errors", errors, []);
    console.log(checks + " device sync browser/API/PostgreSQL assertions passed");
  } finally {
    await browser.close(); await new Promise(resolve => server.close(resolve)); await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
