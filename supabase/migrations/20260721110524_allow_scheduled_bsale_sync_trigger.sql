ALTER TABLE integraciones.bsale_sync_runs
DROP CONSTRAINT IF EXISTS bsale_sync_runs_trigger_check;

ALTER TABLE integraciones.bsale_sync_runs
ADD CONSTRAINT bsale_sync_runs_trigger_check
CHECK (trigger IN ('INITIAL', 'CRON', 'NIGHTLY', 'MANUAL', 'SCHEDULED'));
