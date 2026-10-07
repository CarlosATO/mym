-- Finance API reads only the latest completed CxC snapshot.
GRANT SELECT ON integraciones.bsale_receivable_snapshot_runs,
                       integraciones.bsale_receivable_snapshot_clients,
                       integraciones.bsale_receivable_snapshot_documents
  TO petgroup_backend_runtime;
