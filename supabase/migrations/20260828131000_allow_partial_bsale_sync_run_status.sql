ALTER TABLE integraciones.bsale_sync_runs
DROP CONSTRAINT IF EXISTS bsale_sync_runs_status_check;

ALTER TABLE integraciones.bsale_sync_runs
ADD CONSTRAINT bsale_sync_runs_status_check
CHECK (status IN ('STARTED', 'COMPLETED', 'PARTIAL', 'FAILED'));
