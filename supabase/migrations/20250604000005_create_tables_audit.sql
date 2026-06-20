CREATE TABLE portal.audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name varchar(100) NOT NULL,
    record_id uuid,
    action varchar(20) NOT NULL,
    old_data jsonb,
    new_data jsonb,
    performed_by uuid REFERENCES portal.users(id),
    performed_at timestamptz NOT NULL DEFAULT now(),
    ip_address varchar(45)
);

CREATE INDEX idx_audit_logs_table_action ON portal.audit_logs (table_name, action);
CREATE INDEX idx_audit_logs_performed_by ON portal.audit_logs (performed_by);
CREATE INDEX idx_audit_logs_performed_at ON portal.audit_logs (performed_at DESC);

CREATE TABLE portal.security_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type varchar(50) NOT NULL,
    description text,
    user_id uuid REFERENCES portal.users(id),
    email varchar(255),
    ip_address varchar(45),
    user_agent text,
    success boolean NOT NULL,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_security_logs_event_type ON portal.security_logs (event_type);
CREATE INDEX idx_security_logs_user_id ON portal.security_logs (user_id);
CREATE INDEX idx_security_logs_created_at ON portal.security_logs (created_at DESC);
