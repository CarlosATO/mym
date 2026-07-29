ALTER TABLE inventarios.tasks
    ADD COLUMN paused_by uuid,
    ADD COLUMN completed_by uuid,
    ALTER COLUMN validation_cycle SET DEFAULT 1,
    DROP CONSTRAINT chk_inventarios_tasks_version,
    ADD CONSTRAINT chk_inventarios_tasks_version
        CHECK (version > 0 AND validation_cycle > 0),
    ADD CONSTRAINT fk_inventarios_tasks_paused_by
        FOREIGN KEY (paused_by)
        REFERENCES portal.users(id)
        ON DELETE RESTRICT,
    ADD CONSTRAINT fk_inventarios_tasks_completed_by
        FOREIGN KEY (completed_by)
        REFERENCES portal.users(id)
        ON DELETE RESTRICT,
    ADD CONSTRAINT chk_inventarios_tasks_paused_actor
        CHECK (
            (paused_at IS NULL AND paused_by IS NULL)
            OR (paused_at IS NOT NULL AND paused_by IS NOT NULL)
        ),
    ADD CONSTRAINT chk_inventarios_tasks_completed_actor
        CHECK (
            (completed_at IS NULL AND completed_by IS NULL)
            OR (completed_at IS NOT NULL AND completed_by IS NOT NULL)
        );

ALTER TABLE inventarios.task_events
    ALTER COLUMN cycle SET DEFAULT 1,
    DROP CONSTRAINT chk_inventarios_events_cycle,
    ADD CONSTRAINT chk_inventarios_events_cycle
        CHECK (cycle > 0);
