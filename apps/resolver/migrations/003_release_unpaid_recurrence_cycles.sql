-- A recurring cycle whose invoice expired or was cancelled unpaid is released:
-- the same cycle may be issued again. The uniqueness guard therefore covers
-- only resolutions that still count (open or paid), not just "not failed".
DROP INDEX IF EXISTS fiber_resolutions_recurrence_cycle_idx;

CREATE UNIQUE INDEX fiber_resolutions_recurrence_cycle_idx
  ON fiber_resolutions (offer_id, ((recurrence ->> 'cycle')::integer))
  WHERE recurrence IS NOT NULL
    AND status NOT IN ('invoice_expired', 'invoice_failed', 'invoice_cancelled');
