// Full phone billing flow against a local fixture API; never writes live data.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict'),os=require('os');
const qaDir=path.join(os.tmpdir(),'medicine-mobile-qa');
fs.mkdirSync(qaDir,{recursive:true});
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..'), bills=[],writes=[];
const customers=[{id:'ankit',name:'Ankit Gupta',phone:'9876543210',openingBalance:125}];
let writeVersion=0;
function customerBalances(){
 return customers.map(c=>({...c,balance:Math.round((c.openingBalance+bills.filter(b=>b.customer_id===c.id).reduce((s,b)=>s+b.grand_total-b.amount_received,0))*100)/100}));
}
const medicines=[{id:'tone450',medicineName:'U TONE 450ML',location:'A1',quantity:100,mrp:220,purchasePrice:140,sellPrice:179.6},{id:'ghrit',medicineName:'Ghrit Kumari 200ml',quantity:100,mrp:200,purchasePrice:130,sellPrice:177.23},{id:'tone900',medicineName:'U TONE 900ML',quantity:100,mrp:400,purchasePrice:210,sellPrice:280}];
let failSave=false;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let data={};
 if(url.pathname.startsWith('/api/')){
  if(url.pathname==='/api/supabase-config')data={enabled:true,backendManaged:true};
  else if(url.pathname.startsWith('/api/auth/'))data={authenticated:true,user:{email:'qa@example.test',role:'admin'}};
  else if(url.pathname==='/api/medicines')data={items:medicines};
  else if(url.pathname==='/api/customers')data={customers:customerBalances()};
  else if(url.pathname==='/api/payments')data={payments:[]};
  else if(url.pathname==='/api/bills'){
   if(req.method==='POST'||req.method==='PUT'){
    let raw='';for await(const chunk of req)raw+=chunk;
    const payload=JSON.parse(raw);if(payload.ledgerUpdates){data={ok:true};}
    else if(failSave){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Test connection failure'}));return;}
    else{
     let bill=payload.id&&bills.find(x=>x.id===payload.id);
     if(bill&&(payload.expectedUpdatedAt!==bill.updated_at||payload.expectedVersion!==bill.version)){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Bill changed since it was loaded.'}));return;}
     writes.push(payload);
     let customer=customers.find(c=>c.id===payload.customerId||c.name.toLowerCase()===payload.customerName.toLowerCase());
     if(!customer){customer={id:'customer-'+(customers.length+1),name:payload.customerName,phone:payload.customerPhone,openingBalance:payload.initialOpeningBalance||0};customers.push(customer);}
     if(!bill){bill={id:'bill-'+(bills.length+1),bill_number:'AM-QA-'+(bills.length+1),created_at:'2026-10-31T10:00:00Z',created_by:'qa@example.test'};bills.push(bill);}
     const subtotal=payload.items.reduce((s,x)=>s+Math.round(x.quantity*x.sellPrice*100)/100,0),gst=Math.round(subtotal*payload.gstPercent)/100,total=Math.ceil(subtotal+gst);
     Object.assign(bill,{customer_id:customer.id,customer_name:payload.customerName,customer_phone:payload.customerPhone,notes:payload.notes,subtotal,gst_amount:gst,grand_total:total,gst_percent:payload.gstPercent,previous_balance:payload.previousBalance,amount_received:payload.amountReceived,balance_due:payload.previousBalance+total-payload.amountReceived,version:(bill.version||0)+1,updated_at:new Date(Date.parse('2026-10-31T10:00:00Z')+(++writeVersion)*1000).toISOString(),items:payload.items.map(x=>({...x,medicine_name:x.medicineName,sell_price:x.sellPrice,purchase_price:x.purchasePrice,medicine_id:x.medicineId}))});
     data={bill,billNumber:bill.bill_number};
    }
   }else if(url.searchParams.has('soldcounts'))data={counts:{},countsByMrp:{},mrpScoped:true};
   else if(url.searchParams.has('lastprices'))data={priceMap:{'u tone 450ml':{sellPrice:179.6}},priceMapByMrp:{['u tone 450ml'+String.fromCharCode(31)+'22000']:{sellPrice:179.6}},mrpScoped:true};
   else if(url.searchParams.has('id')){const bill=bills.find(x=>x.id===url.searchParams.get('id'));data={bill,items:bill?bill.items:[]};}
   else data={bills};
  }
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
 }
 const filename=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
 if(!filename.startsWith(root+path.sep)||!fs.existsSync(filename)){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.webmanifest':'application/manifest+json'})[path.extname(filename)]||'text/plain');res.end(fs.readFileSync(filename));
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,headless:true});
 const errors=[];let page;
 try{
  page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
  page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
  await page.route('https://**/*',route=>/fonts\.(googleapis|gstatic)\.com/.test(route.request().url())?route.continue():route.abort());
  await page.goto(base+'/billing.html');
  await page.waitForFunction(()=>document.body.classList.contains('phone-billing-active'));
  assert.equal(await page.evaluate(()=>window.scrollY),0,'phone opens at the top without focusing hidden desktop search');
  assert.equal(await page.locator('main.page-shell').isVisible(),false);
  await page.locator('#phone-saved-customer').selectOption('ankit');
  assert.match(await page.locator('#phone-saved-customer option:checked').innerText(),/Ankit Gupta.*125/);
  await page.waitForFunction(()=>document.querySelector('#phone-party-balance').textContent==='₹125.00');
  assert.equal(await page.locator('#phone-customer-phone').inputValue(),'9876543210');
  await page.locator('#phone-saved-customer').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(qaDir,'customer-selection.png')});
  await page.locator('[data-payment="cash"]').tap();
  await page.locator('#phone-add-items').tap();
  await page.locator('#phone-item-search').fill('u');
  assert.equal(await page.locator('.phone-search-item').count(),3);
  assert.match(await page.locator('[data-medicine="tone450"]').textContent(),/Rack: A1/);
  await page.screenshot({path:path.join(qaDir,'medicine-search.png')});
  await page.locator('[data-medicine="tone450"]').tap();
  assert.equal(await page.locator('#phone-item-rate').inputValue(),'179.6');
  assert.equal(await page.locator('#phone-item-location').textContent(),'Rack: A1');
  assert.equal(await page.locator('#phone-item-qty').evaluate(x=>document.activeElement===x),true);
  await page.locator('#phone-item-qty').fill('5');
  assert.equal(await page.locator('#phone-item-subtotal').textContent(),'₹898.00');
  await page.screenshot({path:path.join(qaDir,'item-entry.png')});
  await page.locator('#phone-save').tap();
  assert.equal(await page.locator('#phone-search-screen').isVisible(),true);
  await page.locator('#phone-item-search').fill('ghrit');
  await page.locator('[data-medicine="ghrit"]').tap();
  await page.locator('#phone-save-new').tap();
  assert.equal(await page.locator('.phone-billed-item').count(),2);
  assert.equal(await page.locator('#phone-total').textContent(),'₹1076.00');
  assert.equal(await page.locator('#phone-received').inputValue(),'1076');
  assert.equal(await page.locator('#phone-balance').textContent(),'₹125.00');
  await page.locator('[data-row]').first().tap();
  await page.locator('#phone-item-qty').fill('99');
  await page.locator('#phone-back').tap();
  assert.equal(await page.evaluate(()=>window.MedicineBilling.snapshot().items[0].quantity),5);
  await page.locator('[data-row]').first().tap();
  await page.locator('.phone-item-details summary').tap();
  await page.locator('#phone-item-markup').fill('10');
  assert.equal(await page.locator('#phone-item-rate').inputValue(),'154');
  await page.locator('#phone-item-qty').fill('0');
  await page.locator('#phone-save').tap();
  assert.equal(await page.locator('#phone-item-screen').isVisible(),true);
  assert.match(await page.locator('#phone-item-error').textContent(),/quantity above zero/);
  await page.locator('#phone-back').tap();
  const layouts=[];
  for(const width of [320,375,390,430,844]){
   await page.setViewportSize({width,height:844});
   const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,phone:document.body.classList.contains('phone-billing-active'),footer:document.querySelector('.phone-sale-footer').getBoundingClientRect().bottom}));
   assert.ok(layout.scroll<=width,JSON.stringify(layout));assert.ok(layout.phone);layouts.push(layout);
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#phone-billed-items').evaluate(x=>x.scrollIntoView({block:'center'}));
  await page.screenshot({path:path.join(qaDir,'sale-summary.png')});
  failSave=true;
  await page.locator('#phone-save-new').tap();
  await page.waitForFunction(()=>document.querySelector('#phone-save-status').textContent.includes('Test connection failure'));
  assert.equal(await page.locator('.phone-billed-item').count(),2);
  failSave=false;
  await page.locator('#phone-save').tap();
  await page.waitForFunction(()=>document.querySelector('#phone-save-status').textContent.includes('saved successfully'));
  assert.equal(writes[0].amountReceived,1076);assert.equal(writes[0].previousBalance,125);
  assert.equal(writes[0].items.length,2);assert.equal(writes[0].items[0].quantity,5);
  await page.locator('#phone-back').tap();await page.locator('#phone-history').tap();
  await page.locator('[data-edit-bill]').first().tap();
  await page.waitForFunction(()=>document.querySelector('#phone-sale-screen').hidden===false);
  assert.equal(await page.locator('.phone-billed-item').count(),2);
  await page.locator('#phone-save-new').tap();
  await page.waitForFunction(()=>document.querySelector('#phone-customer').value==='');
  assert.equal(await page.locator('.phone-billed-item').count(),0);
  assert.equal(await page.locator('#phone-received').inputValue(),'0');
  // Cash/credit does not erase a partial amount after an unrelated redraw.
  await page.locator('#phone-customer').fill('Next Customer');await page.locator('#phone-add-items').tap();
  await page.locator('#phone-item-search').fill('ghrit');await page.locator('[data-medicine="ghrit"]').tap();await page.locator('#phone-save-new').tap();
  await page.locator('[data-payment="credit"]').tap();assert.equal(await page.locator('#phone-received').inputValue(),'0');
  await page.locator('#phone-received').fill('50');
  await page.locator('#phone-tax-input').fill('5');
  assert.equal(await page.locator('#phone-received').inputValue(),'50');
  await page.locator('[data-row]').tap();await page.locator('#phone-remove-item').tap();
  assert.equal(await page.locator('.phone-billed-item').count(),0);
  // Explicit desktop received edits survive a responsive layout transition.
  // The old phone cash lock overwrote 20 with the full total on return.
  await page.locator('#phone-add-items').tap();await page.locator('#phone-item-search').fill('ghrit');
  await page.locator('[data-medicine="ghrit"]').tap();await page.locator('#phone-save-new').tap();
  await page.locator('[data-payment="cash"]').tap();
  await page.setViewportSize({width:1200,height:844});
  await page.waitForFunction(()=>!document.body.classList.contains('phone-billing-active'));
  await page.locator('#bill-received-amount').fill('20');
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.body.classList.contains('phone-billing-active'));
  assert.equal(await page.locator('#phone-received').inputValue(),'20');
  await page.locator('#phone-save').tap();
  await page.waitForFunction(()=>document.querySelector('#phone-save-status').textContent.includes('saved successfully'));
  assert.equal(writes[writes.length-1].amountReceived,20);
  // Paid-in-full still follows an explicit tax change, without render-time writes.
  await page.locator('[data-payment="cash"]').tap();await page.locator('#phone-tax-input').fill('10');
  const changedTotal=await page.evaluate(()=>window.MedicineBilling.snapshot().totalAmount);
  await page.waitForFunction(total=>Number(document.querySelector('#phone-received').value)===total,changedTotal);
  assert.equal(Number(await page.locator('#phone-received').inputValue()),changedTotal);
  const desktop=await browser.newPage({viewport:{width:1160,height:900}});desktop.on('pageerror',e=>errors.push(e.message));await desktop.route('https://**/*',route=>route.abort());
  await desktop.goto(base+'/billing.html');await desktop.locator('#billing-search').waitFor({state:'visible'});
  assert.equal(await desktop.locator('#phone-billing').isVisible(),false);
  await desktop.locator('#billing-search').fill('ghrit');await desktop.locator('.medicine-dropdown-item').first().click();
  assert.equal(await desktop.locator('#bill-items-tbody tr').evaluate(x=>getComputedStyle(x).display),'table-row');
  await desktop.setViewportSize({width:390,height:844});assert.equal(await desktop.locator('#phone-billing').isVisible(),false);
  await desktop.emulateMedia({media:'print'});assert.equal(await desktop.locator('#phone-billing').isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,writes:writes.length,layouts,phoneFlows:['saved customer balance and phone','one-letter search','item Save & New','item draft cancellation','invalid quantity rejected','cash payment follows total','failed bill save retains items','save and history edit','bill Save & New clears after success','credit and partial payments','remove item','responsive payment edits preserved','cash follows explicit tax changes'],desktopUnchanged:true,errors},null,2));
 }catch(error){console.error('FAILED STEP',error.stack);if(page){console.log('PAGE',page.url());console.log('BROWSER ERRORS',errors);}throw error;}
 finally{await browser.close();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
