"use strict";
// Real profit/PIN/auth handlers with a local REST fixture. No live credentials.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), os = require("node:os"), Module = require("node:module");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const ROOT = path.resolve(__dirname,".."), OWNER = "adarshyadavazm123@gmail.com";
process.env.PROFIT_OWNER_EMAIL = OWNER;
const artifacts = path.join(os.tmpdir(),"medicine-profit-owner-qa");
const db = {
  app_settings: [],
  bills: [
    {id:"first",bill_number:"AM-FIRST",customer_name:"Alice",created_at:"2026-11-07T18:30:00.000Z",grand_total:100},
    {id:"last",bill_number:"AM-LAST",customer_name:"Alice",created_at:"2026-11-08T18:29:59.999Z",grand_total:200},
    {id:"next",bill_number:"AM-NEXT",customer_name:"Bob",created_at:"2026-11-08T18:30:00.000Z",grand_total:500},
  ],
  bill_items: [
    {id:"1",bill_id:"first",medicine_name:"Medicine A",sell_price:100,purchase_price:60,quantity:1},
    {id:"2",bill_id:"last",medicine_name:"Medicine A",sell_price:200,purchase_price:100,quantity:1},
    {id:"3",bill_id:"next",medicine_name:"Medicine B",sell_price:500,purchase_price:200,quantity:1},
  ],
};
function email(req) {
  const account = /qa-account=([^;]+)/.exec(req.headers.cookie || "");
  return account && account[1] === "other" ? "other-admin@example.test" : account && account[1] === "out" ? "" : OWNER;
}
const real = require("../lib/supabase-server");
const fake = {
  ...real,
  getServerConfig: () => ({enabled:true,serviceRoleKey:"local-profit-fixture",projectUrl:"https://fixture.invalid"}),
  getSessionUser: async req => email(req) ? {user:{id:"fixture",email:email(req)}} : null,
  getRoleInfo: async () => ({role:"admin",isActive:true}),
  requireAuthContext: async (req,res) => {
    if (!email(req)) {real.sendJson(res,401,{error:"Login required."});return null;}
    return {user:{id:"fixture",email:email(req),role:"admin"}};
  },
  callSupabaseRest: async (_config,route,options={}) => {
    const [table,qs] = route.split("?"), params = new URLSearchParams(qs), rows = db[table];
    if (!rows) throw Error("Unexpected table: " + table);
    if (options.method === "POST") {
      const body = Array.isArray(options.body) ? options.body : [options.body];
      for (const row of body) {const existing=rows.find(r=>r.key===row.key);if(existing)Object.assign(existing,row);else rows.push({...row});}
      return body;
    }
    let result = rows.filter(row => [...params].every(([key,value]) => {
      if (value.startsWith("eq.")) return String(row[key]) === value.slice(3);
      if (value.startsWith("gte.")) return row[key] >= value.slice(4);
      if (value.startsWith("lt.")) return row[key] < value.slice(3);
      if (value.startsWith("in.(")) return value.slice(4,-1).split(",").includes(row[key]);
      return true;
    }));
    return result.slice(Number(params.get("offset") || 0), Number(params.get("offset") || 0)+Number(params.get("limit") || 10000));
  },
};
const originalLoad = Module._load;
Module._load = function(name) {return /supabase-server$/.test(name) ? fake : originalLoad.apply(this,arguments);};
const handlers = {profit:require("../api/profit"),"profit-pin":require("../api/profit-pin"),auth:require("../api/auth")};
const {hashPin} = require("../lib/profit-pin");
Module._load = originalLoad;
db.app_settings.push({key:"profit_pin",value:hashPin("1234")});
let holdAll = null, heldAll = null, profitRequests = [];
function deferred() {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,"http://fixture");
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname.startsWith("/api/auth/")) return await handlers.auth(req,res);
      const endpoint = url.pathname.split("/").pop();
      if (handlers[endpoint]) {
        if(endpoint === "profit") {
          profitRequests.push(req.url);
          if(holdAll && url.searchParams.get("period") === "all") {heldAll=holdAll;holdAll=null;heldAll.reached.resolve();await heldAll.release.promise;}
        }
        let raw="";for await(const chunk of req)raw+=chunk;
        req.body=raw?JSON.parse(raw):null;req.query=Object.fromEntries(url.searchParams);
        return await handlers[endpoint](req,res);
      }
      const payload = endpoint === "supabase-config" ? {enabled:true,backendManaged:true} : endpoint === "medicines" ? {items:[]} : endpoint === "customers" ? {customers:[]} : endpoint === "payments" ? {payments:[]} : {bills:[],counts:{},priceMap:{},mrpScoped:true};
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(payload));return;
    }
    const file = path.resolve(ROOT,"."+url.pathname);
    if (!file.startsWith(ROOT+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.setHeader("Content-Type",({".html":"text/html",".js":"text/javascript",".css":"text/css",".webmanifest":"application/manifest+json"})[path.extname(file)]||"application/octet-stream");
    res.end(fs.readFileSync(file));
  } catch(error){res.writeHead(500,{"Content-Type":"application/json"});res.end(JSON.stringify({error:error.message}));}
});
(async () => {
  fs.mkdirSync(artifacts,{recursive:true});
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const base="http://127.0.0.1:"+server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  const errors=[];let checks=0;
  function check(label,actual,expected){assert.deepEqual(actual,expected,label);checks++;console.log("PASS "+label);}
  async function page(account="owner",phone=false){
    const ctx=await browser.newContext({viewport:{width:phone?390:1440,height:900},hasTouch:phone,isMobile:phone,timezoneId:"America/Los_Angeles"});
    await ctx.addCookies([{name:"qa-account",value:account,url:base}]);
    await ctx.route("https://**/*",r=>r.abort());
    const p=await ctx.newPage();p.setDefaultTimeout(10000);p.on("pageerror",e=>errors.push(e.message));return p;
  }
  try {
    const p=await page();await p.goto(base+"/billing.html");
    await p.locator('.site-nav [data-profit-link]').waitFor();
    check("owner sees Profit beside Access Control",await p.locator('.site-nav a[href="access.html"] + a').textContent(),"Profit");
    await p.screenshot({path:path.join(artifacts,"profit-navigation.png")});
    await p.locator('.site-nav [data-profit-link]').click();
    await p.locator("#pin-input").fill("1234");await p.locator("#pin-submit").click();
    await p.waitForFunction(()=>document.querySelector("#stat-profit").textContent!=="—");
    await p.locator("#profit-from").fill("2026-11-08");await p.locator("#profit-to").fill("2026-11-08");
    await p.locator('#profit-range-form button').click();
    await p.waitForFunction(()=>document.querySelector("#stat-period-label").textContent.includes("IST"));
    check("custom same-day interval profit includes the final millisecond only",await p.locator("#stat-profit").textContent(),"₹140.00");
    check("date range returns both boundary bills, excludes next day",await p.locator("#bill-body tr td:first-child").allTextContents(),["AM-LAST","AM-FIRST"]);
    check("bill dates stay in IST on a browser in another timezone",await p.locator("#bill-body tr td:nth-child(2)").allTextContents(),["08 Nov 2026","08 Nov 2026"]);
    const before=profitRequests.length;
    await p.locator("#profit-from").fill("2026-11-10");await p.locator('#profit-range-form button').click();
    await p.locator("#dashboard-error").waitFor({state:"visible"});
    check("reversed dates do not send another query",profitRequests.length,before);
    await p.locator("#profit-from").fill("");await p.locator('#profit-range-form button').click();
    check("missing date is blocked by form validation",profitRequests.length,before);
    holdAll={reached:deferred(),release:deferred()};const gate=holdAll;
    await p.locator('[data-period="all"]').click();await gate.reached.promise;
    await p.locator("#profit-from").fill("2026-11-08");await p.locator('#profit-range-form button').click();
    await p.waitForFunction(()=>document.querySelector("#stat-profit").textContent==="₹140.00");
    const oldResponse=p.waitForResponse(r=>r.url().endsWith("/api/profit?period=all"));gate.release.resolve();await oldResponse;
    await p.waitForFunction(()=>document.querySelector("#stat-period-label").textContent.includes("IST"));
    check("older request cannot overwrite the selected interval",await p.locator("#stat-profit").textContent(),"₹140.00");
    await p.screenshot({path:path.join(artifacts,"profit-desktop.png"),fullPage:true});
    await p.locator("#profit-lock-btn").click();await p.waitForFunction(()=>document.querySelector("#pin-msg").textContent.startsWith("Locked."));
    check("locking clears displayed figures",await p.locator("#stat-profit").textContent(),"—");
    await p.reload();await p.locator("#pin-submit").waitFor({state:"visible"});
    check("reload stays locked after server cookie is cleared",await p.locator("#dashboard").isVisible(),false);
    const phone=await page("owner",true);await phone.goto(base+"/billing.html");
    await phone.waitForFunction(()=>document.body.classList.contains("phone-billing-active"));await phone.locator("#phone-back").click();
    check("owner can open Profit from phone billing menu",await phone.locator("#phone-profit-link").isVisible(),true);
    await phone.locator("#phone-profit-link").click();await phone.locator("#pin-input").fill("1234");await phone.locator("#pin-submit").click();
    await phone.waitForFunction(()=>document.querySelector("#stat-profit").textContent!=="—");
    await phone.locator("#profit-from").fill("2026-11-08");await phone.locator("#profit-to").fill("2026-11-08");await phone.locator('#profit-range-form button').click();
    await phone.waitForFunction(()=>document.querySelector("#stat-profit").textContent==="₹140.00");
    check("phone custom interval matches desktop",await phone.locator("#stat-profit").textContent(),"₹140.00");
    for(const width of [320,390,430]){await phone.setViewportSize({width,height:900});check("profit page fits phone width "+width,await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    await phone.setViewportSize({width:390,height:900});await phone.screenshot({path:path.join(artifacts,"profit-phone.png"),fullPage:true});
    await phone.locator("#bill-body").scrollIntoViewIfNeeded();
    check("phone bill breakdown contains matching interval rows",await phone.locator("#bill-body tr").count(),2);
    await phone.screenshot({path:path.join(artifacts,"profit-phone-bills.png")});
    for(const phoneMode of [false,true]){
      const other=await page("other",phoneMode);await other.goto(base+"/billing.html");
      await other.waitForFunction(()=>window.MedicineBilling?.ready());
      check("other admin has no desktop Profit link (phone="+phoneMode+")",await other.locator('.site-nav [data-profit-link]').count(),0);
      if(phoneMode){await other.locator("#phone-back").click();check("other admin has no phone Profit link",await other.locator("#phone-profit-link").isVisible(),false);}
      await other.goto(base+"/profit.html");await other.waitForFunction(()=>document.querySelector("#pin-title").textContent==="Owner access only");
      check("direct Profit URL refuses other admin",[await other.locator("#dashboard").isVisible(),await other.locator("#pin-submit").isDisabled()],[false,true]);
    }
    check("browser has no JavaScript errors",errors,[]);
    console.log(checks+" browser checks passed; screenshots: "+artifacts);
  } finally {if(heldAll)heldAll.release.resolve();await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
