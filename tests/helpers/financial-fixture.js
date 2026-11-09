"use strict";
const fs=require("fs"),path=require("path"),Module=require("module"),{randomUUID}=require("crypto"),{PGlite}=require("@electric-sql/pglite");
const ROOT=path.resolve(__dirname,"../..");
async function createFixture(){
 const pg=new PGlite();
 await pg.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$; CREATE TABLE medicines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),medicine_name text,quantity numeric);");
 for(const n of ["supabase-rbac-setup.sql","add-billing-tables.sql","add-db-balances.sql","add-batch-expiry.sql"])await pg.exec(fs.readFileSync(path.join(ROOT,n),"utf8"));
 const migration=fs.readdirSync(path.join(ROOT,"supabase/migrations")).find(n=>n.endsWith("_atomic_billing_ledger.sql"));
 await pg.exec(fs.readFileSync(path.join(ROOT,"supabase/migrations",migration),"utf8"));
 let actor="admin@example.test";
 const real=require(path.join(ROOT,"lib/supabase-server"));
 const fake={...real,getServerConfig:()=>({enabled:true,projectUrl:"https://fixture.invalid",serviceRoleKey:"fixture"}),requireAuthContext:async()=>({user:{id:"fixture-admin",email:actor,role:"admin"}}),callSupabaseRest:async(_c,route,o={})=>{
  if(route==="rpc/billing_read")return(await pg.query("SELECT public.billing_read($1::jsonb) AS result",[JSON.stringify(o.body.p_request)])).rows[0].result;
  if(route==="rpc/billing_mutate")return(await pg.query("SELECT public.billing_mutate($1,$2::jsonb,$3) AS result",[o.body.p_action,JSON.stringify(o.body.p_data),o.body.p_actor])).rows[0].result;
  throw Error("Unexpected non-atomic fixture REST route: "+route);
 }};
 const old=Module._load,handlers={};Module._load=function(n){return /supabase-server$/.test(n)?fake:old.apply(this,arguments);};
 try{delete require.cache[require.resolve(path.join(ROOT,"lib/financial-ledger"))];for(const n of ["bills","customers","payments","import-bills"]){const p=path.join(ROOT,"api",n+".js");delete require.cache[require.resolve(p)];handlers[n]=require(p);}}finally{Module._load=old;}
 async function request(endpoint,method,{body=null,query={}}={}){let status=200,json;const res={get statusCode(){return status;},set statusCode(v){status=v;},setHeader(){},getHeader(){},end(s){json=JSON.parse(s||"{}");}};await handlers[endpoint]({method,body:body&&JSON.parse(JSON.stringify(body)),query,headers:{}},res);return{status,json};}
 async function customer(name){return(await pg.query("SELECT public.billing_customer(public.billing_find_customer(NULL,$1)) AS c",[name])).rows[0].c;}
 async function createCustomer(name,openingBalance=0){return request("customers","POST",{body:{name,openingBalance,operationId:randomUUID()}});}
 async function createBill(name,items,extra={}){const c=await customer(name),initial=extra.initialOpeningBalance??0,prev=c?c.balance:initial;return request("bills","POST",{body:{customerName:name,customerId:c?.id,previousBalance:prev,expectedBalance:prev,initialOpeningBalance:initial,items,amountReceived:0,operationId:randomUUID(),...extra}});}
 async function updateBill(id,extra={}){const r=await request("bills","GET",{query:{id}});if(r.status!==200)return r;const b=r.json.bill;return request("bills","PUT",{body:{id,customerId:b.customer_id,customerName:b.customer_name,customerPhone:b.customer_phone,notes:b.notes,previousBalance:b.previous_balance,amountReceived:b.amount_received,gstPercent:b.gst_percent,expectedUpdatedAt:b.updated_at,expectedVersion:b.version,operationId:randomUUID(),items:r.json.items.map(i=>({medicineId:i.medicine_id,medicineName:i.medicine_name,location:i.location,quantity:i.quantity,sellPrice:i.sell_price,mrp:i.mrp,purchasePrice:i.purchase_price,markupPercent:i.markup_percent,batchNo:i.batch_no,expiry:i.expiry})),...extra}});}
 async function reset(){await pg.exec("RESET ROLE; TRUNCATE public.bills,public.bill_items,public.payments,public.customers,public.billing_customer_aliases,public.billing_operations,public.billing_number_counters,public.billing_issued_numbers CASCADE;");}
 return{pg,request,customer,createCustomer,createBill,updateBill,reset,operationId:randomUUID,setActor(v){actor=v;},close:()=>pg.close()};
}
module.exports={createFixture};
