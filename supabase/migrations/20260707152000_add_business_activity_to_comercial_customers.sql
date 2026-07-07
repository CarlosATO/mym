alter table comercial.customers
add column if not exists business_activity text null;

create index if not exists idx_comercial_customers_business_activity
on comercial.customers using gin (to_tsvector('simple', coalesce(business_activity, '')));

update comercial.customers c
set business_activity = b.activity
from integraciones.bsale_clients b
where c.company_id = b.company_id
  and c.bsale_client_id = b.bsale_client_id
  and c.source = 'BSALE'
  and c.business_activity is null
  and b.activity is not null;

