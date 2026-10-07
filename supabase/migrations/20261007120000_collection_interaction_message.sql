-- Allow WhatsApp/message interactions in the collection activity log.
-- This changes only the event type whitelist; it does not modify existing rows.

ALTER TABLE comercial.collection_customer_events
  DROP CONSTRAINT collection_customer_events_event_type_check;

ALTER TABLE comercial.collection_customer_events
  ADD CONSTRAINT collection_customer_events_event_type_check
  CHECK (event_type IN (
    'NOTE', 'CALL', 'MESSAGE', 'EMAIL', 'COMMITMENT', 'STAGE_CHANGED',
    'PAYMENT_CLOSED', 'REOPENED_BY_NEW_DEBT', 'BSALE_PAYMENT_DETECTED',
    'BSALE_DEBT_UPDATED', 'COLLECTION_CLOSED_FROM_BSALE'
  ));
