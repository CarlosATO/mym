CREATE OR REPLACE FUNCTION portal.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION portal.set_updated_by()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_by = auth.uid();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_set_updated_at
    BEFORE UPDATE ON portal.users
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();

CREATE TRIGGER trg_users_set_updated_by
    BEFORE UPDATE ON portal.users
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_by();

CREATE TRIGGER trg_roles_set_updated_at
    BEFORE UPDATE ON portal.roles
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();

CREATE TRIGGER trg_roles_set_updated_by
    BEFORE UPDATE ON portal.roles
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_by();

CREATE TRIGGER trg_permissions_set_updated_at
    BEFORE UPDATE ON portal.permissions
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();

CREATE TRIGGER trg_permissions_set_updated_by
    BEFORE UPDATE ON portal.permissions
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_by();

CREATE TRIGGER trg_modules_set_updated_at
    BEFORE UPDATE ON portal.modules
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();

CREATE TRIGGER trg_modules_set_updated_by
    BEFORE UPDATE ON portal.modules
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_by();

CREATE OR REPLACE FUNCTION portal.audit_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
BEGIN
    v_user_id := auth.uid();

    IF TG_OP = 'INSERT' THEN
        INSERT INTO portal.audit_logs (table_name, record_id, action, new_data, performed_by)
        VALUES (TG_TABLE_NAME, NEW.id, 'INSERT', row_to_json(NEW), v_user_id);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO portal.audit_logs (table_name, record_id, action, old_data, new_data, performed_by)
        VALUES (TG_TABLE_NAME, NEW.id, 'UPDATE', row_to_json(OLD), row_to_json(NEW), v_user_id);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO portal.audit_logs (table_name, record_id, action, old_data, performed_by)
        VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', row_to_json(OLD), v_user_id);
        RETURN OLD;
    END IF;
END;
$$;

CREATE TRIGGER trg_audit_users
    AFTER INSERT OR UPDATE OR DELETE ON portal.users
    FOR EACH ROW
    EXECUTE FUNCTION portal.audit_trigger();

CREATE TRIGGER trg_audit_roles
    AFTER INSERT OR UPDATE OR DELETE ON portal.roles
    FOR EACH ROW
    EXECUTE FUNCTION portal.audit_trigger();

CREATE TRIGGER trg_audit_permissions
    AFTER INSERT OR UPDATE OR DELETE ON portal.permissions
    FOR EACH ROW
    EXECUTE FUNCTION portal.audit_trigger();

CREATE TRIGGER trg_audit_role_permissions
    AFTER INSERT OR UPDATE OR DELETE ON portal.role_permissions
    FOR EACH ROW
    EXECUTE FUNCTION portal.audit_trigger();

CREATE TRIGGER trg_audit_user_permissions
    AFTER INSERT OR UPDATE OR DELETE ON portal.user_permissions
    FOR EACH ROW
    EXECUTE FUNCTION portal.audit_trigger();

CREATE TRIGGER trg_audit_modules
    AFTER INSERT OR UPDATE OR DELETE ON portal.modules
    FOR EACH ROW
    EXECUTE FUNCTION portal.audit_trigger();

CREATE TRIGGER trg_audit_user_modules
    AFTER INSERT OR UPDATE OR DELETE ON portal.user_modules
    FOR EACH ROW
    EXECUTE FUNCTION portal.audit_trigger();
