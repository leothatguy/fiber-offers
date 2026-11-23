-- Bookkeeping that lets each background pass take a bounded batch of what is
-- due, instead of reading every offer and everything under it.

-- The settlement pass asks the node about open invoices, starting with the one
-- it asked about longest ago. The time of asking is kept apart from updated_at,
-- which says when a resolution last changed.
ALTER TABLE fiber_resolutions ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS fiber_resolutions_sync_queue_idx
  ON fiber_resolutions (last_synced_at NULLS FIRST, created_at)
  WHERE status IN ('invoice_created', 'invoice_received');

-- One subscription's invoices, for the per-subscription limits of a recurring
-- offer with many subscribers.
CREATE INDEX IF NOT EXISTS fiber_resolutions_subscription_idx
  ON fiber_resolutions (offer_id, (recurrence ->> 'approval_id'))
  WHERE recurrence IS NOT NULL;

-- The delivery pass takes the deliveries that are due and holds each for a
-- short lease, so that two workers never send the same one. next_attempt_at
-- carries the backoff after a failure.
ALTER TABLE fiber_webhook_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE fiber_webhook_deliveries ADD COLUMN IF NOT EXISTS locked_until timestamptz;

CREATE INDEX IF NOT EXISTS fiber_webhook_deliveries_due_idx
  ON fiber_webhook_deliveries (next_attempt_at NULLS FIRST, created_at)
  WHERE status IN ('pending', 'failed');

-- Replaced by the index above. No query ever used it.
DROP INDEX IF EXISTS fiber_webhook_deliveries_pending_idx;

-- Old events are removed by age.
CREATE INDEX IF NOT EXISTS fiber_webhook_events_created_idx
  ON fiber_webhook_events (created_at);
