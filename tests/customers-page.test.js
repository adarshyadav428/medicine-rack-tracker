"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const source = fs.readFileSync(path.join(__dirname, "..", "customers.js"), "utf8");
const expose = source.replace(/\}\)\(\);\s*$/, [
  "globalThis.customerPage = { state:cState, el:cEl, selectedCustomer, refreshCustomers, openProfile, closeProfile, showEditForm, saveEdit, recordPayment, deletePayment, deleteCustomer, refreshSelectedProfile, offerLocalImport, initCustomersPage, cache:function(){return customerCache;} };",
  "})();"
].join("\n"));
assert.notEqual(expose, source, "expose the actual closure only inside the test VM");
class Element {
  constructor(id) {
    this.id=id; this.value=""; this.textContent=""; this.innerHTML=""; this.disabled=false;
    this.className=/edit-form|profile-content/.test(id)?"hidden":""; this.listeners=new Map();
    const el=this;
    this.classList={
      contains(c){return el.className.split(/\s+/).includes(c);},
      add(c){if(!this.contains(c))el.className=(el.className+" "+c).trim();},
      remove(c){el.className=el.className.split(/\s+/).filter(x=>x!==c).join(" ");},
      toggle(c,on){const yes=on===undefined?!this.contains(c):on;yes?this.add(c):this.remove(c);}
    };
  }
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(fn);}
  async emit(type,options={}){const event={preventDefault(){},...options};await Promise.all((this.listeners.get(type)||[]).map(fn=>fn.call(this,event)));}
  querySelectorAll(){return [];}
}
const copy=value=>JSON.parse(JSON.stringify(value)), key=value=>String(value||"").trim().toLowerCase();
const wait=()=>new Promise(resolve=>setImmediate(resolve));
async function drain(){for(let i=0;i<5;i++)await wait();}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
function customer(id,name,opening=0){return{id,name,phone:"111",openingBalance:opening,version:1,archived:false};}
function backend(initial){
 const db={customers:copy(initial),bills:[],payments:[]},calls=[],operations=new Map();let seq=0;
 const api={db,calls,hook:null,lostPaymentResponse:false};
 function account(c){
  return{...copy(c),balance:c.openingBalance+db.bills.filter(b=>b.customer_id===c.id).reduce((n,b)=>n+b.grand_total-b.amount_received,0)-db.payments.filter(p=>p.customer_id===c.id).reduce((n,p)=>n+p.amount,0)};
 }
 api.account=id=>account(db.customers.find(c=>c.id===id));
 api.addBill=(id,total,received=0,reference="B-"+(++seq))=>db.bills.push({id:"bill-"+(++seq),customer_id:id,customer_name:db.customers.find(c=>c.id===id).name,bill_number:reference,subtotal:total,gst_amount:0,grand_total:total,amount_received:received,created_at:"2026-11-08T04:00:00Z"});
 api.addPayment=(id,amount,note="")=>db.payments.push({id:"pay-"+(++seq),customer_id:id,customer_name:db.customers.find(c=>c.id===id).name,amount,note,created_at:"2026-11-08T05:00:00Z"});
 api.request=async(url,options={})=>{
  const u=new URL(url,"http://fixture"),method=options.method||"GET",body=copy(options.body||{}),call={path:u.pathname,query:Object.fromEntries(u.searchParams),method,body};calls.push(call);
  if(api.hook)await api.hook(call,"before");
  let result;const find=()=>db.customers.find(c=>c.id===(body.customer_id||body.id||u.searchParams.get("customerId")||u.searchParams.get("id")))||db.customers.find(c=>key(c.name)===key(body.originalName||body.customer_name||body.name||u.searchParams.get("customer")));
  if(u.pathname==="/api/customers"&&method==="GET")result={customers:db.customers.map(account).sort((a,b)=>a.name.localeCompare(b.name))};
  else if(u.pathname==="/api/bills"&&method==="GET"){const c=find();result={bills:c?copy(db.bills.filter(b=>b.customer_id===c.id)):[]};}
  else if(u.pathname==="/api/payments"&&method==="GET"){const c=find();result={payments:c?copy(db.payments.filter(p=>p.customer_id===c.id)):[]};}
  else if(u.pathname==="/api/payments"&&method==="POST"){
   assert.match(body.operationId,/^[0-9a-f-]{36}$/i);
   if(operations.has(body.operationId))result=copy(operations.get(body.operationId));
   else{const c=find();assert.ok(c);api.addPayment(c.id,body.amount,body.note);result={payment:copy(db.payments.at(-1)),customer:account(c)};operations.set(body.operationId,copy(result));}
   if(api.lostPaymentResponse){api.lostPaymentResponse=false;throw Error("Connection lost after commit");}
  }else if(u.pathname==="/api/customers"&&method==="POST"){
   const c=find();assert.ok(c);
   if(Object.hasOwn(body,"openingBalance")){assert.equal(body.expectedBalance,account(c).balance);assert.equal(body.expectedOpeningBalance,c.openingBalance);if(body.expectedVersion!=null)assert.equal(body.expectedVersion,c.version);c.openingBalance=body.openingBalance;}
   c.name=body.name;c.phone=body.phone;if(body.restore)c.archived=false;c.version++;result={customer:account(c)};
  }else if(u.pathname==="/api/payments"&&method==="DELETE"){
   const p=db.payments.find(p=>p.id===u.searchParams.get("id"));assert.ok(p);assert.equal(p.customer_id,u.searchParams.get("customerId"));db.payments=db.payments.filter(row=>row.id!==p.id);result={ok:true,customer:api.account(p.customer_id)};
  }else if(u.pathname==="/api/customers"&&method==="DELETE"){const c=find();c.archived=true;c.version++;result={ok:true,customer:account(c)};}
  else if(u.pathname==="/api/customers"&&method==="PUT"){
   assert.equal(body.mode,"reconcile");
   for(const entry of body.customers){const c=db.customers.find(c=>key(c.name)===key(entry.name));assert.ok(c);const current=account(c);assert.equal(entry.expectedBalance,current.balance);assert.equal(entry.expectedOpeningBalance,c.openingBalance);c.openingBalance=entry.balance-(current.balance-c.openingBalance);c.version++;}
   result={imported:body.customers.length};
  }else throw Error("Unsupported fixture operation "+method+" "+url);
  if(api.hook)await api.hook(call,"after",result);return result;
 };
 return api;
}
async function page(server,storage=new Map([["medicineRackTracker.balancesImported.v1","1"]])){
 const nodes=new Map(),events=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);};
 const localStorage={getItem(k){return storage.has(k)?storage.get(k):null;},setItem(k,v){storage.set(k,String(v));},removeItem(k){storage.delete(k);}};
 const context={document:{body:{dataset:{page:"customers"}},visibilityState:"visible",getElementById:node,addEventListener(t,f){events.set("document:"+t,f);}},window:{crypto:webcrypto,confirm(){return true;},addEventListener(t,f){events.set("window:"+t,f);}},localStorage,TextEncoder,Uint8Array,requestApi:server.request,isAdmin:()=>true,isAuthenticated:()=>true,console,setTimeout,clearTimeout};
 vm.runInNewContext(expose,context,{filename:"customers.js"});context.window.__onCustomersReady();await drain();
 return{api:context.customerPage,node,storage,events};
}
let assertions=0;
function check(label,actual,expected){assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected,label);assertions++;console.log("PASS "+label);}
async function select(p,id){await p.api.openProfile("id:"+id);}
async function pay(p,amount){p.node("cust-pay-amount").value=String(amount);await p.api.recordPayment();}
(async()=>{
 {
  const s=backend([customer("b","Bob",500),customer("c","Charlie",1000)]),p=await page(s);await select(p,"c");s.db.customers.push(customer("a","Aaron"));await pay(p,100);await pay(p,50);
  check("selection remains Charlie when refreshed list sorts differently",s.db.payments.map(x=>x.customer_id),["c","c"]);check("selected stable ID survives cache replacement",p.api.selectedCustomer().id,"c");
 }
 {
  const s=backend([customer("a","Alice"),customer("b","Bob")]);s.addPayment("a",100,"ALICE RECEIPT");s.addPayment("b",200,"BOB RECEIPT");
  const p=await page(s),reached=deferred(),release=deferred();s.hook=async c=>{if(c.path==="/api/payments"&&c.method==="GET"&&c.query.customerId==="a"){reached.resolve();await release.promise;}};
  const slow=p.api.openProfile("id:a");await reached.promise;await select(p,"b");release.resolve();await slow;s.hook=null;
  check("late Alice history does not replace Bob history",p.node("cust-bills-container").innerHTML.includes("ALICE RECEIPT"),false);check("current history still contains Bob receipt",p.node("cust-bills-container").innerHTML.includes("BOB RECEIPT"),true);
  const before=s.calls.filter(c=>c.method==="DELETE").length;await p.api.deletePayment(s.db.payments[0].id,100,p.api.cache().find(c=>c.id==="a"));check("stale history cannot delete another customer's receipt",s.calls.filter(c=>c.method==="DELETE").length,before);
 }
 {
  const s=backend([customer("a","Alice")]),p=await page(s);await select(p,"a");s.addBill("a",1000,300,"NEW BILL");await select(p,"a");
  check("reopening profile refreshes balance after external sale",p.api.selectedCustomer().balance,700);check("history refresh includes bill and counter receipt",[p.node("cust-bills-container").innerHTML.includes("NEW BILL"),p.node("cust-bills-container").innerHTML.includes("₹300.00"),p.node("cust-bills-container").innerHTML.includes("Received")],[true,true,true]);check("history is scoped by stable customer ID",s.calls.filter(c=>c.path==="/api/bills").every(c=>c.query.customerId==="a"),true);
 }
 {
  const s=backend([customer("a","Alice",1000)]),p=await page(s);await select(p,"a");p.api.showEditForm();p.node("cust-edit-phone-input").value="555";await pay(p,200);await p.api.saveEdit();
  const posted=s.calls.find(c=>c.path==="/api/customers"&&c.method==="POST");check("phone-only save never sends opening adjustment",Object.hasOwn(posted.body,"openingBalance"),false);check("phone-only save preserves receipt and anchor",[s.account("a").balance,s.account("a").openingBalance,s.account("a").phone],[800,1000,"555"]);check("metadata save targets original stable customer",[posted.body.id,posted.body.originalName],["a","Alice"]);
 }
 {
  const s=backend([customer("a","Alice",200)]);s.addBill("a",100,20);const p=await page(s);await select(p,"a");p.api.showEditForm();p.node("cust-edit-balance-input").value="250";await p.node("cust-edit-balance-input").emit("input");await p.api.saveEdit();
  const posted=s.calls.find(c=>c.path==="/api/customers"&&c.method==="POST").body;check("deliberate adjustment backs activity out",[posted.openingBalance,posted.expectedBalance,posted.expectedOpeningBalance,posted.expectedVersion],[170,280,200,1]);check("explicit adjustment reads back as requested balance",s.account("a").balance,250);
 }
 {
  const s=backend([customer("a","Alice",1000)]),p=await page(s);await select(p,"a");p.api.showEditForm();p.node("cust-edit-balance-input").value="0";await p.node("cust-edit-balance-input").emit("input");s.addPayment("a",200);await p.api.saveEdit();
  check("stale deliberate adjustment is rejected before POST",s.calls.some(c=>c.path==="/api/customers"&&c.method==="POST"),false);check("stale edit stays open with review message",[p.node("cust-edit-form").classList.contains("hidden"),p.node("cust-edit-status").textContent.includes("account changed")],[false,true]);
 }
 {
  const s=backend([customer("a","constructor",1000)]),p=await page(s);await select(p,"a");await pay(p,200);check("reserved customer name safely records payment",[s.db.payments.length,s.account("a").balance,p.node("cust-pay-status").textContent.includes("saved")],[1,800,true]);
 }
 {
  const s=backend([customer("a","Alice",1000)]),storage=new Map([["medicineRackTracker.balancesImported.v1","1"]]),p=await page(s,storage);await select(p,"a");s.lostPaymentResponse=true;await pay(p,200);
  const first=s.calls.find(c=>c.path==="/api/payments"&&c.method==="POST").body.operationId;check("uncertain response retains retry entry",[p.node("cust-pay-amount").value,p.node("cust-pay-status").textContent.includes("not confirmed")],["200",true]);
  s.db.customers[0].phone="777";s.db.customers[0].name="Alice Renamed";const p2=await page(s,storage);await select(p2,"a");await pay(p2,200);const posts=s.calls.filter(c=>c.path==="/api/payments"&&c.method==="POST");check("retry survives reload and contact rename with same operation ID",posts[1].body.operationId,first);check("retry records cash exactly once",[s.db.payments.length,s.account("a").balance],[1,800]);
 }
 {
  const s=backend([customer("a","Alice",1000),customer("b","Bob",2000)]),p=await page(s);await select(p,"a");s.lostPaymentResponse=true;await pay(p,200);
  const first=s.calls.find(c=>c.path==="/api/payments"&&c.method==="POST").body.operationId;await select(p,"b");await pay(p,100);await select(p,"a");await pay(p,200);
  const posts=s.calls.filter(c=>c.path==="/api/payments"&&c.method==="POST");check("unconfirmed Alice retry survives an intervening Bob payment",[posts[2].body.operationId,s.db.payments.length,s.account("a").balance,s.account("b").balance],[first,2,800,1900]);
 }
 {
  class StickyStorage extends Map{delete(){throw Error("Storage removal blocked");}}
  const s=backend([customer("a","Alice",1000)]),p=await page(s,new StickyStorage([["medicineRackTracker.balancesImported.v1","1"]]));await select(p,"a");await pay(p,200);await pay(p,200);check("failed storage cleanup cannot replay a later intentional equal receipt",[s.db.payments.length,s.account("a").balance],[2,600]);
 }
 {
  const s=backend([customer("a","Alice",1000)]),p=await page(s);await select(p,"a");s.hook=async c=>{if(c.path==="/api/payments"&&c.method==="GET")throw Error("History offline");};await pay(p,200);
  check("postcommit history failure still says payment saved",[s.db.payments.length,p.node("cust-pay-status").textContent.includes("was saved"),p.node("cust-pay-status").textContent.includes("not confirmed")],[1,true,false]);check("confirmed payment clears input despite refresh failure",p.node("cust-pay-amount").value,"");
 }
 {
  const s=backend([customer("a","Alice",1000),customer("b","Bob",2000)]),p=await page(s);await select(p,"a");const reached=deferred(),release=deferred();s.hook=async(c,phase)=>{if(phase==="after"&&c.path==="/api/payments"&&c.method==="POST"){reached.resolve();await release.promise;}};
  p.node("cust-pay-amount").value="200";const pending=p.api.recordPayment();await reached.promise;await select(p,"b");release.resolve();await pending;check("late Alice completion leaves Bob balance and name",[p.node("cust-profile-name").textContent,p.node("cust-profile-balance").textContent],["Bob","₹2000.00"]);
 }
 {
  const s=backend([customer("a","Alice",1000),customer("b","Bob",2000)]),p=await page(s);await select(p,"a");const reached=deferred(),release=deferred();s.hook=async(c,phase)=>{if(phase==="after"&&c.path==="/api/payments"&&c.method==="POST"){reached.resolve();await release.promise;}};
  p.node("cust-pay-amount").value="200";const pending=p.api.recordPayment();await reached.promise;await select(p,"b");s.addBill("a",300);await select(p,"a");release.resolve();await pending;check("A-B-A never installs old committed balance snapshot",p.node("cust-profile-balance").textContent,"₹1100.00");
 }
 {
  const s=backend([customer("a","Alice",1000)]),p=await page(s);await select(p,"a");p.api.showEditForm();p.node("cust-edit-phone-input").value="555";s.hook=async c=>{if(c.path==="/api/customers"&&c.method==="POST")throw Error("Save refused");};await p.api.saveEdit();check("failed metadata save preserves profile and edit form",[s.account("a").phone,p.node("cust-profile-phone").textContent,p.node("cust-edit-form").classList.contains("hidden")],["111","111",false]);
 }
 {
  const s=backend([customer("a","Alice",200)]);s.addBill("a",100);const p=await page(s);await select(p,"a");await p.api.deleteCustomer();check("archive preserves opening anchor and debt",[s.db.customers[0].archived,s.account("a").openingBalance,s.account("a").balance],[true,200,300]);p.node("cust-search").value="Alice";await p.node("cust-search").emit("input");check("archived account remains searchable",p.node("cust-list").innerHTML.includes("(archived)"),true);
  await select(p,"a");check("archived profile offers Restore and blocks new financial activity",[p.node("cust-delete-btn").textContent,p.node("cust-pay-btn").disabled,p.node("cust-edit-btn").disabled],["Restore",true,true]);await p.api.deleteCustomer();check("explicit restore preserves financial values and re-enables activity",[s.db.customers[0].archived,s.account("a").openingBalance,s.account("a").balance,p.node("cust-pay-btn").disabled],[false,200,300,false]);const restore=s.calls.find(c=>c.method==="POST"&&c.body.restore);check("restore never submits a financial anchor",Object.hasOwn(restore.body,"openingBalance"),false);
 }
 {
  const s=backend([customer("a","Alice")]);s.addBill("a",1000,200);const storage=new Map([["medicineRackTracker.customers.v1",JSON.stringify([{name:"Alice",balance:800}])]]);await page(s,storage);check("legacy balance explained by ledger is not added twice",[s.calls.some(c=>c.method==="PUT"),s.account("a").balance],[false,800]);
 }
 {
  const s=backend([customer("a","Alice")]);s.addBill("a",1000,200);const storage=new Map([["medicineRackTracker.customers.v1",JSON.stringify([{name:"Alice",balance:1000}])]]);await page(s,storage);await drain();const put=s.calls.find(c=>c.method==="PUT");check("legacy sends running balance and current guards",[put.body.mode,put.body.customers[0].balance,put.body.customers[0].expectedBalance,Object.hasOwn(put.body.customers[0],"openingBalance")],["reconcile",1000,800,false]);check("legacy reconciliation backs activity out",[s.account("a").openingBalance,s.account("a").balance],[200,1000]);
 }
 {
  const s=backend([customer("a","Alice")]),storage=new Map([["medicineRackTracker.customers.v1",JSON.stringify([{name:"Alice",balance:100},{name:"alice",balance:200}])]]);const p=await page(s,storage);check("conflicting legacy balances are retained for review without writes",[s.calls.some(c=>c.method==="PUT"),storage.has("medicineRackTracker.balancesImported.v1"),p.node("customers-status").textContent.includes("manual review")],[false,false,true]);
 }
 console.log(assertions+" customer-page assertions passed");
})().catch(error=>{console.error(error);process.exitCode=1;});
