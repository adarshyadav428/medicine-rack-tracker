"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {createFixture}=require("./helpers/financial-fixture");
let checks=0;function check(label,a,b){assert.deepEqual(a,b,label);checks++;console.log("PASS "+label);}
(async()=>{
 const f=await createFixture();try{
  await f.createCustomer("Alice");await f.createCustomer("Bob");
  for(const [customer,mrp,rate]of [["Alice",154,70],["Alice",164,80],["Bob",154,75],["Bob",183,90]]){
   const r=await f.createBill(customer,[{medicineName:"Neeri Syp 100ml",mrp,quantity:1,sellPrice:rate}]);assert.equal(r.status,200);
  }
  const key=m=>"neeri syp 100ml\u001f"+m*100;
  const own=(await f.request("bills","GET",{query:{lastprices:"1",customer:"Alice"}})).json;
  check("customer history separates each recorded MRP",[own.priceMapByMrp[key(154)].sellPrice,own.priceMapByMrp[key(164)].sellPrice],[70,80]);
  check("other MRP does not inherit the customer's last price",own.priceMapByMrp[key(183)],undefined);
  const all=(await f.request("bills","GET",{query:{soldcounts:"1"}})).json;
  check("overall last sale is scoped to MRP",[154,164,183].map(m=>all.countsByMrp[key(m)].lastSellPrice),[75,80,90]);
  check("legacy name-only references are omitted for ambiguous variants",all.counts["neeri syp 100ml"],undefined);
  const history=(await f.request("bills","GET",{query:{medicine:"Neeri Syp 100ml",mrp:"154"}})).json.sales;
  check("sales viewer filters to the selected MRP",history.map(s=>[s.mrp,s.sellPrice]),[[154,75],[154,70]]);
  const unknown=(await f.request("bills","GET",{query:{medicine:"Neeri Syp 100ml",mrp:"unknown"}})).json.sales;
  check("missing MRP never borrows known-MRP history",unknown,[]);
  const before=await f.customer("Alice");
  const manual=await f.createBill("Alice",[{medicineName:"One-off medicine",mrp:100,quantity:2,sellPrice:40,purchasePrice:50,markupPercent:-20,billOnly:true}]);
  check("bill-only line saves through the transactional API",manual.status,200);
  let loaded=await f.request("bills","GET",{query:{id:manual.json.bill.id}});
  check("bill-only marker and purchase reference persist",[loaded.json.items[0].bill_only,Number(loaded.json.items[0].purchase_price)],[true,50]);
  check("manual line remains part of invoice and customer due",Number((await f.customer("Alice")).balance)-Number(before.balance),80);
  check("manual add creates no inventory entry",(await f.pg.query("SELECT count(*)::int n FROM medicines")).rows[0].n,0);
  await f.updateBill(manual.json.bill.id,{notes:"Contact note"});
  loaded=await f.request("bills","GET",{query:{id:manual.json.bill.id}});
  check("editing invoice retains bill-only exclusion",loaded.json.items[0].bill_only,true);
  const older=await f.updateBill(manual.json.bill.id,{billOnlySupported:false});
  check("older app cannot erase profit exclusion while resaving",older.status,409);
  const rates=(await f.request("bills","GET",{query:{soldcounts:"1"}})).json;
  check("bill-only entries do not pollute inventory rate suggestions",Object.keys(rates.countsByMrp).some(k=>k.startsWith("one-off medicine")),false);
  const invalid=await f.createBill("Alice",[{medicineId:"00000000-0000-4000-8000-000000000001",medicineName:"Wrong",quantity:1,sellPrice:1,billOnly:true}]);
  check("API rejects a bill-only line linked to inventory",invalid.status,400);
  const src=fs.readFileSync(path.join(__dirname,"../api/profit.js"),"utf8");
  const aggregate=new Function("round2",src.slice(src.indexOf("function aggregate("),src.indexOf("module.exports ="))+";return aggregate;")(n=>Math.round(n*100)/100);
  const profit=aggregate([{id:"bill",customer_name:"Alice",bill_number:"T",created_at:"2026-11-09"}], [
   {bill_id:"bill",medicine_name:"Tracked",quantity:1,sell_price:100,purchase_price:80},
   {bill_id:"bill",medicine_name:"Manual",quantity:2,sell_price:40,purchase_price:50,bill_only:true}
  ]);
  check("profit totals exclude every bill-only amount",profit.summary,{revenue:100,cost:80,profit:20,margin:20});
  check("profit breakdowns exclude bill-only medicines",profit.byMedicine.map(m=>m.name),["Tracked"]);
  const migration=path.join(__dirname,"../supabase/migrations/20261109084506_mrp_variant_pricing_bill_only.sql");await f.pg.exec(fs.readFileSync(migration,"utf8"));
  check("migration can be rerun without changing manual charges",Number((await f.customer("Alice")).balance)-Number(before.balance),80);
  await f.pg.exec("SET ROLE authenticated");await assert.rejects(f.pg.query("SELECT public.billing_price_read('{}')"),/permission denied/);await f.pg.exec("RESET ROLE");console.log("PASS browser role cannot execute variant pricing RPC");checks++;
 }finally{await f.close();}
 const old=await createFixture({features:false});try{
  const result=await old.createBill("Manual",[{medicineName:"Manual",quantity:1,sellPrice:10,billOnly:true}]);
  check("unupgraded database refuses bill-only save instead of losing exclusion",[result.status,result.json.code],[503,"FINANCIAL_SCHEMA_REQUIRED"]);
  check("missing-upgrade rejection creates no invoice",(await old.pg.query("SELECT count(*)::int n FROM bills")).rows[0].n,0);
  const imported=await old.request("import-bills","POST",{body:{operationId:old.operationId(),rows:[{bill_number:"MANUAL-IMPORT",customer_name:"Manual",medicine_name:"One-off",quantity:1,sell_price:10,bill_only:"true"}]}});
  check("bill-only imports also require the persistence upgrade",[imported.status,imported.json.code],[503,"FINANCIAL_SCHEMA_REQUIRED"]);
 }finally{await old.close();}
 console.log(checks+" MRP/bill-only checks passed");
})().catch(e=>{console.error(e);process.exitCode=1;});
