"use strict";
const fs=require("node:fs"),path=require("node:path"),http=require("node:http"),assert=require("node:assert/strict");
const {createFixture}=require("./helpers/financial-fixture");
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||"playwright");
const ROOT=path.resolve(__dirname,"..");
const MEDICINE_ID="00000000-0000-4000-8000-000000000001";
const medicines=[{id:MEDICINE_ID,medicineName:"Test medicine",location:"A1",quantity:1000,mrp:1000,purchasePrice:100,sellPrice:1000}];
(async()=>{
 const fixture=await createFixture(),writes=[],errors=[];let loseNextPayment=false;
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,"http://fixture"),endpoint=url.pathname.split("/").pop();
   if(url.pathname.startsWith("/api/")){
    let status=200,json;
    if(endpoint==="supabase-config")json={enabled:true,backendManaged:true};
    else if(url.pathname.startsWith("/api/auth/"))json={authenticated:true,user:{email:"admin@example.test",role:"admin"}};
    else if(endpoint==="medicines")json={items:medicines};
    else{
     let raw="";for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):null;
     if(req.method!=="GET")writes.push({endpoint,method:req.method,body});
     const result=await fixture.request(endpoint,req.method,{body,query:Object.fromEntries(url.searchParams)});
     status=result.status;json=result.json;
     if(loseNextPayment&&endpoint==="payments"&&req.method==="POST"&&status===200){loseNextPayment=false;status=503;json={error:"Simulated lost response after commit"};}
    }
    res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(json));return;
   }
   const file=path.resolve(ROOT,"."+(url.pathname==="/" ? "/index.html" : url.pathname));
   if(!file.startsWith(ROOT+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
   res.setHeader("Content-Type",({".html":"text/html",".js":"text/javascript",".css":"text/css",".webmanifest":"application/manifest+json"})[path.extname(file)]||"application/octet-stream");res.end(fs.readFileSync(file));
  }catch(error){res.writeHead(500,{"Content-Type":"application/json"});res.end(JSON.stringify({error:error.message}));}
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
 const base="http://127.0.0.1:"+server.address().port;
 let checks=0;
 function check(label,actual,expected){assert.deepEqual(actual,expected,label);checks++;console.log("PASS "+label);}
 async function context(){const ctx=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:"Asia/Kolkata"});await ctx.route("https://**/*",r=>r.abort());return ctx;}
 async function page(ctx){const p=await ctx.newPage();p.setDefaultTimeout(10000);p.on("pageerror",e=>errors.push(e.message));p.on("dialog",d=>d.accept());await p.goto(base+"/customers.html");return p;}
 async function profile(p,name){
  await p.locator(".cust-card").filter({hasText:name}).first().click();
  await p.waitForFunction(n=>document.querySelector("#cust-profile-name").textContent.includes(n),name);
  await p.waitForFunction(()=>!document.querySelector("#cust-bills-container").textContent.includes("Loading")&&!document.querySelector("#cust-bills-container").textContent.includes("Refreshing"));
 }
 async function pay(p,amount){await p.locator("#cust-pay-amount").fill(String(amount));await p.locator("#cust-pay-btn").click();await p.waitForFunction(()=>!document.querySelector("#cust-pay-btn").disabled);}
 try{
  await fixture.createCustomer("Alice",1000);
  const ctx=await context(),p=await page(ctx);await profile(p,"Alice");
  await p.locator("#cust-edit-btn").click();await p.locator("#cust-edit-phone-input").fill("5555555555");
  await pay(p,200);await p.locator("#cust-edit-save-btn").click();await p.waitForFunction(()=>document.querySelector("#cust-edit-form").classList.contains("hidden"));
  let c=await fixture.customer("Alice");check("real RPC phone-only save preserves payment and anchor",[Number(c.balance),Number(c.openingBalance),c.phone],[800,1000,"5555555555"]);
  const metadata=writes.filter(x=>x.endpoint==="customers"&&x.method==="POST").at(-1).body;check("browser metadata request omits opening balance",Object.hasOwn(metadata,"openingBalance"),false);

  await p.locator("#cust-edit-btn").click();await p.locator("#cust-edit-balance-input").fill("500");await p.locator("#cust-edit-save-btn").click();await p.waitForFunction(()=>document.querySelector("#cust-edit-form").classList.contains("hidden"));
  c=await fixture.customer("Alice");check("deliberate browser balance adjustment uses guarded RPC",[Number(c.balance),Number(c.openingBalance)],[500,700]);

  await p.locator("#cust-edit-btn").click();await p.locator("#cust-edit-name-input").fill("Alice Renamed");await p.locator("#cust-edit-save-btn").click();await p.waitForFunction(()=>document.querySelector("#cust-edit-form").classList.contains("hidden")&&document.querySelector("#cust-profile-name").textContent==="Alice Renamed");
  const renamed=await fixture.customer("Alice Renamed");check("rename preserves stable account and money",[renamed.id===c.id,Number(renamed.balance)],[true,500]);
  check("renamed history keeps its received payment visible",(await p.locator("#cust-bills-container").innerText()).includes("200.00"),true);

  await p.locator("#cust-delete-btn").click();await p.waitForFunction(()=>document.querySelector("#cust-profile-content").classList.contains("hidden"));
  await p.locator("#cust-search").fill("Alice Renamed");await profile(p,"Alice Renamed");
  check("archived account is read-only with explicit Restore",[await p.locator("#cust-pay-btn").isDisabled(),await p.locator("#cust-delete-btn").innerText()],[true,"Restore"]);
  await p.locator("#cust-delete-btn").click();await p.waitForFunction(()=>document.querySelector("#cust-profile-name").textContent==="Alice Renamed"&&!document.querySelector("#cust-pay-btn").disabled);
  const restored=await fixture.customer("Alice Renamed");check("Restore preserves original account balance and anchor",[restored.archived,Number(restored.balance),Number(restored.openingBalance)],[false,500,700]);
  await p.setViewportSize({width:390,height:844});
  const layout=await p.evaluate(()=>({viewport:innerWidth,content:document.documentElement.scrollWidth}));
  check("expanded receipt history stays inside the phone viewport",layout.content<=layout.viewport,true);
  await ctx.close();

  await fixture.createCustomer("constructor",1000);
  const ctx2=await context(),p2=await page(ctx2);await profile(p2,"constructor");await pay(p2,200);
  check("reserved customer name saves through actual browser and PostgreSQL",[Number((await fixture.customer("constructor")).balance),(await p2.locator("#cust-pay-status").innerText()).includes("saved")],[800,true]);
  await ctx2.close();

  await fixture.createCustomer("Retry",1000);
  const ctx3=await context(),p3=await page(ctx3);await profile(p3,"Retry");loseNextPayment=true;await pay(p3,200);
  check("lost response leaves receipt entry available for safe retry",[await p3.locator("#cust-pay-amount").inputValue(),(await p3.locator("#cust-pay-status").innerText()).includes("not confirmed")],["200",true]);
  await p3.locator("#cust-pay-btn").click();await p3.waitForFunction(()=>!document.querySelector("#cust-pay-btn").disabled);
  const posts=writes.filter(x=>x.endpoint==="payments"&&x.method==="POST").slice(-2);
  check("browser reuses operationId after real commit response loss",posts[0].body.operationId,posts[1].body.operationId);
  const retry=await fixture.customer("Retry"),count=(await fixture.pg.query("SELECT count(*)::int AS n FROM public.payments WHERE customer_id=$1",[retry.id])).rows[0].n;
  check("PostgreSQL retry records one receipt",[count,Number(retry.balance)],[1,800]);
  await ctx3.close();

  // The complete counter workflow exercises the real browser's opening-anchor
  // creation, both receipt entry paths and a second bill/session against SQL.
  const ctx4=await context(),billing=await ctx4.newPage();billing.setDefaultTimeout(10000);billing.on("dialog",d=>d.accept());billing.on("pageerror",e=>errors.push(e.message));
  await billing.goto(base+"/billing.html");
  await billing.waitForFunction(id=>window.MedicineBilling?.ready()&&window.MedicineBilling.search("Test").some(m=>m.id===id),MEDICINE_ID);
  await billing.evaluate(id=>{const b=window.MedicineBilling;b.setField("customerName","Normative Flow");b.setField("openingBalance","200");b.commit({...b.draft(id),quantity:1,sellPrice:1000});b.setField("received","300");},MEDICINE_ID);
  await billing.locator("#save-bill-button").click();await billing.waitForFunction(()=>!document.querySelector("#save-bill-button").disabled&&document.querySelector("#bill-save-status").classList.contains("is-ok"));
  let normative=await fixture.customer("Normative Flow");check("typed opening plus first bill and counter receipt consolidates to900",[Number(normative.openingBalance),Number(normative.balance)],[200,900]);
  const accountPage=await page(ctx4);await profile(accountPage,"Normative Flow");await pay(accountPage,200);normative=await fixture.customer("Normative Flow");check("Customers receipt updates the same account to700",Number(normative.balance),700);
  await billing.evaluate(()=>window.MedicineBilling.newBill(true));await billing.locator("#bill-saved-customer-select").selectOption("Normative Flow");await billing.waitForFunction(()=>window.MedicineBilling.snapshot().previousBalance===700);
  await billing.evaluate(id=>{const b=window.MedicineBilling;b.commit({...b.draft(id),quantity:1,sellPrice:400});b.setField("received","100");},MEDICINE_ID);
  await billing.locator("#save-bill-button").click();await billing.waitForFunction(()=>!document.querySelector("#save-bill-button").disabled&&document.querySelector("#bill-save-status").classList.contains("is-ok"));
  normative=await fixture.customer("Normative Flow");const recent=(await fixture.pg.query("SELECT previous_balance,grand_total,amount_received FROM public.bills WHERE customer_id=$1 ORDER BY ledger_sequence DESC LIMIT 1",[normative.id])).rows[0];
  check("second bill carries700 and final balance is1000",[Number(recent.previous_balance),Number(recent.grand_total),Number(recent.amount_received),Number(normative.balance)],[700,400,100,1000]);
  const ctx5=await context(),other=await ctx5.newPage();other.setDefaultTimeout(10000);other.on("dialog",d=>d.accept());other.on("pageerror",e=>errors.push(e.message));await other.goto(base+"/billing.html");
  await other.waitForFunction(()=>window.MedicineBilling?.ready()&&window.MedicineBilling.snapshot().customers.some(c=>c.name==="Normative Flow"));await other.locator("#bill-saved-customer-select").selectOption("Normative Flow");await other.waitForFunction(()=>window.MedicineBilling.snapshot().previousBalance===1000);
  check("second browser context reads consolidated1000",await other.evaluate(()=>window.MedicineBilling.snapshot().previousBalance),1000);
  await other.reload();await other.waitForFunction(()=>window.MedicineBilling?.ready()&&window.MedicineBilling.snapshot().customers.some(c=>c.name==="Normative Flow"));await other.locator("#bill-saved-customer-select").selectOption("Normative Flow");await other.waitForFunction(()=>window.MedicineBilling.snapshot().previousBalance===1000);check("reload reads consolidated1000",await other.evaluate(()=>window.MedicineBilling.snapshot().previousBalance),1000);await ctx5.close();await ctx4.close();

  check("no uncaught browser errors",errors,[]);console.log(checks+" customer browser/RPC assertions passed");
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));await fixture.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
