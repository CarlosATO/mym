ALTER TABLE portal.audit_logs
    ADD COLUMN IF NOT EXISTS schema_name varchar(50) DEFAULT 'portal',
    ADD COLUMN IF NOT EXISTS module_code varchar(50) DEFAULT 'PORTAL',
    ADD COLUMN IF NOT EXISTS event_type varchar(100),
    ADD COLUMN IF NOT EXISTS severity varchar(20) DEFAULT 'INFO',
    ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS diff_data jsonb;

CREATE INDEX IF NOT EXISTS idx_audit_logs_module_date ON portal.audit_logs (module_code, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_schema_table ON portal.audit_logs (schema_name, table_name);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON portal.audit_logs (event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity ON portal.audit_logs (severity);

UPDATE portal.audit_logs SET schema_name = 'portal', module_code = 'PORTAL' WHERE schema_name IS NULL;

CREATE OR REPLACE FUNCTION public.get_audit_distinct_values(column_name text)
RETURNS TABLE (value text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY EXECUTE format('SELECT DISTINCT %I::text FROM portal.audit_logs WHERE %I IS NOT NULL ORDER BY 1', column_name, column_name);
END;
$$;

CREATE OR REPLACE FUNCTION portal.get_audit_distinct_values(column_name text)
RETURNS TABLE (value text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY EXECUTE format('SELECT DISTINCT %I::text FROM portal.audit_logs WHERE %I IS NOT NULL ORDER BY 1', column_name, column_name);
END;
$$;

CREATE OR REPLACE FUNCTION portal.audit_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_event_type varchar;
    v_severity varchar;
    v_module_code varchar;
BEGIN
    v_user_id := auth.uid();

    v_module_code := CASE upper(TG_TABLE_SCHEMA)
        WHEN 'PORTAL' THEN 'PORTAL'
        ELSE upper(TG_TABLE_SCHEMA)
    END;

    v_event_type := TG_TABLE_NAME || '_' || TG_OP;

    v_severity := CASE
        WHEN TG_TABLE_NAME IN ('users', 'roles', 'permissions', 'role_permissions', 'user_permissions') THEN 'CRITICAL'
        ELSE 'INFO'
    END;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO portal.audit_logs (table_name, record_id, action, new_data, performed_by, schema_name, module_code, event_type, severity)
        VALUES (TG_TABLE_NAME, NEW.id, 'INSERT', row_to_json(NEW)::jsonb, v_user_id, TG_TABLE_SCHEMA, v_module_code, v_event_type, v_severity);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO portal.audit_logs (table_name, record_id, action, old_data, new_data, performed_by, schema_name, module_code, event_type, severity)
        VALUES (TG_TABLE_NAME, NEW.id, 'UPDATE', row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb, v_user_id, TG_TABLE_SCHEMA, v_module_code, v_event_type, v_severity);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO portal.audit_logs (table_name, record_id, action, old_data, performed_by, schema_name, module_code, event_type, severity)
        VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', row_to_json(OLD)::jsonb, v_user_id, TG_TABLE_SCHEMA, v_module_code, v_event_type, v_severity);
        RETURN OLD;
    END IF;
END;
$$;
