"use strict";
const {allowMethods,getServerConfig,parseJsonBody,requireAuthContext,sendJson}=require("../lib/supabase-server");
const ledger=require("../lib/financial-ledger");
function customerInput(body){
 ledger.object(body);
 if(body.restore!==undefined&&typeof body.restore!=="boolean")throw new ledger.FinancialInputError("restore must be true or false.");
 const data={...body,id:ledger.uuid(body.id,"Customer id"),name:ledger.text(body.name,"Customer name",120,true),originalName:ledger.text(body.originalName,"Original customer name",120),phone:ledger.text(body.phone,"Phone",40)};
 for(const k of ["openingBalance","balance","expectedBalance","expectedOpeningBalance"])if(body[k]!==undefined&&body[k]!==null)data[k]=ledger.decimal(body[k],k,2,{signed:true});
 if(body.expectedVersion!==undefined&&(!Number.isSafeInteger(Number(body.expectedVersion))||Number(body.expectedVersion)<0))throw new ledger.FinancialInputError("Invalid customer version.");
 return data;
}
module.exports=async(req,res)=>{
 if(!allowMethods(req,res,["GET","POST","PUT","DELETE"]))return;
 const config=getServerConfig();
 try{
  const auth=await requireAuthContext(req,res,config,{adminOnly:true});if(!auth)return;res.setHeader("Cache-Control","no-store");
  if(req.method==="GET")return sendJson(res,200,await ledger.read(config,{kind:"customers",customerId:ledger.uuid(req.query?.id,"Customer id"),includeArchived:req.query?.includeArchived==="1"}));
  if(req.method==="DELETE"){
   const data={id:ledger.uuid(req.query?.id,"Customer id"),name:ledger.text(req.query?.name,"Customer name",120),operationId:ledger.operationId(req.query?.operationId)};
   if(!data.id&&!data.name)throw new ledger.FinancialInputError("Customer id or name is required.");
   return sendJson(res,200,await ledger.mutate(config,"customer_archive",data,auth.user.email));
  }
  const body=ledger.object(await parseJsonBody(req));
  if(req.method==="PUT"){
   if(body.mode!=="reconcile")throw new ledger.FinancialInputError("Legacy balances must be reconciled with current activity. Reload this page before importing.","LEGACY_RECONCILIATION_REQUIRED",409);
   if(!Array.isArray(body.customers)||!body.customers.length||body.customers.length>5000)throw new ledger.FinancialInputError("Supply 1 to 5000 customer balances.");
   return sendJson(res,200,await ledger.mutate(config,"customers_reconcile",{customers:body.customers.map(customerInput),operationId:ledger.operationId(body.operationId)},auth.user.email));
  }
  const data=customerInput(body);data.operationId=ledger.operationId(body.operationId);
  return sendJson(res,200,await ledger.mutate(config,"customer_save",data,auth.user.email));
 }catch(error){return ledger.fail(res,error);}
};
