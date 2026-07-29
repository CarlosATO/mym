-- Correct the canonical visible name without changing permission identity or grants.

UPDATE portal.permissions
SET name = 'Autorizar excepción de asignación de reconteo'
WHERE code = 'inventarios.recounts.override_assignee';

DO $$
DECLARE
    v_count integer;
BEGIN
    SELECT count(*)
    INTO v_count
    FROM portal.permissions
    WHERE code = 'inventarios.recounts.override_assignee'
      AND name = 'Autorizar excepción de asignación de reconteo';

    IF v_count <> 1 THEN
        RAISE EXCEPTION
            'Expected exactly one canonical inventory recount override permission';
    END IF;
END;
$$;
