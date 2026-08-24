-- COMV2-13A prerequisite: line_locks has no updated_at column.
-- Remove the generic trigger created by the foundation loop so status
-- transitions can update the lock's own released_at/consumed_at timestamps.

DROP TRIGGER IF EXISTS trg_comisiones_line_locks_updated_at ON comisiones.line_locks;
