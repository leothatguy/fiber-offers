-- Recurring cycles are counted per subscription (recurrence.approval_id), so
-- many payers can subscribe to one offer. Each subscription may hold one
-- counted resolution per cycle; two subscriptions may both be on cycle 1.
DROP INDEX IF EXISTS fiber_resolutions_recurrence_cycle_idx;

CREATE UNIQUE INDEX fiber_resolutions_recurrence_cycle_idx
  ON fiber_resolutions (
    offer_id,
    (COALESCE(recurrence ->> 'approval_id', '')),
    ((recurrence ->> 'cycle')::integer)
  )
  WHERE recurrence IS NOT NULL
    AND status NOT IN ('invoice_expired', 'invoice_failed', 'invoice_cancelled');

-- Looking up one subscription's history.
CREATE INDEX IF NOT EXISTS fiber_resolutions_subscription_idx
  ON fiber_resolutions (offer_id, (recurrence ->> 'approval_id'))
  WHERE recurrence IS NOT NULL;
