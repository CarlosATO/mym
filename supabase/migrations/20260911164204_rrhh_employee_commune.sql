-- RRHH V1: normalized commune reference. City/locality remains free text.

ALTER TABLE rrhh.employees
    ADD COLUMN commune_id uuid REFERENCES portal.communes(id) ON DELETE RESTRICT;

CREATE INDEX employees_commune_id_idx ON rrhh.employees (commune_id);
