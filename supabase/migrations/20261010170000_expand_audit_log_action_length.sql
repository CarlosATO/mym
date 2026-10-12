-- Allow descriptive audit actions such as CONFIRM_CLASSIFICATION without
-- changing existing values, nullability, indexes, or other audit columns.
ALTER TABLE portal.audit_logs
  ALTER COLUMN action TYPE varchar(64);
