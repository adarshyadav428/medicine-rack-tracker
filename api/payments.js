"use strict";
const {allowMethods,getServerConfig,parseJsonBody,requireAuthContext,sendJson}=require("../lib/supabase-server");
const ledger=require("../lib/financial-ledger");
module.exports=async(req,res)=>{
 if(!allowMethods(req,res,["GET","POST","DELETE"]))return;
 const config=getServerConfig();
 try{
  const auth=await requireAuthContext(req,res,config,{adminOnly:true});if(!auth)return;
  res.setHeader("Cache-Control","no-store");
  if(req.method==="GET"){
   const customerId=ledger.uuid(req.query?.customerId||req.query?.customer_id,"Customer id"),customer=ledger.text(req.query?.customer,"Customer name",120);
   if(!customerId&&!customer)throw new ledger.FinancialInputError("Customer is required.");
   return sendJson(res,200,await ledger.read(config,{kind:"payments",customerId,customer}));
  }
  if(req.method==="DELETE"){
   const data={id:ledger.uuid(req.query?.id,"Payment id",false),customerId:ledger.uuid(req.query?.customerId,"Customer id"),operationId:ledger.operationId(req.query?.operationId)};
   if(!data.customerId)throw new ledger.FinancialInputError("Reload the customer before deleting a payment: customerId is required.","CUSTOMER_ID_REQUIRED",409);
   return sendJson(res,200,await ledger.mutate(config,"payment_delete",data,auth.user.email));
  }
  const body=ledger.object(await parseJsonBody(req)),amount=ledger.decimal(body.amount,"Payment amount");
  if(amount<=0)throw new ledger.FinancialInputError("Payment amount must be greater than zero.");
  const data={customerId:ledger.uuid(body.customer_id||body.customerId,"Customer id"),customerName:ledger.text(body.customer_name,"Customer name",120),customerPhone:ledger.text(body.customer_phone,"Customer phone",40),amount,note:ledger.text(body.note,"Payment note",1000),operationId:ledger.operationId(body.operationId)};
  if(!data.customerId&&!data.customerName)throw new ledger.FinancialInputError("Customer is required.");
  return sendJson(res,200,await ledger.mutate(config,"payment_create",data,auth.user.email));
 }catch(error){return ledger.fail(res,error);}
};
