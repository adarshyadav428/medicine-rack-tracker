-- Atomic billing ledger. STAGED ONLY: review/reconcile existing data before rollout.
-- Apply after the repository's existing billing/RBAC/balance SQL scripts.
BEGIN;

CREATE TABLE IF NOT EXISTS public.payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_name text NOT NULL,
 customer_phone text, amount numeric(10,2) NOT NULL, note text,
 created_by text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
ALTER TABLE public.bills ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
ALTER TABLE public.bills ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE RESTRICT;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE RESTRICT;
ALTER TABLE public.bill_items ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
CREATE SEQUENCE IF NOT EXISTS public.billing_event_sequence;
ALTER TABLE public.bills ADD COLUMN IF NOT EXISTS ledger_sequence bigint NOT NULL DEFAULT nextval('public.billing_event_sequence');
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS ledger_sequence bigint NOT NULL DEFAULT nextval('public.billing_event_sequence');
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.bills WHERE grand_total<>ceil(grand_total) OR grand_total<0 OR amount_received<0 OR grand_total::text IN ('NaN','Infinity','-Infinity') OR amount_received::text IN ('NaN','Infinity','-Infinity'))
 OR EXISTS(SELECT 1 FROM public.payments WHERE amount<=0 OR amount::text IN ('NaN','Infinity','-Infinity'))
 OR EXISTS(SELECT 1 FROM public.customers WHERE opening_balance::text IN ('NaN','Infinity','-Infinity')) THEN
  RAISE EXCEPTION 'Existing fractional/invalid financial totals need reconciliation before this migration';
 END IF;
 IF EXISTS(SELECT 1 FROM public.customers WHERE name_key<>lower(btrim(name))) THEN
  RAISE EXCEPTION 'Existing customer identity keys need reconciliation before this migration';
 END IF;
 IF EXISTS(SELECT 1 FROM public.bills b LEFT JOIN LATERAL (
   SELECT count(*) n,sum(line_total) line_sum,bool_or(quantity<=0 OR sell_price<0 OR line_total<>round(quantity*sell_price,2) OR quantity::text='NaN' OR sell_price::text='NaN' OR line_total::text='NaN') invalid
   FROM public.bill_items i WHERE i.bill_id=b.id
  ) i ON true WHERE i.n=0 OR i.invalid OR b.subtotal<>i.line_sum OR b.gst_percent NOT BETWEEN 0 AND 100 OR b.gst_amount<>round(b.subtotal*b.gst_percent/100,2) OR b.grand_total<>ceil(b.subtotal+b.gst_amount)) THEN
  RAISE EXCEPTION 'Existing invoice/item discrepancies need reconciliation before this migration';
 END IF;
END $$;
-- This is a derived column only. Never change historic charges, receipts or opening anchors here.
UPDATE public.bills SET balance_due=previous_balance+grand_total-amount_received
 WHERE balance_due IS DISTINCT FROM previous_balance+grand_total-amount_received;

-- STABLE keeps every aggregate/branch in this read at the calling statement snapshot.
-- Arrays are returned as a single JSON value, so PostgREST row caps never truncate a bill or account.
CREATE OR REPLACE FUNCTION public.billing_read(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE k text:=p_request->>'kind'; cid uuid; scoped boolean; result jsonb; lim integer; n integer;
 term text:=lower(coalesce(p_request->>'search','')); from_at timestamptz; to_at timestamptz;
BEGIN
 cid:=public.billing_find_customer(nullif(coalesce(p_request->>'customerId',p_request->>'customer_id'),'')::uuid,p_request->>'customer');
 scoped:=nullif(coalesce(p_request->>'customerId',p_request->>'customer_id',p_request->>'customer'),'') IS NOT NULL;
 IF k='customers' THEN
  SELECT coalesce(jsonb_agg(public.billing_customer(c.id) ORDER BY lower(c.name),c.id),'[]') INTO result FROM public.customers c
   WHERE (cid IS NULL OR c.id=cid) AND (coalesce((p_request->>'includeArchived')::boolean,false) OR c.archived_at IS NULL);
  RETURN jsonb_build_object('customers',result);
 ELSIF k='bill' THEN
  SELECT to_jsonb(b) INTO result FROM public.bills b WHERE b.id=(p_request->>'id')::uuid;
  IF result IS NULL THEN RAISE EXCEPTION 'BILLING_NOT_FOUND: Bill not found'; END IF;
  RETURN jsonb_build_object('bill',result,'items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sort_order,i.created_at,i.id) FROM public.bill_items i WHERE i.bill_id=(p_request->>'id')::uuid),'[]'));
 ELSIF k='payments' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC,p.ledger_sequence DESC,p.id),'[]') INTO result FROM public.payments p WHERE p.customer_id=cid;
  RETURN jsonb_build_object('payments',result);
 ELSIF k='restore_customers' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'customer_name',c.name,'customer_phone',c.phone,'archived',c.archived_at IS NOT NULL) ORDER BY lower(c.name),c.id),'[]') INTO result
   FROM public.customers c WHERE EXISTS(SELECT 1 FROM public.bills b WHERE b.customer_id=c.id);
  RETURN jsonb_build_object('customers',result);
 ELSIF k='lastprices' THEN
  SELECT coalesce(jsonb_object_agg(s.key,jsonb_build_object('sellPrice',s.sell_price,'markupPercent',s.markup_percent)),'{}') INTO result FROM (
   SELECT DISTINCT ON(lower(btrim(i.medicine_name))) lower(btrim(i.medicine_name)) key,i.sell_price,i.markup_percent
   FROM public.bill_items i JOIN public.bills b ON b.id=i.bill_id WHERE b.customer_id=cid AND btrim(i.medicine_name)<>''
   ORDER BY lower(btrim(i.medicine_name)),b.created_at DESC,b.ledger_sequence DESC,i.sort_order DESC,i.id DESC
  )s;
  RETURN jsonb_build_object('priceMap',result);
 ELSIF k='soldcounts' THEN
  SELECT coalesce(jsonb_object_agg(s.key,jsonb_build_object('count',s.cnt,'lastSoldAt',s.created_at,'lastSellPrice',s.sell_price)),'{}') INTO result FROM (
   SELECT DISTINCT ON(lower(btrim(i.medicine_name))) lower(btrim(i.medicine_name)) key,count(*) OVER(PARTITION BY lower(btrim(i.medicine_name))) cnt,b.created_at,i.sell_price
   FROM public.bill_items i JOIN public.bills b ON b.id=i.bill_id WHERE btrim(coalesce(i.medicine_name,''))<>''
   ORDER BY lower(btrim(i.medicine_name)),b.created_at DESC,b.ledger_sequence DESC,i.sort_order DESC,i.id DESC
  )s;
  RETURN jsonb_build_object('counts',result,'scanned',(SELECT count(*) FROM public.bill_items),'truncated',false);
 ELSIF k='medicine_sales' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('billId',b.id,'billNumber',b.bill_number,'customerId',b.customer_id,'customerName',b.customer_name,'customerPhone',b.customer_phone,'soldAt',b.created_at,
   'quantity',i.quantity,'sellPrice',i.sell_price,'purchasePrice',i.purchase_price,'batchNo',coalesce(i.batch_no,''),'expiry',coalesce(i.expiry,'')) ORDER BY b.created_at DESC,b.ledger_sequence DESC,i.sort_order,i.id),'[]') INTO result
   FROM public.bill_items i JOIN public.bills b ON b.id=i.bill_id WHERE lower(btrim(i.medicine_name))=lower(btrim(p_request->>'medicine'));
  RETURN jsonb_build_object('medicine',p_request->>'medicine','sales',result);
 ELSIF k='bills' THEN
  IF nullif(p_request->>'from','') IS NOT NULL THEN from_at:=(p_request->>'from')::date::timestamp AT TIME ZONE 'Asia/Kolkata'; END IF;
  IF nullif(p_request->>'to','') IS NOT NULL THEN to_at:=((p_request->>'to')::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata'; END IF;
  lim:=CASE WHEN scoped OR p_request->>'all'='1' THEN 2147483646 WHEN term<>'' OR from_at IS NOT NULL OR to_at IS NOT NULL THEN 500 ELSE 100 END;
  SELECT coalesce(jsonb_agg(s.row ORDER BY CASE WHEN scoped THEN s.at END ASC,s.at DESC,CASE WHEN scoped THEN s.seq END ASC,s.seq DESC,s.id),'[]'),count(*) INTO result,n FROM (
   SELECT to_jsonb(b) row,b.created_at at,b.ledger_sequence seq,b.id FROM public.bills b LEFT JOIN public.customers c ON c.id=b.customer_id
   WHERE (NOT scoped OR b.customer_id=cid) AND (from_at IS NULL OR b.created_at>=from_at) AND (to_at IS NULL OR b.created_at<to_at)
    AND (term='' OR strpos(lower(b.bill_number||' '||b.customer_name||' '||b.customer_phone||' '||coalesce(c.name,'')),term)>0)
   ORDER BY CASE WHEN scoped THEN b.created_at END ASC,b.created_at DESC,CASE WHEN scoped THEN b.ledger_sequence END ASC,b.ledger_sequence DESC,b.id LIMIT lim+1
  )s;
  IF n>lim THEN result:=result- lim; END IF;
  RETURN jsonb_build_object('bills',result,'truncated',n>lim,'searched',term<>'' OR from_at IS NOT NULL OR to_at IS NOT NULL);
 END IF;
 RAISE EXCEPTION 'BILLING_INVALID: Unknown ledger read';
END $$;

-- Preserve implicit accounts and their activity; never invent an opening anchor.
INSERT INTO public.customers(name,name_key,phone,opening_balance,created_by)
SELECT min(name),key,'',0,'ledger-migration' FROM (
 SELECT btrim(customer_name) name,lower(btrim(customer_name)) key FROM public.bills WHERE customer_id IS NULL
 UNION ALL SELECT btrim(customer_name),lower(btrim(customer_name)) FROM public.payments WHERE customer_id IS NULL
) names WHERE key<>'' GROUP BY key ON CONFLICT(name_key) DO NOTHING;
UPDATE public.bills b SET customer_id=c.id FROM public.customers c
 WHERE b.customer_id IS NULL AND lower(btrim(b.customer_name))=c.name_key;
UPDATE public.payments p SET customer_id=c.id FROM public.customers c
 WHERE p.customer_id IS NULL AND lower(btrim(p.customer_name))=c.name_key;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.bills WHERE customer_id IS NULL AND (btrim(customer_name)<>'' OR grand_total<>amount_received))
 OR EXISTS(SELECT 1 FROM public.payments WHERE customer_id IS NULL) THEN
  RAISE EXCEPTION 'Unattributed financial records need reconciliation before this migration';
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS bills_customer_ledger_idx ON public.bills(customer_id,created_at,ledger_sequence);
CREATE INDEX IF NOT EXISTS payments_customer_ledger_idx ON public.payments(customer_id,created_at,ledger_sequence);
CREATE INDEX IF NOT EXISTS bill_items_bill_order_idx ON public.bill_items(bill_id,sort_order,id);
CREATE TABLE IF NOT EXISTS public.billing_customer_aliases (
 name_key text PRIMARY KEY, customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT
);
INSERT INTO public.billing_customer_aliases SELECT name_key,id FROM public.customers ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS billing_alias_customer_idx ON public.billing_customer_aliases(customer_id);
CREATE TABLE IF NOT EXISTS public.billing_operations (
 actor text NOT NULL, operation_id text NOT NULL, action text NOT NULL,
 request jsonb NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor,operation_id), UNIQUE(operation_id)
);
CREATE TABLE IF NOT EXISTS public.billing_number_counters (
 issue_date date PRIMARY KEY, last_number bigint NOT NULL CHECK(last_number>=0)
);
CREATE TABLE IF NOT EXISTS public.billing_issued_numbers (
 bill_number text PRIMARY KEY, issued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.billing_issued_numbers(bill_number) SELECT bill_number FROM public.bills ON CONFLICT DO NOTHING;
INSERT INTO public.billing_number_counters(issue_date,last_number)
SELECT to_date(substring(bill_number from 4 for 8),'YYYYMMDD'),max(substring(bill_number from 13)::bigint)
 FROM public.bills WHERE bill_number ~ '^AM-[0-9]{8}-[0-9]{1,12}$' GROUP BY 1
 ON CONFLICT(issue_date) DO UPDATE SET last_number=greatest(public.billing_number_counters.last_number,excluded.last_number);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_customer_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_issued_numbers ENABLE ROW LEVEL SECURITY;
-- Browser sessions must not bypass atomic writes, stale-write checks or replay keys.
REVOKE ALL ON public.bills,public.bill_items,public.customers,public.payments FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.billing_customer_aliases,public.billing_operations,public.billing_number_counters FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.billing_issued_numbers FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.bills,public.bill_items,public.customers,public.payments,public.billing_customer_aliases,public.billing_operations,public.billing_number_counters TO service_role;
GRANT ALL ON public.billing_issued_numbers TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.billing_event_sequence TO service_role;

CREATE OR REPLACE FUNCTION public.billing_decimal(v text,places integer,minimum numeric,maximum numeric)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE n numeric;
BEGIN
 IF v IS NULL OR v !~ ('^-?[0-9]+([.][0-9]{1,'||places||'})?$') THEN
  RAISE EXCEPTION 'BILLING_INVALID: Invalid decimal precision or value';
 END IF;
 n:=v::numeric;
 IF n<minimum OR n>maximum THEN RAISE EXCEPTION 'BILLING_INVALID: Financial value outside supported range'; END IF;
 RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.billing_balance(cid uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT coalesce((SELECT opening_balance FROM public.customers WHERE id=cid),0)
 +coalesce((SELECT sum(grand_total-amount_received) FROM public.bills WHERE customer_id=cid),0)
 -coalesce((SELECT sum(amount) FROM public.payments WHERE customer_id=cid),0)
$$;

CREATE OR REPLACE FUNCTION public.billing_customer(cid uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('id',c.id,'name',c.name,'phone',c.phone,'openingBalance',c.opening_balance,
 'balance',public.billing_balance(c.id),'version',c.version,'updatedAt',c.updated_at,
 'archived',c.archived_at IS NOT NULL,'billCount',(SELECT count(*) FROM public.bills WHERE customer_id=c.id),
 'totalBilled',coalesce((SELECT sum(grand_total) FROM public.bills WHERE customer_id=c.id),0),
 'totalReceived',coalesce((SELECT sum(amount_received) FROM public.bills WHERE customer_id=c.id),0),
 'paymentCount',(SELECT count(*) FROM public.payments WHERE customer_id=c.id),
 'totalPayments',coalesce((SELECT sum(amount) FROM public.payments WHERE customer_id=c.id),0))
 FROM public.customers c WHERE c.id=cid
$$;

CREATE OR REPLACE FUNCTION public.billing_find_customer(cid uuid,n text)
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT coalesce(cid,(SELECT customer_id FROM public.billing_customer_aliases WHERE name_key=lower(btrim(n))))
$$;

CREATE OR REPLACE FUNCTION public.billing_ensure_customer(d jsonb,actor text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE cid uuid; named uuid; n text:=btrim(coalesce(d->>'customerName','')); c public.customers;
BEGIN
 cid:=nullif(coalesce(d->>'customerId',d->>'customer_id'),'')::uuid;
 named:=public.billing_find_customer(NULL,n);
 IF cid IS NOT NULL AND named IS NOT NULL AND cid<>named THEN RAISE EXCEPTION 'BILLING_CONFLICT: Customer name and id do not identify the same account'; END IF;
 IF cid IS NOT NULL AND n<>'' AND named IS NULL THEN RAISE EXCEPTION 'BILLING_CONFLICT: Customer name does not match this account; reselect the customer or create a new account'; END IF;
 cid:=coalesce(cid,named);
 IF cid IS NULL THEN
  IF n='' THEN RETURN NULL; END IF;
  INSERT INTO public.customers(name,name_key,phone,opening_balance,created_by)
  VALUES(n,lower(n),coalesce(d->>'customerPhone',''),public.billing_decimal(coalesce(d->>'initialOpeningBalance','0'),2,-99999999.99,99999999.99),actor) RETURNING id INTO cid;
  INSERT INTO public.billing_customer_aliases VALUES(lower(n),cid);
 END IF;
 SELECT * INTO c FROM public.customers WHERE id=cid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_NOT_FOUND: Customer does not exist'; END IF;
 IF c.archived_at IS NOT NULL THEN RAISE EXCEPTION 'BILLING_ARCHIVED: Restore this archived customer before recording activity'; END IF;
 RETURN cid;
END $$;

CREATE OR REPLACE FUNCTION public.billing_touch_customer(cid uuid)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 UPDATE public.customers SET version=version+1,updated_at=clock_timestamp() WHERE id=cid
$$;

CREATE OR REPLACE FUNCTION public.billing_next_number(issued timestamptz)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE day date:=(issued AT TIME ZONE 'Asia/Kolkata')::date; n bigint; number text;
BEGIN
 LOOP
 INSERT INTO public.billing_number_counters(issue_date,last_number) VALUES(day,1)
 ON CONFLICT(issue_date) DO UPDATE SET last_number=public.billing_number_counters.last_number+1 RETURNING last_number INTO n;
 number:='AM-'||to_char(day,'YYYYMMDD')||'-'||lpad(n::text,greatest(3,length(n::text)),'0');
 INSERT INTO public.billing_issued_numbers(bill_number) VALUES(number) ON CONFLICT DO NOTHING;
 IF FOUND THEN RETURN number; END IF;
 END LOOP;
END $$;

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
  INSERT INTO public.bill_items(bill_id,medicine_id,medicine_name,location,batch_no,expiry,quantity,mrp,purchase_price,sell_price,markup_percent,line_total,sort_order)
  VALUES(b.id,nullif(it->>'medicineId','')::uuid,btrim(it->>'medicineName'),coalesce(it->>'location',''),nullif(it->>'batchNo',''),nullif(it->>'expiry',''),q,
   CASE WHEN nullif(it->>'mrp','') IS NULL THEN NULL ELSE public.billing_decimal(it->>'mrp',2,0,99999999.99) END,
   CASE WHEN nullif(it->>'purchasePrice','') IS NULL THEN NULL ELSE public.billing_decimal(it->>'purchasePrice',2,0,99999999.99) END,
   price,CASE WHEN nullif(it->>'markupPercent','') IS NULL THEN NULL ELSE public.billing_decimal(it->>'markupPercent',2,-9999.99,9999.99) END,round(q*price,2),ordinal);
  ordinal:=ordinal+1;
 END LOOP;
 PERFORM public.billing_touch_customer(cid); IF oldcid IS DISTINCT FROM cid THEN PERFORM public.billing_touch_customer(oldcid); END IF;
 RETURN jsonb_build_object('bill',to_jsonb(b),'billNumber',b.bill_number,'customer',public.billing_customer(cid),'status','ok');
END $$;

CREATE OR REPLACE FUNCTION public.billing_mutate(p_action text,p_data jsonb,p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE op public.billing_operations; key text:=p_data->>'operationId'; result jsonb; c jsonb; cid uuid;
 b public.bills; p public.payments; row jsonb; entries jsonb:='[]'; count_done integer:=0; skipped integer:=0;
 event record; running numeric; changed integer:=0;
BEGIN
 IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 320 OR key IS NULL OR key !~ '^[A-Za-z0-9._:-]{8,128}$' THEN RAISE EXCEPTION 'BILLING_INVALID: Actor and operationId required'; END IF;
 -- One shop-level transactional lock also makes balance preconditions and invoice issuance coherent.
 PERFORM pg_advisory_xact_lock(782013641992::bigint);
 -- Replay precedes stale version/balance checks: an uncertain commit can be retried safely.
 SELECT * INTO op FROM public.billing_operations WHERE operation_id=key;
 IF FOUND THEN
  IF op.actor<>p_actor THEN RAISE EXCEPTION 'BILLING_OPERATION_REUSED: This operation was recorded by another administrator; review the receipt before retrying'; END IF;
  IF op.action IS DISTINCT FROM p_action OR op.request IS DISTINCT FROM p_data THEN RAISE EXCEPTION 'BILLING_OPERATION_REUSED: This operationId was already used for a different request'; END IF;
  -- Keep the original transaction/receipt, but do not present an old account
  -- snapshot as today's balance if the retry follows later activity.
  result:=op.response||jsonb_build_object('replayed',true);
  IF nullif(op.response->'customer'->>'id','') IS NOT NULL THEN
   result:=result||jsonb_build_object('customer',public.billing_customer((op.response->'customer'->>'id')::uuid));
  END IF;
  IF jsonb_typeof(op.response->'customers')='array' THEN
   SELECT coalesce(jsonb_agg(public.billing_customer((v->>'id')::uuid)),'[]') INTO entries FROM jsonb_array_elements(op.response->'customers') v;
   result:=result||jsonb_build_object('customers',entries);
  END IF;
  RETURN result;
 END IF;
 IF p_action IN ('bill_create','bill_update') THEN
  result:=public.billing_save_bill(p_data,p_actor,p_action='bill_update',false);
 ELSIF p_action='bill_delete' THEN
  SELECT * INTO b FROM public.bills WHERE id=(p_data->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_NOT_FOUND: Bill does not exist'; END IF;
  IF nullif(p_data->>'expectedUpdatedAt','') IS NULL OR b.updated_at IS DISTINCT FROM (p_data->>'expectedUpdatedAt')::timestamptz THEN RAISE EXCEPTION 'BILLING_CONFLICT: This bill changed; reload it before deleting'; END IF;
  IF nullif(p_data->>'expectedVersion','') IS NULL OR b.version<>(p_data->>'expectedVersion')::bigint THEN RAISE EXCEPTION 'BILLING_CONFLICT: Bill version changed; reload it before deleting'; END IF;
  row:=to_jsonb(b)||jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY sort_order,id) FROM public.bill_items i WHERE bill_id=b.id),'[]'));
  DELETE FROM public.bills WHERE id=b.id; PERFORM public.billing_touch_customer(b.customer_id);
  result:=jsonb_build_object('ok',true,'deletedBill',row,'customer',public.billing_customer(b.customer_id));
 ELSIF p_action='payment_create' THEN
  cid:=public.billing_ensure_customer(p_data,p_actor);
  IF cid IS NULL THEN RAISE EXCEPTION 'BILLING_INVALID: Customer required for a payment'; END IF;
  INSERT INTO public.payments(customer_id,customer_name,customer_phone,amount,note,created_by)
   SELECT cid,c.name,c.phone,public.billing_decimal(p_data->>'amount',2,0.01,99999999.99),nullif(p_data->>'note',''),p_actor FROM public.customers c WHERE c.id=cid RETURNING * INTO p;
  PERFORM public.billing_touch_customer(cid);
  result:=jsonb_build_object('payment',to_jsonb(p),'customer',public.billing_customer(cid));
 ELSIF p_action='payment_delete' THEN
  SELECT * INTO p FROM public.payments WHERE id=(p_data->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_NOT_FOUND: Payment does not exist'; END IF;
  IF p.customer_id IS DISTINCT FROM nullif(p_data->>'customerId','')::uuid THEN RAISE EXCEPTION 'BILLING_CONFLICT: This payment does not belong to the displayed customer'; END IF;
  DELETE FROM public.payments WHERE id=p.id; PERFORM public.billing_touch_customer(p.customer_id);
  result:=jsonb_build_object('ok',true,'payment',to_jsonb(p),'customer',public.billing_customer(p.customer_id));
 ELSIF p_action='customer_save' THEN
  result:=jsonb_build_object('customer',public.billing_save_customer(p_data,p_actor,false));
 ELSIF p_action='customer_archive' THEN
  cid:=public.billing_find_customer(nullif(p_data->>'id','')::uuid,p_data->>'name');
  UPDATE public.customers SET archived_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=cid;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_NOT_FOUND: Customer does not exist'; END IF;
  result:=jsonb_build_object('ok',true,'customer',public.billing_customer(cid));
 ELSIF p_action='customers_reconcile' THEN
  IF jsonb_typeof(p_data->'customers') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'customers') NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'BILLING_INVALID: Customer balances required'; END IF;
  FOR row IN SELECT value FROM jsonb_array_elements(p_data->'customers') LOOP
   c:=public.billing_save_customer(row,p_actor,true); entries:=entries||jsonb_build_array(c); count_done:=count_done+1;
  END LOOP;
  result:=jsonb_build_object('ok',true,'imported',count_done,'customers',entries);
 ELSIF p_action='import_bills' THEN
  IF jsonb_typeof(p_data->'bills') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'bills') NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'BILLING_INVALID: Import bills required'; END IF;
  FOR row IN SELECT value FROM jsonb_array_elements(p_data->'bills') LOOP
   c:=public.billing_save_bill(row,p_actor,false,true);
   IF c->>'status'='skipped' THEN skipped:=skipped+1; ELSE count_done:=count_done+1; END IF;
   entries:=entries||jsonb_build_array(jsonb_build_object('bill_number',c->>'billNumber','status',c->>'status'));
  END LOOP;
  result:=jsonb_build_object('ok',count_done,'skipped',skipped,'errors',0,'results',entries);
 ELSIF p_action='repair' THEN
  cid:=public.billing_find_customer(nullif(p_data->>'customerId','')::uuid,p_data->>'customerName');
  SELECT opening_balance INTO running FROM public.customers WHERE id=cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_NOT_FOUND: Customer not found'; END IF;
  FOR event IN SELECT * FROM (
   SELECT id,created_at,ledger_sequence,'bill' kind,grand_total amount,amount_received received FROM public.bills WHERE customer_id=cid
   UNION ALL SELECT id,created_at,ledger_sequence,'payment',amount,0 FROM public.payments WHERE customer_id=cid
  ) e ORDER BY created_at,ledger_sequence,id LOOP
   IF event.kind='payment' THEN running:=running-event.amount;
   ELSE
    UPDATE public.bills SET previous_balance=running,balance_due=running+event.amount-event.received,updated_at=clock_timestamp(),version=version+1 WHERE id=event.id;
    running:=running+event.amount-event.received; changed:=changed+1;
   END IF;
  END LOOP;
  PERFORM public.billing_touch_customer(cid);
  result:=jsonb_build_object('ok',true,'updated',changed,'customer',public.billing_customer(cid));
 ELSE RAISE EXCEPTION 'BILLING_INVALID: Unknown financial mutation';
 END IF;
 INSERT INTO public.billing_operations(actor,operation_id,action,request,response) VALUES(p_actor,key,p_action,p_data,result);
 RETURN result;
END $$;


CREATE OR REPLACE FUNCTION public.billing_save_customer(d jsonb,actor text,reconciling boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE cid uuid; c public.customers; n text:=btrim(coalesce(d->>'name','')); old_balance numeric; opening numeric; fresh boolean:=false;
BEGIN
 IF length(n) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'BILLING_INVALID: Customer name required'; END IF;
 cid:=public.billing_find_customer(nullif(d->>'id','')::uuid,coalesce(nullif(d->>'originalName',''),n));
 IF cid IS NULL THEN
  INSERT INTO public.customers(name,name_key,phone,opening_balance,created_by) VALUES(n,lower(n),coalesce(d->>'phone',''),0,actor) RETURNING id INTO cid;
  INSERT INTO public.billing_customer_aliases VALUES(lower(n),cid); fresh:=true;
 END IF;
 SELECT * INTO c FROM public.customers WHERE id=cid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_NOT_FOUND: Customer not found'; END IF;
 IF c.archived_at IS NOT NULL AND NOT coalesce((d->>'restore')::boolean,false) THEN RAISE EXCEPTION 'BILLING_ARCHIVED: This account is archived; explicitly restore it first'; END IF;
 old_balance:=public.billing_balance(cid); opening:=c.opening_balance;
 IF NOT fresh AND d ? 'expectedVersion' AND c.version<>(d->>'expectedVersion')::bigint THEN RAISE EXCEPTION 'BILLING_CONFLICT: Customer changed elsewhere; reload before saving'; END IF;
 IF d ? 'openingBalance' OR reconciling THEN
  IF NOT fresh AND (NOT d ? 'expectedBalance' OR NOT d ? 'expectedOpeningBalance' OR NOT d ? 'expectedVersion'
   OR old_balance IS DISTINCT FROM (d->>'expectedBalance')::numeric OR c.opening_balance IS DISTINCT FROM (d->>'expectedOpeningBalance')::numeric)
  THEN RAISE EXCEPTION 'BILLING_CONFLICT: Balance changed; reload the complete account before adjusting its opening'; END IF;
  IF reconciling THEN
   IF c.opening_balance<>0 THEN RAISE EXCEPTION 'BILLING_CONFLICT: An opening anchor already exists; review it before importing a legacy balance'; END IF;
   opening:=public.billing_decimal(d->>'balance',2,-99999999.99,99999999.99)-(old_balance-c.opening_balance);
  ELSE opening:=public.billing_decimal(d->>'openingBalance',2,-99999999.99,99999999.99);
  END IF;
  IF abs(opening)>99999999.99 THEN RAISE EXCEPTION 'BILLING_INVALID: Opening balance outside supported range'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.billing_customer_aliases WHERE name_key=lower(n) AND customer_id<>cid) THEN RAISE EXCEPTION 'BILLING_CONFLICT: This name belongs to another account'; END IF;
 INSERT INTO public.billing_customer_aliases VALUES(lower(n),cid) ON CONFLICT DO NOTHING;
 UPDATE public.customers SET name=n,name_key=lower(n),phone=coalesce(d->>'phone',phone),opening_balance=opening,
  archived_at=CASE WHEN coalesce((d->>'restore')::boolean,false) THEN NULL ELSE archived_at END,version=version+1,updated_at=clock_timestamp() WHERE id=cid;
 RETURN public.billing_customer(cid);
END $$;

-- Helpers and RPCs are backend-only; authenticated clients use the checked API.
REVOKE ALL ON FUNCTION public.billing_decimal(text,integer,numeric,numeric),public.billing_balance(uuid),public.billing_customer(uuid),public.billing_find_customer(uuid,text),public.billing_ensure_customer(jsonb,text),public.billing_touch_customer(uuid),public.billing_next_number(timestamptz),public.billing_save_bill(jsonb,text,boolean,boolean),public.billing_save_customer(jsonb,text,boolean),public.billing_read(jsonb),public.billing_mutate(text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.billing_decimal(text,integer,numeric,numeric),public.billing_balance(uuid),public.billing_customer(uuid),public.billing_find_customer(uuid,text),public.billing_ensure_customer(jsonb,text),public.billing_touch_customer(uuid),public.billing_next_number(timestamptz),public.billing_save_bill(jsonb,text,boolean,boolean),public.billing_save_customer(jsonb,text,boolean),public.billing_read(jsonb),public.billing_mutate(text,jsonb,text) TO service_role;
COMMIT;
