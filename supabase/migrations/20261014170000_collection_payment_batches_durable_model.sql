-- Durable batch model only. This migration does not enqueue or process payments.

ALTER TABLE comercial.collection_payment_attempts
  ADD COLUMN sequence_number integer NULL,
  ADD COLUMN post_started_at timestamptz NULL;

-- Preserve the historical order inside each existing batch before enforcing it.
WITH numbered AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY batch_id ORDER BY created_at, id)::integer AS sequence_number
  FROM comercial.collection_payment_attempts
  WHERE batch_id IS NOT NULL
)
UPDATE comercial.collection_payment_attempts AS attempts
SET sequence_number = numbered.sequence_number
FROM numbered
WHERE attempts.id = numbered.id;

ALTER TABLE comercial.collection_payment_attempts
  ADD CONSTRAINT collection_payment_attempts_batch_sequence_check
  CHECK (sequence_number IS NULL OR sequence_number > 0);

CREATE UNIQUE INDEX collection_payment_attempts_batch_sequence_idx
  ON comercial.collection_payment_attempts (batch_id, sequence_number)
  WHERE batch_id IS NOT NULL;

ALTER TABLE comercial.collection_payment_batches
  ADD COLUMN processing_started_at timestamptz NULL,
  ADD COLUMN lease_expires_at timestamptz NULL,
  ADD COLUMN worker_token uuid NULL,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE comercial.collection_payment_batches
  ADD CONSTRAINT collection_payment_batches_terminal_completed_at_check
  CHECK (status NOT IN ('COMPLETED', 'PARTIAL', 'FAILED') OR completed_at IS NOT NULL);

ALTER TABLE comercial.collection_payment_batches
  ADD CONSTRAINT collection_payment_batches_confirmed_total_upper_bound_check
  CHECK (confirmed_total <= expected_total);

-- The current synchronous action writes completed_at for UNKNOWN. The stricter
-- non-terminal completed_at rule must wait for that action to be changed.

-- Future claim design, intentionally not installed in this block:
-- 1. Select one CREATED batch or one PROCESSING batch with an expired lease
--    using FOR UPDATE SKIP LOCKED.
-- 2. Set status = PROCESSING, worker_token = gen_random_uuid(),
--    processing_started_at = now(), lease_expires_at = now() + interval '1 minute'.
-- 3. Commit before any Bsale call.
-- 4. Every checkpoint renews the same lease and verifies worker_token.
-- 5. An expired lease must inspect the current attempt before any recovery action.
