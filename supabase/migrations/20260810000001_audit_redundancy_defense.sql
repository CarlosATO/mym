-- Gate 3: Defensa Anti-Auditoría Redundante

CREATE OR REPLACE FUNCTION adquisiciones.trg_products_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_severity varchar;
BEGIN
    v_user_id := auth.uid();
    v_severity := CASE
        WHEN NEW.status IN ('INACTIVE', 'BLOCKED', 'DISCONTINUED') OR (OLD IS NOT NULL AND OLD.status IN ('INACTIVE', 'BLOCKED', 'DISCONTINUED')) THEN 'CRITICAL'
        ELSE 'INFO'
    END;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, NEW.id, 'INSERT', row_to_json(NEW)::jsonb, v_user_id, 'products_INSERT', 'INFO');
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        -- Defensive check for redundant updates
        IF (row_to_json(NEW)::jsonb - 'updated_at' - 'last_bsale_sync_at') = 
           (row_to_json(OLD)::jsonb - 'updated_at' - 'last_bsale_sync_at') THEN
            RETURN NEW;
        END IF;

        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, new_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, NEW.id, 'UPDATE', row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb, v_user_id, 'products_UPDATE', v_severity);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, OLD.id, 'DELETE', row_to_json(OLD)::jsonb, v_user_id, 'products_DELETE', 'CRITICAL');
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION adquisiciones.trg_suppliers_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_severity varchar;
BEGIN
    v_user_id := auth.uid();
    v_severity := CASE
        WHEN NEW.status IN ('INACTIVE', 'BLOCKED') OR (OLD IS NOT NULL AND OLD.status IN ('INACTIVE', 'BLOCKED')) THEN 'CRITICAL'
        ELSE 'INFO'
    END;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, NEW.id, 'INSERT', row_to_json(NEW)::jsonb, v_user_id, 'suppliers_INSERT', 'INFO');
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        -- Defensive check for redundant updates
        IF (row_to_json(NEW)::jsonb - 'updated_at' - 'last_bsale_sync_at') = 
           (row_to_json(OLD)::jsonb - 'updated_at' - 'last_bsale_sync_at') THEN
            RETURN NEW;
        END IF;

        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, new_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, NEW.id, 'UPDATE', row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb, v_user_id, 'suppliers_UPDATE', v_severity);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, OLD.id, 'DELETE', row_to_json(OLD)::jsonb, v_user_id, 'suppliers_DELETE', 'CRITICAL');
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION adquisiciones.trg_classifiers_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
BEGIN
    v_user_id := auth.uid();

    IF TG_OP = 'INSERT' THEN
        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, NEW.id, 'INSERT', row_to_json(NEW)::jsonb, v_user_id, 'classifiers_INSERT', 'INFO');
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        -- Defensive check for redundant updates (classifiers only have updated_at)
        IF (row_to_json(NEW)::jsonb - 'updated_at') = 
           (row_to_json(OLD)::jsonb - 'updated_at') THEN
            RETURN NEW;
        END IF;

        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, new_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, NEW.id, 'UPDATE', row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb, v_user_id, 'classifiers_UPDATE', 'INFO');
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, OLD.id, 'DELETE', row_to_json(OLD)::jsonb, v_user_id, 'classifiers_DELETE', 'CRITICAL');
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;
