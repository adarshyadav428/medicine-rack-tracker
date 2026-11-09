-- STAGED: apply after atomic_billing_ledger. No historical prices or totals are rewritten.
BEGIN;
ALTER TABLE public.bill_items ADD COLUMN IF NOT EXISTS bill_only boolean NOT NULL DEFAULT false;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.bill_items'::regclass AND conname='bill_only_unlinked') THEN
  ALTER TABLE public.bill_items ADD CONSTRAINT bill_only_unlinked CHECK(NOT bill_only OR medicine_id IS NULL);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.billing_price_read(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE k text:=p_request->>'kind'; cid uuid; result jsonb; legacy jsonb;
BEGIN
 IF k='capabilities' THEN RETURN jsonb_build_object('billOnly',true,'mrpScoped',true); END IF;
 cid:=public.billing_find_customer(nullif(p_request->>'customerId','')::uuid,p_request->>'customer');
 IF k='lastprices' THEN
  WITH ranked AS (
   SELECT lower(btrim(i.medicine_name)) name,lower(btrim(i.medicine_name))||chr(31)||coalesce((i.mrp*100)::bigint::text,'?') key,
    i.sell_price,i.markup_percent,row_number() OVER(PARTITION BY lower(btrim(i.medicine_name)),i.mrp ORDER BY b.created_at DESC,b.ledger_sequence DESC,i.sort_order DESC,i.id DESC) rn
   FROM public.bill_items i JOIN public.bills b ON b.id=i.bill_id WHERE b.customer_id=cid AND NOT i.bill_only AND btrim(i.medicine_name)<>''
  ), latest AS (SELECT *,count(*) OVER(PARTITION BY name) variants FROM ranked WHERE rn=1)
  SELECT coalesce(jsonb_object_agg(key,jsonb_build_object('sellPrice',sell_price,'markupPercent',markup_percent)),'{}'),
   coalesce(jsonb_object_agg(name,jsonb_build_object('sellPrice',sell_price,'markupPercent',markup_percent)) FILTER(WHERE variants=1),'{}') INTO result,legacy FROM latest;
  RETURN jsonb_build_object('priceMap',legacy,'priceMapByMrp',result,'mrpScoped',true);
 ELSIF k='soldcounts' THEN
  WITH ranked AS (
   SELECT lower(btrim(i.medicine_name)) name,lower(btrim(i.medicine_name))||chr(31)||coalesce((i.mrp*100)::bigint::text,'?') key,
    i.sell_price,b.created_at,count(*) OVER(PARTITION BY lower(btrim(i.medicine_name)),i.mrp) cnt,
    row_number() OVER(PARTITION BY lower(btrim(i.medicine_name)),i.mrp ORDER BY b.created_at DESC,b.ledger_sequence DESC,i.sort_order DESC,i.id DESC) rn
   FROM public.bill_items i JOIN public.bills b ON b.id=i.bill_id WHERE NOT i.bill_only AND btrim(i.medicine_name)<>''
  ), latest AS (SELECT *,count(*) OVER(PARTITION BY name) variants FROM ranked WHERE rn=1)
  SELECT coalesce(jsonb_object_agg(key,jsonb_build_object('count',cnt,'lastSellPrice',sell_price,'lastSoldAt',created_at)),'{}'),
   coalesce(jsonb_object_agg(name,jsonb_build_object('count',cnt,'lastSellPrice',sell_price,'lastSoldAt',created_at)) FILTER(WHERE variants=1),'{}') INTO result,legacy FROM latest;
  RETURN jsonb_build_object('counts',legacy,'countsByMrp',result,'mrpScoped',true,'scanned',(SELECT count(*) FROM public.bill_items),'truncated',false);
 ELSIF k='medicine_sales' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('billId',b.id,'billNumber',b.bill_number,'customerId',b.customer_id,'customerName',b.customer_name,'customerPhone',b.customer_phone,'soldAt',b.created_at,'quantity',i.quantity,'sellPrice',i.sell_price,'purchasePrice',i.purchase_price,'mrp',i.mrp,'batchNo',coalesce(i.batch_no,''),'expiry',coalesce(i.expiry,'')) ORDER BY b.created_at DESC,b.ledger_sequence DESC,i.sort_order,i.id),'[]') INTO result
  FROM public.bill_items i JOIN public.bills b ON b.id=i.bill_id WHERE lower(btrim(i.medicine_name))=lower(btrim(p_request->>'medicine')) AND NOT i.bill_only
   AND (NOT(p_request ? 'mrp') OR i.mrp IS NOT DISTINCT FROM (p_request->>'mrp')::numeric);
  RETURN jsonb_build_object('medicine',p_request->>'medicine','sales',result);
 END IF;
 RAISE EXCEPTION 'BILLING_INVALID: Unsupported price read';
END $$;
REVOKE ALL ON FUNCTION public.billing_price_read(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.billing_price_read(jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.billing_save_bill(d jsonb,actor text,editing boolean DEFAULT false,importing boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE b public.bills; oldcid uuid; cid uuid; n text; number text; issued timestamptz:=clock_timestamp();
 it jsonb; ordinal integer:=0; q numeric; price numeric; line numeric; v_subtotal numeric:=0; gst numeric; tax numeric; grand numeric; received numeric; previous numeric; current_balance numeric;
BEGIN
 IF jsonb_typeof(d->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'items') NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'BILLING_INVALID: Supply 1 to 5000 medicine lines'; END IF;
 FOR it IN SELECT value FROM jsonb_array_elements(d->'items') LOOP
  q:=public.billing_decimal(it->>'quantity',3,0.001,9999999.999); price:=public.billing_decimal(it->>'sellPrice',2,0,99999999.99);
  IF length(btrim(coalesce(it->>'medicineName',''))) NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'BILLING_INVALID: Medicine name required'; END IF;
  line:=round(q*price,2); IF line>99999999.99 THEN RAISE EXCEPTION 'BILLING_INVALID: Line total outside supported range'; END IF;
  v_subtotal:=v_subtotal+line;
 END LOOP;
 gst:=public.billing_decimal(coalesce(d->>'gstPercent','0'),2,0,100); tax:=round(v_subtotal*gst/100,2); grand:=ceil(v_subtotal+tax);
 IF grand>99999999.99 THEN RAISE EXCEPTION 'BILLING_INVALID: Bill total outside supported range'; END IF;
 received:=public.billing_decimal(coalesce(d->>'amountReceived','0'),2,0,99999999.99);
 IF importing AND nullif(d->>'date','') IS NOT NULL THEN issued:=(d->>'date')::date::timestamp AT TIME ZONE 'Asia/Kolkata'; END IF;
 number:=CASE WHEN importing THEN nullif(btrim(d->>'billNumber'),'') ELSE NULL END;
 IF number IS NOT NULL THEN
  SELECT * INTO b FROM public.bills WHERE bill_number=number;
  IF FOUND THEN
   IF b.grand_total<>grand OR b.amount_received<>received OR b.gst_percent<>gst
    OR b.customer_id IS DISTINCT FROM public.billing_find_customer(NULL,d->>'customerName')
    OR (SELECT count(*) FROM public.bill_items WHERE bill_id=b.id)<>jsonb_array_length(d->'items')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'items') WITH ORDINALITY x(v,pos)
      LEFT JOIN public.bill_items i ON i.bill_id=b.id AND i.sort_order=x.pos-1
      WHERE i.id IS NULL OR i.medicine_name<>x.v->>'medicineName' OR i.quantity<>(x.v->>'quantity')::numeric OR i.sell_price<>(x.v->>'sellPrice')::numeric)
   THEN RAISE EXCEPTION 'BILLING_CONFLICT: An existing invoice with this reference has different contents; review it before importing'; END IF;
   RETURN jsonb_build_object('status','skipped','bill',to_jsonb(b),'billNumber',number);
  END IF;
 END IF;
 IF editing THEN
  SELECT * INTO b FROM public.bills WHERE id=(d->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_NOT_FOUND: Bill does not exist'; END IF;
  IF nullif(d->>'expectedUpdatedAt','') IS NULL OR b.updated_at IS DISTINCT FROM (d->>'expectedUpdatedAt')::timestamptz THEN RAISE EXCEPTION 'BILLING_CONFLICT: This bill changed elsewhere; reload it before editing'; END IF;
  IF nullif(d->>'expectedVersion','') IS NULL OR b.version<>(d->>'expectedVersion')::bigint THEN RAISE EXCEPTION 'BILLING_CONFLICT: Bill version changed; reload it before editing'; END IF;
  IF EXISTS(SELECT 1 FROM public.bill_items WHERE bill_id=b.id AND bill_only) AND coalesce((d->>'billOnlySupported')::boolean,false)=false THEN
   RAISE EXCEPTION 'BILLING_CONFLICT: Reload the latest app before editing an invoice containing bill-only items';
  END IF;
  oldcid:=b.customer_id;
 END IF;
 cid:=public.billing_ensure_customer(d,actor); current_balance:=public.billing_balance(cid);
 IF cid IS NULL AND received<>grand THEN RAISE EXCEPTION 'BILLING_INVALID: Customer required for unpaid bills or credits'; END IF;
 IF editing THEN
  IF oldcid IS DISTINCT FROM cid THEN
   IF coalesce((d->>'confirmReassignment')::boolean,false)=false OR nullif(d->>'expectedBalance','') IS NULL OR current_balance<>(d->>'expectedBalance')::numeric THEN RAISE EXCEPTION 'BILLING_CONFLICT: Confirm reassignment against the new customer current balance'; END IF;
   previous:=current_balance;
  ELSE
   previous:=b.previous_balance;
   IF d ? 'previousBalance' AND previous IS DISTINCT FROM (d->>'previousBalance')::numeric THEN RAISE EXCEPTION 'BILLING_MANUAL_BALANCE_REQUIRES_ADJUSTMENT: Adjust the customer account or use Repair Balance instead of changing a saved receipt opening'; END IF;
  END IF;
 ELSIF importing THEN
  SELECT coalesce(c.opening_balance,0)+coalesce((SELECT sum(grand_total-amount_received) FROM public.bills WHERE customer_id=cid AND created_at<=issued),0)-coalesce((SELECT sum(amount) FROM public.payments WHERE customer_id=cid AND created_at<=issued),0)
   INTO previous FROM public.customers c WHERE c.id=cid;
  previous:=coalesce(previous,0);
  IF coalesce((d->>'previousBalance')::numeric,0)<>0 AND (d->>'previousBalance')::numeric<>previous THEN RAISE EXCEPTION 'BILLING_CONFLICT: Imported previous balance does not match known activity; reconcile the customer opening first'; END IF;
 ELSE
  IF cid IS NOT NULL AND (nullif(d->>'expectedBalance','') IS NULL OR current_balance IS DISTINCT FROM (d->>'expectedBalance')::numeric) THEN RAISE EXCEPTION 'BILLING_CONFLICT: Customer balance changed; refresh it and confirm the bill'; END IF;
  previous:=current_balance;
  IF d ? 'previousBalance' AND previous IS DISTINCT FROM (d->>'previousBalance')::numeric THEN RAISE EXCEPTION 'BILLING_MANUAL_BALANCE_REQUIRES_ADJUSTMENT: Save the account adjustment in Customers before creating this bill'; END IF;
 END IF;
 IF abs(previous)>99999999.99 OR abs(previous+grand-received)>99999999.99 THEN RAISE EXCEPTION 'BILLING_INVALID: Balance outside supported receipt range'; END IF;
 IF editing THEN
  UPDATE public.bills SET customer_id=cid,customer_name=CASE WHEN oldcid IS NOT DISTINCT FROM cid THEN b.customer_name ELSE coalesce(d->>'customerName','') END,
   customer_phone=coalesce(d->>'customerPhone',''),notes=coalesce(d->>'notes',''),subtotal=v_subtotal,gst_percent=gst,gst_amount=tax,grand_total=grand,
   previous_balance=previous,amount_received=received,balance_due=previous+grand-received,updated_at=clock_timestamp(),version=version+1
   WHERE id=b.id RETURNING * INTO b;
  DELETE FROM public.bill_items WHERE bill_id=b.id;
 ELSE
  IF number IS NULL THEN number:=public.billing_next_number(issued);
  ELSE
   INSERT INTO public.billing_issued_numbers(bill_number) VALUES(number) ON CONFLICT DO NOTHING;
   IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_CONFLICT: This invoice reference was previously issued or voided and cannot be reused'; END IF;
  END IF;
  INSERT INTO public.bills(customer_id,bill_number,customer_name,customer_phone,notes,subtotal,gst_percent,gst_amount,grand_total,previous_balance,amount_received,balance_due,created_by,created_at,updated_at)
   VALUES(cid,number,coalesce(d->>'customerName',''),coalesce(d->>'customerPhone',''),coalesce(d->>'notes',''),v_subtotal,gst,tax,grand,previous,received,previous+grand-received,actor,issued,clock_timestamp()) RETURNING * INTO b;
 END IF;
 FOR it IN SELECT value FROM jsonb_array_elements(d->'items') LOOP
  q:=public.billing_decimal(it->>'quantity',3,0.001,9999999.999); price:=public.billing_decimal(it->>'sellPrice',2,0,99999999.99);
  INSERT INTO public.bill_items(bill_id,medicine_id,medicine_name,location,batch_no,expiry,quantity,mrp,purchase_price,sell_price,markup_percent,line_total,sort_order,bill_only)
  VALUES(b.id,nullif(it->>'medicineId','')::uuid,btrim(it->>'medicineName'),coalesce(it->>'location',''),nullif(it->>'batchNo',''),nullif(it->>'expiry',''),q,
   CASE WHEN nullif(it->>'mrp','') IS NULL THEN NULL ELSE public.billing_decimal(it->>'mrp',2,0,99999999.99) END,
   CASE WHEN nullif(it->>'purchasePrice','') IS NULL THEN NULL ELSE public.billing_decimal(it->>'purchasePrice',2,0,99999999.99) END,
   price,CASE WHEN nullif(it->>'markupPercent','') IS NULL THEN NULL ELSE public.billing_decimal(it->>'markupPercent',2,-9999.99,9999.99) END,round(q*price,2),ordinal,coalesce((it->>'billOnly')::boolean,false));
  ordinal:=ordinal+1;
 END LOOP;
 PERFORM public.billing_touch_customer(cid); IF oldcid IS DISTINCT FROM cid THEN PERFORM public.billing_touch_customer(oldcid); END IF;
 RETURN jsonb_build_object('bill',to_jsonb(b),'billNumber',b.bill_number,'customer',public.billing_customer(cid),'status','ok');
END $$;


NOTIFY pgrst,'reload schema';
COMMIT;
