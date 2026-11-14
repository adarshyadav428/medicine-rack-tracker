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

  // Open an older invoice from Customers, preview it without writes, then edit
  // the same saved bill through desktop and phone controls against the real RPC.
  await fixture.createCustomer("Preview Customer",200);
  const firstBill=await fixture.createBill("Preview Customer",[{medicineId:MEDICINE_ID,medicineName:"Test medicine",quantity:1,sellPrice:1000,mrp:1000,purchasePrice:100}],{amountReceived:300});
  assert.equal(firstBill.status,200);
  const previewId=firstBill.json.bill.id,previewNumber=firstBill.json.bill.bill_number;
  await fixture.createBill("Preview Customer",[{medicineId:MEDICINE_ID,medicineName:"Test medicine",quantity:1,sellPrice:400,mrp:1000,purchasePrice:100}],{amountReceived:100});
  for(const mobile of [false,true]){
   const previewCtx=mobile?await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:"Asia/Kolkata"}):await context();
   if(mobile)await previewCtx.route("https://**/*",r=>r.abort());
   const preview=await page(previewCtx);await profile(preview,"Preview Customer");
   const beforeWrites=writes.length,link=preview.locator('[data-preview-bill="'+previewId+'"]');
   if(mobile)await link.click();else{await link.focus();await link.press("Enter");}
   await preview.locator("#cust-bill-preview-edit:not([hidden])").waitFor();
   check((mobile?"phone":"desktop")+" previews selected older invoice without leaving Customers",[(await preview.locator("#cust-bill-preview-title").innerText()).includes(previewNumber),(await preview.locator("#cust-bill-preview-body").innerText()).includes("Test medicine"),new URL(preview.url()).pathname,await preview.locator("#cust-profile-name").innerText()],[true,true,"/customers.html","Preview Customer"]);
   check("preview uses stored bill balance instead of current account balance",await preview.locator(".cust-preview-totals div").last().innerText(),"Balance due on this bill\n₹"+(mobile?"1900.00":"900.00"));
   check("preview performs no account writes",writes.length,beforeWrites);
   check("preview and edit action fit viewport",await preview.evaluate(()=>{const b=document.querySelector("#cust-bill-preview-edit").getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth;}),true);
   await preview.screenshot({path:path.join(require("node:os").tmpdir(),"medicine-customer-preview-"+(mobile?"phone":"desktop")+".png")});
   if(!mobile){
    await preview.locator("#cust-bill-preview-close").focus();await preview.keyboard.press("Tab");
    check("preview keyboard focus stays inside dialog",await preview.evaluate(()=>document.activeElement.id),"cust-bill-preview-edit");
    await preview.keyboard.press("Escape");await preview.locator("#cust-bill-preview").waitFor({state:"hidden"});
    check("closing preview restores focused bill and selected profile",[await link.evaluate(e=>e===document.activeElement),await preview.locator("#cust-profile-name").innerText()],[true,"Preview Customer"]);
    await link.click();await preview.locator("#cust-bill-preview-edit:not([hidden])").waitFor();
   }
   await preview.locator("#cust-bill-preview-edit").click();await preview.waitForFunction(id=>window.MedicineBilling?.snapshot().id===id,previewId);
   check("Edit loads selected bill with its saved receipt and previous balance",await preview.evaluate(()=>{const b=window.MedicineBilling.snapshot();return[b.id,b.previousBalance,b.received,b.items.length];}),[previewId,200,300,1]);
   if(mobile){
    await preview.locator(".phone-billed-item").click();await preview.locator("#phone-item-qty").fill("3");await preview.locator("#phone-save").click();
    await preview.locator("#phone-sale-screen:not([hidden])").waitFor();await preview.locator("#phone-save").click();
   }else{await preview.locator('#bill-items-tbody [data-col="qty"]').fill("2");await preview.locator("#save-bill-button").click();}
   await preview.waitForFunction(()=>!document.querySelector("#save-bill-button").disabled&&document.querySelector("#bill-save-status").classList.contains("is-ok"));
   const saved=await fixture.request("bills","GET",{query:{id:previewId}}),account=await fixture.customer("Preview Customer");
   check("editing preserves bill identity and receipts while recomputing balance",[saved.json.bill.bill_number,Number(saved.json.items[0].quantity),Number(saved.json.bill.amount_received),Number(account.balance)],[previewNumber,mobile?3:2,300,mobile?3200:2200]);
   const lastWrite=writes.filter(w=>w.endpoint==="bills").at(-1);
   check("editor updates original invoice with its version",[lastWrite.method,lastWrite.body.id,Number.isInteger(lastWrite.body.expectedVersion)],["PUT",previewId,true]);
   await preview.goto(base+"/customers.html");await profile(preview,"Preview Customer");
   check("customer history refreshes edited balance",await preview.locator("#cust-profile-balance").innerText(),mobile?"₹3200.00":"₹2200.00");
   await previewCtx.close();
  }
  check("edits do not create duplicate invoices",(await fixture.pg.query("SELECT count(*)::int AS n FROM public.bills WHERE customer_id=$1",[(await fixture.customer("Preview Customer")).id])).rows[0].n,2);
  const retryCtx=await context(),retryPreview=await page(retryCtx);await profile(retryPreview,"Preview Customer");
  await retryPreview.route("**/api/bills?id="+previewId,r=>r.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Offline fixture"})}));
  await retryPreview.locator('[data-preview-bill="'+previewId+'"]').click();await retryPreview.locator("#cust-bill-preview-retry").waitFor();
  check("failed preview stays on Customers and hides Edit",[new URL(retryPreview.url()).pathname,await retryPreview.locator("#cust-bill-preview-edit").isHidden(),(await retryPreview.locator("#cust-bill-preview-body").innerText()).includes("Offline fixture")],["/customers.html",true,true]);
  await retryPreview.unroute("**/api/bills?id="+previewId);await retryPreview.locator("#cust-bill-preview-retry").click();await retryPreview.locator("#cust-bill-preview-edit:not([hidden])").waitFor();
  check("failed preview can retry in place",(await retryPreview.locator("#cust-bill-preview-title").innerText()).includes(previewNumber),true);
  await retryPreview.locator("#cust-bill-preview-close").click();
  let releasePreview;const previewGate=new Promise(resolve=>{releasePreview=resolve;});
  await retryPreview.route("**/api/bills?id="+previewId,async r=>{await previewGate;await r.continue();});
  await retryPreview.locator('[data-preview-bill="'+previewId+'"]').click();await retryPreview.locator("#cust-bill-preview-close").click();
  const lateResponse=retryPreview.waitForResponse(r=>r.url().includes("/api/bills?id="+previewId));releasePreview();await lateResponse;
  check("late preview response cannot reopen a closed dialog",await retryPreview.locator("#cust-bill-preview").isHidden(),true);
  await retryCtx.close();
  const missingCtx=await context(),missing=await page(missingCtx);let missingAlert="";
  missing.removeAllListeners("dialog");missing.on("dialog",async d=>{missingAlert=d.message();await d.accept();});
  const missingDialog=missing.waitForEvent("dialog");
  await missing.goto(base+"/billing.html?viewBill=00000000-0000-4000-8000-000000000099");
  await missingDialog;
  await missing.waitForFunction(()=>window.MedicineBilling?.ready());
  check("unavailable invoice shows a clear error without opening an editor",[missingAlert.includes("Could not load bill"),await missing.locator("#receipt-modal").isHidden(),await missing.evaluate(()=>window.MedicineBilling.snapshot().id)],[true,true,null]);
  await missingCtx.close();
  check("no uncaught browser errors",errors,[]);console.log(checks+" customer browser/RPC assertions passed");
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));await fixture.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
