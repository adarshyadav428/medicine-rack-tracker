"use strict";
// Phone pricing and item entry against real API handlers and isolated PostgreSQL.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), os = require("node:os");
const assert = require("node:assert/strict");
const { createFixture } = require("./helpers/financial-fixture");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS = path.join(os.tmpdir(), "medicine-phone-pricing-qa");
const FIRST = "00000000-0000-4000-8000-000000000011", SECOND = "00000000-0000-4000-8000-000000000012", UNKNOWN = "00000000-0000-4000-8000-000000000013";
const medicines = [
  { id: FIRST, medicineName: "ENTERO QUINOL", seller: "Milan", location: "A1", mrp: 61, purchasePrice: 44.91, sellPrice: 54.56, quantity: 0 },
  { id: SECOND, medicineName: "ENTERO QUINOL", seller: "Other supplier", location: "B2", mrp: 56, purchasePrice: 41.41, sellPrice: 50.16, quantity: 5 },
  { id: UNKNOWN, medicineName: "Unknown stock medicine", seller: "", location: "", mrp: null, purchasePrice: null, sellPrice: 25, quantity: null }
];
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 10000); })]); }
  finally { clearTimeout(timer); }
}

(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const fixture = await createFixture(), errors = [], contexts = [];
  let heldCustomer = null, failCustomer = null, inventoryWrites = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname.startsWith("/api/")) {
        let status = 200, json;
        if (url.pathname === "/api/supabase-config") json = { enabled: true, backendManaged: true };
        else if (url.pathname.startsWith("/api/auth/")) json = { authenticated: true, user: { email: "admin@example.test", role: "admin" } };
        else if (url.pathname === "/api/medicines") { if(req.method!=="GET")inventoryWrites++; json = { items: medicines }; }
        else {
          let raw = ""; for await (const chunk of req) raw += chunk;
          const customer = url.searchParams.get("customer"), history = url.searchParams.get("lastprices") === "1";
          if (history && failCustomer === customer) { status = 503; json = { error: "Fixture price-history unavailable" }; }
          else {
            const result = await fixture.request(url.pathname.split("/").pop(), req.method, { body: raw ? JSON.parse(raw) : null, query: Object.fromEntries(url.searchParams) });
            status = result.status; json = result.json;
            if (history && heldCustomer && heldCustomer.name === customer) {
              const gate = heldCustomer; heldCustomer = null; gate.reached.resolve(); await gate.release.promise;
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
  async function page(phone = true) {
    const ctx = await browser.newContext({ viewport: { width: phone ? 390 : 1440, height: phone ? 844 : 1000 }, isMobile: phone, hasTouch: phone, timezoneId: "Asia/Kolkata" });
    contexts.push(ctx); await ctx.route("https://**/*", r => r.abort());
    const p = await ctx.newPage(); p.setDefaultTimeout(10000);
    p.on("pageerror", e => errors.push(e.message)); p.on("dialog", d => d.accept());
    await p.goto(base + "/billing.html");
    await p.waitForFunction(() => window.MedicineBilling?.ready() && window.MedicineBilling.snapshot().customers.some(c => c.name === "Alice"));
    return p;
  }
  const result = (p, id = FIRST) => p.locator('[data-medicine="' + id + '"]');
  const snap = p => p.evaluate(() => window.MedicineBilling.snapshot());
  const refresh = p => p.evaluate(() => window.MedicineBilling.refreshPriceHistory({ force: true }));
  try {
    await fixture.createCustomer("Alice"); await fixture.createCustomer("Bob");
    await fixture.createBill("Alice", [{ medicineId: FIRST, medicineName: "ENTERO QUINOL", mrp:61, quantity: 1, sellPrice: 48.5 }]);
    await fixture.createBill("Bob", [{ medicineId: FIRST, medicineName: "ENTERO QUINOL", mrp:61, quantity: 1, sellPrice: 52 }]);
    await fixture.createBill("Alice", [{medicineId:SECOND,medicineName:"ENTERO QUINOL",mrp:56,quantity:1,sellPrice:45}]);
    const p = await page(), alice = (await snap(p)).customers.find(c => c.name === "Alice"), bob = (await snap(p)).customers.find(c => c.name === "Bob");
    await p.locator("#phone-add-items").click();await p.locator("#phone-item-search").fill("entero");
    await p.waitForFunction(id=>document.querySelector('[data-medicine="'+id+'"] .phone-result-latest-rate').textContent.includes("52.00"),FIRST);
    check("unselected customer is explained once instead of on every medicine",[await p.locator(".phone-result-customer-rate").count(),await p.locator("#phone-search-customer").isVisible()],[0,true]);
    await p.screenshot({path:path.join(ARTIFACTS,"search-no-customer-390.png")});
    await p.locator("#phone-search-customer").click();
    check("customer shortcut returns to the actual saved-customer picker",await p.locator("#phone-saved-customer").isVisible(),true);
    await p.locator("#phone-saved-customer").selectOption(alice.id);
    await p.locator("#phone-add-items").click(); await p.locator("#phone-item-search").fill("entero");
    await p.waitForFunction(id => window.MedicineBilling.priceInfo(id).customerStatus === "ready" && window.MedicineBilling.priceInfo(id).globalStatus === "ready", FIRST);
    await p.waitForFunction(id => document.querySelector('[data-medicine="' + id + '"] .phone-result-latest-rate').textContent.includes("52.00"), FIRST);
    check("duplicate inventory entries remain separate search choices", await p.locator(".phone-search-item").count(), 2);
    check("search exposes MRP and purchase before selection", [(await result(p).locator(".phone-result-mrp").innerText()).includes("61.00"), (await result(p).locator(".phone-result-purchase").innerText()).includes("44.91")], [true, true]);
    check("search separates customer and latest overall rates", [(await result(p).locator(".phone-result-customer-rate").innerText()).includes("48.50"), (await result(p).locator(".phone-result-latest-rate").innerText()).includes("52.00")], [true, true]);
    check("duplicate row retains its own MRP and purchase", [(await result(p, SECOND).locator(".phone-result-mrp").innerText()).includes("56.00"), (await result(p, SECOND).locator(".phone-result-purchase").innerText()).includes("41.41")], [true, true]);
    check("same name with another MRP has its own last rate", (await result(p, SECOND).locator(".phone-result-customer-rate").innerText()).includes("45.00"), true);
    check("inventory selling rate and stock are removed from the phone list",[await p.locator(".phone-result-selling").count(),/Stock:|Inventory sell/i.test(await p.locator("#phone-search-results").innerText())],[0,false]);
    check("MRP purchase and sold prices have distinct purposeful colours",await result(p).evaluate(el=>[
      getComputedStyle(el.querySelector(".phone-result-mrp")).color,
      getComputedStyle(el.querySelector(".phone-result-purchase")).color,
      getComputedStyle(el.querySelector(".phone-result-latest-rate b")).color
    ]),["rgb(40, 79, 147)","rgb(138, 87, 14)","rgb(17, 113, 72)"]);
    check("normal search does not show a large refresh control", await p.locator("#phone-sync-refresh").isVisible(), false);
    await p.screenshot({ path: path.join(ARTIFACTS, "search-prices-390.png") });

    const desktop = await page(false); await desktop.locator("#bill-saved-customer-select").selectOption("Alice"); await desktop.locator("#billing-search").fill("entero");
    await desktop.waitForFunction(id => window.MedicineBilling.priceInfo(id).customerStatus === "ready", FIRST);
    check("shared phone pricing matches PC inventory and history values", await p.evaluate(id => window.MedicineBilling.priceInfo(id), FIRST).then(x => [x.mrp, x.purchasePrice, x.inventoryRate, x.customerLastRate, x.latestSoldRate]), await desktop.evaluate(id => { const x = window.MedicineBilling.priceInfo(id); return [x.mrp, x.purchasePrice, x.inventoryRate, x.customerLastRate, x.latestSoldRate]; }, FIRST));
    await desktop.locator(".medicine-dropdown-edit-btn").first().click();
    await desktop.locator("#manual-markup").fill("-10");
    check("inventory-detail editor also warns about negative markup",await desktop.locator("#inventory-loss-warning").isVisible(),true);
    await desktop.locator("#manual-add-close").click();

    await result(p).click();
    check("item editor keeps MRP purchase and both rates visible", await Promise.all(["item-mrp-value", "item-purchase", "item-customer-rate", "item-latest-rate"].map(id => p.locator("#phone-" + id).isVisible())), [true, true, true, true]);
    check("customer's historical rate is the initial suggested sell rate", await p.locator("#phone-item-rate").inputValue(), "48.5");
    await p.locator("#phone-use-latest-rate").click(); check("Use latest rate is an explicit action", await p.locator("#phone-item-rate").inputValue(), "52");
    await p.locator(".phone-item-details summary").click();await p.locator("#phone-item-mrp").fill("56");
    await p.waitForFunction(()=>document.querySelector("#phone-item-customer-rate").textContent.includes("45.00"));
    check("editing MRP changes only the matching price references",await p.locator("#phone-item-rate").inputValue(),"52");
    await p.locator("#phone-item-mrp").fill("61");await p.locator(".phone-item-details summary").click();
    await p.locator("#phone-item-rate").fill("33.25"); await p.locator("#phone-item-qty").fill("2");
    await p.locator("#phone-item-sales-history").click(); await p.locator("#medicine-sales-done").click();
    check("sales history opens without discarding the item draft", [await p.locator("#phone-item-qty").inputValue(), await p.locator("#phone-item-rate").inputValue()], ["2", "33.25"]);
    await refresh(p);
    const gate = { name: "Alice", reached: deferred(), release: deferred() }; heldCustomer = gate;
    await p.evaluate(() => { window.fixturePriceRefresh = window.MedicineBilling.refreshPriceHistory({ force: true }); });
    await bounded(gate.reached.promise, "Delayed customer history request did not arrive"); gate.release.resolve(); await p.evaluate(() => window.fixturePriceRefresh);
    check("history refresh never overwrites typed quantity or selling rate", [await p.locator("#phone-item-qty").inputValue(), await p.locator("#phone-item-rate").inputValue()], ["2", "33.25"]);
    await p.locator(".phone-item-details summary").click();
    await p.locator("#phone-item-markup").fill("-10");
    check("negative phone markup has a visible warning", await p.locator("#phone-item-loss-warning").isVisible(), true);
    await p.locator("#phone-item-rate").fill("33.25");
    await p.locator("#phone-item-batch").fill("B-TEST"); await p.locator("#phone-item-expiry").fill("11/27");
    await p.locator(".phone-item-details summary").click();
    await p.locator("#phone-save").click(); await p.waitForFunction(() => document.querySelector("#phone-billing").dataset.screen === "search");
    check("Add & continue preserves search text ready to replace", await p.locator("#phone-item-search").evaluate(el => [el.value, el.selectionStart, el.selectionEnd]), ["entero", 0, 6]);
    check("added row is marked in search", await result(p).locator(".phone-in-bill").isVisible(), true);
    check("optional details survive collapse and commit", await p.evaluate(() => { const i = window.MedicineBilling.snapshot().items[0]; return [i.batchNo, i.expiry, i.quantity, i.sellPrice]; }), ["B-TEST", "11/27", 2, 33.25]);
    await result(p, SECOND).click(); await p.locator("#phone-save-new").click(); await p.waitForFunction(() => document.querySelector("#phone-billing").dataset.screen === "sale");
    check("Add & review retains both inventory identities", (await snap(p)).items.map(i => i.medicineId), [FIRST, SECOND]);
    await p.locator("#phone-billed-items [data-row]").first().click(); await p.locator("#phone-item-qty").fill("9"); await p.locator("#phone-save-new").click();
    check("Cancel editing leaves the stored draft quantity unchanged", (await snap(p)).items[0].quantity, 2);

    await p.locator("#phone-add-items").click(); await p.locator("#phone-item-search").fill("unknown");
    check("unknown stock is also omitted instead of adding visual noise", /Stock:/i.test(await result(p, UNKNOWN).innerText()), false);
    check("missing history is not displayed as a zero sale", /no previous|not sold|no sale/i.test(await result(p, UNKNOWN).locator(".phone-result-latest-rate").innerText()), true);
    await p.locator("#phone-item-search").fill("entero");
    await refresh(p);
    const old = { name: "Alice", reached: deferred(), release: deferred() }; heldCustomer = old;
    await p.evaluate(() => { window.fixtureOldPriceRefresh = window.MedicineBilling.refreshPriceHistory({ force: true }); }); await bounded(old.reached.promise, "Previous-customer history request did not arrive");
    await p.locator("#phone-back").click(); await p.locator("#phone-saved-customer").selectOption(bob.id); await p.locator("#phone-add-items").click();
    old.release.resolve(); await p.evaluate(() => window.fixtureOldPriceRefresh);
    await p.waitForFunction(id => window.MedicineBilling.priceInfo(id).customerStatus === "ready" && window.MedicineBilling.priceInfo(id).customerLastRate === 52, FIRST);
    check("late previous-customer history cannot replace the new customer's rate", await p.evaluate(id => window.MedicineBilling.priceInfo(id).customerLastRate, FIRST), 52);
    failCustomer = "Bob"; await refresh(p);
    await p.waitForFunction(() => /unavailable|could not|retry|failed/i.test(document.querySelector(".phone-result-customer-rate").textContent));
    check("history failure is distinct from no sale", await p.evaluate(id => window.MedicineBilling.priceInfo(id).customerStatus, FIRST), "error");
    check("failed history has a visible unavailable state", /unavailable|could not|retry|failed/i.test(await result(p).locator(".phone-result-customer-rate").innerText()), true);
    await result(p).click();
    await p.locator("#phone-item-rate").fill("34");
    failCustomer = null; await p.locator("#phone-price-retry").click();
    await p.waitForFunction(id => window.MedicineBilling.priceInfo(id).customerStatus === "ready", FIRST);
    check("Retry prices recovers history without changing a typed item rate", await p.locator("#phone-item-rate").inputValue(), "34");
    await p.locator("#phone-back").click();

    const layouts = [];
    for (const width of [320, 390, 430]) {
      await p.setViewportSize({ width, height: 844 });
      const searchLayout = await p.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, searchTop: document.querySelector("#phone-item-search").getBoundingClientRect().top }));
      check("search stays usable at " + width + "px", searchLayout.scroll <= width && searchLayout.searchTop < 300, true);
      await p.screenshot({ path: path.join(ARTIFACTS, "search-prices-" + width + ".png") });
      await result(p).click();
      await p.screenshot({ path: path.join(ARTIFACTS, "item-prices-" + width + ".png") });
      await p.setViewportSize({ width, height: 480 });
      await p.waitForFunction(() => {
        const input = document.querySelector("#phone-item-qty").getBoundingClientRect();
        const footer = document.querySelector(".phone-sale-footer").getBoundingClientRect();
        const header = document.querySelector(".phone-sale-header").getBoundingClientRect();
        return input.top >= header.bottom && input.bottom <= footer.top;
      });
      check("quantity stays above the keyboard footer at " + width + "px", await p.locator("#phone-item-qty").evaluate(el => document.activeElement === el), true);
      const editLayout = await p.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, footer: document.querySelector(".phone-sale-footer").getBoundingClientRect().bottom }));
      check("item editor fits a short keyboard-height viewport at " + width + "px", editLayout.scroll <= width && editLayout.footer <= 481, true);
      await p.screenshot({ path: path.join(ARTIFACTS, "item-prices-keyboard-" + width + ".png") });
      layouts.push({ searchLayout, editLayout }); await p.setViewportSize({ width, height: 844 }); await p.locator("#phone-back").click();
    }
    await p.locator("#phone-save-new").click();
    await p.locator("#phone-save").click();
    await p.waitForFunction(() => !!window.MedicineBilling.snapshot().id && !window.MedicineBilling.snapshot().saving);
    const saved = (await fixture.request("bills", "GET", { query: { id: (await snap(p)).id } })).json;
    check("phone saves both selected inventory entries through real API", saved.items.map(i => [i.medicine_id, Number(i.quantity), Number(i.sell_price)]), [[FIRST, 2, 33.25], [SECOND, 1, 45]]);
    check("saved line keeps its optional fields", [saved.items[0].batch_no, saved.items[0].expiry], ["B-TEST", "11/27"]);
    await desktop.evaluate(id=>window.MedicineBilling.editBill(id),saved.bill.id);
    const rowId=await desktop.evaluate(()=>window.MedicineBilling.snapshot().items[0]._rowId);
    await desktop.locator("#markup-"+rowId).fill("-10");
    check("negative PC markup has a visible warning",await desktop.locator("#loss-"+rowId).isVisible(),true);
    await p.evaluate(()=>window.MedicineBilling.newBill(true));
    await p.locator("#phone-saved-customer").selectOption(alice.id);
    await p.locator("#phone-add-items").click();await p.locator("#phone-add-only").click();
    await p.locator("#manual-name").fill("One-off phone medicine");await p.locator("#manual-mrp").fill("100");
    await p.locator("#manual-purchase").fill("50");await p.locator("#manual-markup").fill("-20");
    await p.locator("#manual-qty").fill("2");
    check("bill-only editor warns before accepting negative markup",await p.locator("#manual-loss-warning").isVisible(),true);
    await p.locator("#manual-add-submit").click();
    await p.waitForFunction(()=>document.querySelector("#phone-billing").dataset.screen==="sale");
    check("bill-only entry is added without any inventory write",[inventoryWrites,(await snap(p)).items[0].billOnly],[0,true]);
    await p.locator("#phone-save").click();await p.waitForFunction(()=>!!window.MedicineBilling.snapshot().id&&!window.MedicineBilling.snapshot().saving);
    const manualId=(await snap(p)).id;
    const manual=(await fixture.request("bills","GET",{query:{id:manualId}})).json;
    check("bill-only invoice stores marker and exact charge",[manual.items[0].bill_only,Number(manual.bill.grand_total)],[true,80]);
    await desktop.evaluate(id=>window.MedicineBilling.editBill(id),manualId);
    check("bill-only medicine reopens on PC with exclusion intact",(await snap(desktop)).items[0].billOnly,true);
    check("no uncaught browser errors", errors, []);
    console.log(JSON.stringify({ checks, layouts, artifacts: ARTIFACTS }));
  } finally {
    if (heldCustomer) heldCustomer.release.resolve();
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
