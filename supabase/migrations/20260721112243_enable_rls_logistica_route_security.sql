ALTER TABLE logistica.sales_order_route_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.sales_order_preparation_route_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE logistica.sales_order_route_exceptions FROM anon;
REVOKE ALL ON TABLE logistica.sales_order_preparation_route_events FROM anon;

DROP POLICY IF EXISTS "sales_order_route_exceptions company select"
ON logistica.sales_order_route_exceptions;

CREATE POLICY "sales_order_route_exceptions company select"
ON logistica.sales_order_route_exceptions
FOR SELECT
TO authenticated
USING (
  core.has_company_access(auth.uid(), company_id)
);

DROP POLICY IF EXISTS "sales_order_preparation_route_events company select"
ON logistica.sales_order_preparation_route_events;

CREATE POLICY "sales_order_preparation_route_events company select"
ON logistica.sales_order_preparation_route_events
FOR SELECT
TO authenticated
USING (
  core.has_company_access(auth.uid(), company_id)
);

GRANT ALL ON TABLE logistica.sales_order_route_exceptions TO service_role;
GRANT ALL ON TABLE logistica.sales_order_preparation_route_events TO service_role;
