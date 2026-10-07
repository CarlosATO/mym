-- Finance API runtime may read the CxC snapshot tables only.
-- Company isolation remains enforced by the private runtime query contract:
-- every snapshot query must bind and filter the requested company_id.

CREATE POLICY bsale_receivable_snapshot_runs_runtime_select
  ON integraciones.bsale_receivable_snapshot_runs
  FOR SELECT
  TO petgroup_backend_runtime
  USING (true);

CREATE POLICY bsale_receivable_snapshot_clients_runtime_select
  ON integraciones.bsale_receivable_snapshot_clients
  FOR SELECT
  TO petgroup_backend_runtime
  USING (true);

CREATE POLICY bsale_receivable_snapshot_documents_runtime_select
  ON integraciones.bsale_receivable_snapshot_documents
  FOR SELECT
  TO petgroup_backend_runtime
  USING (true);
