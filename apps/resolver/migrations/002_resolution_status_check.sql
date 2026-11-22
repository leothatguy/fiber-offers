-- A resolution can only hold one of the statuses of the state machine in
-- apps/resolver/src/resolution-rules.js. Anything else is a bug, and is
-- refused by the database rather than stored.
ALTER TABLE fiber_resolutions
  DROP CONSTRAINT IF EXISTS fiber_resolutions_status_check;

ALTER TABLE fiber_resolutions
  ADD CONSTRAINT fiber_resolutions_status_check CHECK (
    status IN (
      'invoice_pending',
      'invoice_created',
      'invoice_received',
      'invoice_paid',
      'invoice_expired',
      'invoice_failed',
      'invoice_cancelled'
    )
  );
