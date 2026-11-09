"use strict";
const {allowMethods,getServerConfig,parseJsonBody,requireAuthContext,sendJson}=require("../lib/supabase-server");
const ledger=require("../lib/financial-ledger");
function importDate(value){
 if(value===undefined||value===null||value==="")return null;
 let s=ledger.text(value,"Import date",10,true);
 if(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)){const [d,m,y]=s.split("/");s=y+"-"+m.padStart(2,"0")+"-"+d.padStart(2,"0");}
 return ledger.date(s,"Import date");
}
module.exports=async(req,res)=>{
 if(!allowMethods(req,res,["POST"]))return;
 const config=getServerConfig();
 try{
  const auth=await requireAuthContext(req,res,config,{adminOnly:true});if(!auth)return;res.setHeader("Cache-Control","no-store");
  const body=ledger.object(await parseJsonBody(req)),op=ledger.operationId(body.operationId);
  if(!Array.isArray(body.rows)||!body.rows.length||body.rows.length>10000)throw new ledger.FinancialInputError("Supply 1 to 10000 import lines.");
  const groups=[],seen=new Map();
  for(const row of body.rows){
   if(!row||typeof row!=="object"||Array.isArray(row))throw new ledger.FinancialInputError("Each import line must be an object.");
   const billNumber=ledger.text(row.bill_number,"Bill number",80),key=billNumber||"unidentified-"+groups.length;
   let group=seen.get(key);
   const metadata={customerName:ledger.text(row.customer_name,"Customer name",120),customerPhone:ledger.text(row.customer_phone,"Customer phone",40),notes:ledger.text(row.notes,"Notes",4000),date:importDate(row.date),gstPercent:ledger.decimal(row.gst_percent??0,"GST percentage",2,{max:100}),amountReceived:ledger.decimal(row.amount_received??0,"Amount received"),previousBalance:ledger.decimal(row.previous_balance??0,"Previous balance",2,{signed:true})};
   if(!group){group={...metadata,billNumber,items:[],operationId:op};seen.set(key,group);groups.push(group);}
   else for(const k of Object.keys(metadata))if(row[{customerName:"customer_name",customerPhone:"customer_phone",gstPercent:"gst_percent",amountReceived:"amount_received",previousBalance:"previous_balance"}[k]||k]!==undefined&&row[{customerName:"customer_name",customerPhone:"customer_phone",gstPercent:"gst_percent",amountReceived:"amount_received",previousBalance:"previous_balance"}[k]||k]!==""&&metadata[k]!==group[k])throw new ledger.FinancialInputError("Conflicting "+k+" in bill "+billNumber+".");
   group.items.push({medicineName:row.medicine_name,location:row.location,quantity:row.quantity??1,sellPrice:row.sell_price??0,mrp:row.mrp,purchasePrice:row.purchase_price,batchNo:row.batch_no,expiry:row.expiry});
  }
  const bills=groups.map(g=>({...ledger.validateBill(g),billNumber:g.billNumber,date:g.date}));
  return sendJson(res,200,await ledger.mutate(config,"import_bills",{bills,operationId:op},auth.user.email));
 }catch(error){return ledger.fail(res,error);}
};
