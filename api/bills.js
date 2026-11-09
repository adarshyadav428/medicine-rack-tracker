"use strict";
const { allowMethods, getServerConfig, parseJsonBody, requireAuthContext, sendJson } = require("../lib/supabase-server");
const ledger = require("../lib/financial-ledger");
module.exports = async (req, res) => {
 if (!allowMethods(req,res,["GET","POST","PUT","DELETE"])) return;
 const config=getServerConfig();
 try {
  const auth=await requireAuthContext(req,res,config,{adminOnly:true});if(!auth)return;
  res.setHeader("Cache-Control","no-store");
  if(req.method==="GET"){
   const q=req.query||{},query={...q,customerId:ledger.uuid(q.customerId||q.customer_id,"Customer id")};
   if(q.id)query.id=ledger.uuid(q.id,"Bill id",false);
   if(q.from)query.from=ledger.date(q.from,"From date");if(q.to)query.to=ledger.date(q.to,"To date");
   if(query.from&&query.to&&query.from>query.to)throw new ledger.FinancialInputError("From date must not be after To date.");
   query.customer=ledger.text(q.customer,"Customer",120);query.medicine=ledger.text(q.medicine,"Medicine",240);query.search=ledger.text(q.search,"Search",200);
   if(q.mrp!==undefined)query.mrp=q.mrp==="unknown"?null:ledger.decimal(q.mrp,"MRP");
   const kind=query.id?"bill":query.medicine?"medicine_sales":q.lastprices==="1"?"lastprices":q.soldcounts==="1"?"soldcounts":q.customers==="1"?"restore_customers":"bills";
   if(kind==="lastprices"&&!query.customer&&!query.customerId)throw new ledger.FinancialInputError("Customer is required for last prices.");
   return sendJson(res,200,await ledger.read(config,{...query,kind}));
  }
  if(req.method==="DELETE"){
   const data={id:ledger.uuid(req.query?.id,"Bill id",false),operationId:ledger.operationId(req.query?.operationId)};
   if(req.query?.expectedUpdatedAt)data.expectedUpdatedAt=req.query.expectedUpdatedAt;
   data.expectedVersion=Number(req.query?.expectedVersion);
   if(!Number.isSafeInteger(data.expectedVersion)||data.expectedVersion<1)throw new ledger.FinancialInputError("Reload the bill before deleting it: its expectedVersion is required.","BILL_VERSION_REQUIRED",409);
   return sendJson(res,200,await ledger.mutate(config,"bill_delete",data,auth.user.email));
  }
  const body=ledger.object(await parseJsonBody(req));
  if(req.method==="PUT"&&(body.repairCustomerId||body.repairCustomerName)){
   const data={operationId:ledger.operationId(body.operationId),customerId:ledger.uuid(body.repairCustomerId,"Customer id"),customerName:ledger.text(body.repairCustomerName,"Customer name",120)};
   return sendJson(res,200,await ledger.mutate(config,"repair",data,auth.user.email));
  }
  if(body.ledgerUpdates)throw new ledger.FinancialInputError("Reload this page: client-supplied ledger repair amounts are no longer accepted.","UNSAFE_LEDGER_REPAIR",409);
  const data=ledger.validateBill({...body,id:body.id||req.query?.id},req.method==="PUT");
  return sendJson(res,200,await ledger.mutate(config,req.method==="POST"?"bill_create":"bill_update",data,auth.user.email));
 }catch(error){return ledger.fail(res,error);}
};
