-- Fix Carlos' task to use COUNTER role
DO $$
DECLARE
    v_carlos_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_campaign_id uuid;
    v_task_id uuid;
    v_admin_participant_id uuid;
    v_counter_campaign_participant_id uuid;
    v_counter_participant_id uuid;
    v_current_assignment_id uuid;
    v_new_assignment_id uuid;
BEGIN
    -- 1. Find Carlos' user_id
    SELECT id INTO v_carlos_id FROM portal.users WHERE nombre ILIKE '%Carlos%' AND apellido ILIKE '%Alegria%' AND is_active = true LIMIT 1;
    IF v_carlos_id IS NULL THEN
        RAISE EXCEPTION 'Precondition failed: Carlos Alegria not found';
    END IF;

    -- 2. Find IN_PROGRESS task assigned to Carlos
    SELECT t.id, t.company_id, t.session_id, t.current_assignment_id, sp.id
    INTO v_task_id, v_company_id, v_session_id, v_current_assignment_id, v_admin_participant_id
    FROM inventarios.tasks t
    JOIN inventarios.task_assignments ta ON ta.id = t.current_assignment_id
    JOIN inventarios.session_participants sp ON sp.id = ta.session_participant_id
    WHERE t.active_user_id = v_carlos_id AND t.status = 'IN_PROGRESS'
      AND sp.functional_role = 'ADMINISTRATOR'
    LIMIT 1;

    IF v_task_id IS NULL THEN
        RAISE EXCEPTION 'Precondition failed: No IN_PROGRESS task with ADMINISTRATOR assignment found for Carlos';
    END IF;

    -- Check if any open locations exist for this task
    IF EXISTS (
        SELECT 1 FROM inventarios.task_locations tl
        WHERE tl.task_id = v_task_id AND tl.status = 'OPEN'
    ) THEN
        RAISE EXCEPTION 'Precondition failed: Task has open locations';
    END IF;

    -- 3. Get Campaign ID
    SELECT campaign_id INTO v_campaign_id FROM inventarios.sessions WHERE id = v_session_id;

    -- 4. Check if Carlos already has COUNTER in campaign participants
    SELECT id INTO v_counter_campaign_participant_id
    FROM inventarios.inventory_campaign_participants
    WHERE company_id = v_company_id AND campaign_id = v_campaign_id
      AND user_id = v_carlos_id AND participant_role = 'COUNTER'
      AND revoked_at IS NULL;

    IF v_counter_campaign_participant_id IS NULL THEN
        -- Add COUNTER role to campaign participants
        INSERT INTO inventarios.inventory_campaign_participants
            (company_id, campaign_id, user_id, participant_role, created_by)
        VALUES
            (v_company_id, v_campaign_id, v_carlos_id, 'COUNTER', v_carlos_id)
        RETURNING id INTO v_counter_campaign_participant_id;
    END IF;

    -- 5. Check if Carlos already has COUNTER in session participants
    SELECT id INTO v_counter_participant_id
    FROM inventarios.session_participants
    WHERE company_id = v_company_id AND session_id = v_session_id
      AND user_id = v_carlos_id AND functional_role = 'COUNTER'
      AND revoked_at IS NULL;

    IF v_counter_participant_id IS NULL THEN
        -- Add COUNTER role to session participants
        INSERT INTO inventarios.session_participants
            (company_id, session_id, user_id, functional_role, created_by)
        VALUES
            (v_company_id, v_session_id, v_carlos_id, 'COUNTER', v_carlos_id)
        RETURNING id INTO v_counter_participant_id;
    END IF;

    IF v_admin_participant_id = v_counter_participant_id THEN
        RAISE EXCEPTION 'Precondition failed: Admin and Counter participant IDs are identical';
    END IF;

    -- 6. Release old assignment
    UPDATE inventarios.task_assignments
    SET released_at = now(), released_by = v_carlos_id, release_reason = 'Role correction (Admin -> Counter)'
    WHERE id = v_current_assignment_id AND released_at IS NULL;

    -- 7. Create new assignment
    INSERT INTO inventarios.task_assignments
        (company_id, session_id, task_id, session_participant_id, user_id, assigned_by, created_by)
    VALUES
        (v_company_id, v_session_id, v_task_id, v_counter_participant_id, v_carlos_id, v_carlos_id, v_carlos_id)
    RETURNING id INTO v_new_assignment_id;

    -- 8. Update task current_assignment_id
    UPDATE inventarios.tasks
    SET current_assignment_id = v_new_assignment_id
    WHERE id = v_task_id;

END;
$$;
