-- Indexes for reading lists a page at a time, and for the two lookups an
-- invoice request makes into an offer's history.

-- Pages are read in order of creation, with the ID to break ties. Each index
-- serves both directions.
CREATE INDEX IF NOT EXISTS fiber_offers_page_idx
  ON fiber_offers (created_at, offer_id);

CREATE INDEX IF NOT EXISTS fiber_resolutions_page_idx
  ON fiber_resolutions (offer_id, created_at, resolution_id);

CREATE INDEX IF NOT EXISTS fiber_webhook_events_page_idx
  ON fiber_webhook_events (offer_id, created_at, event_id);

-- Both are prefixes of the indexes above.
DROP INDEX IF EXISTS fiber_resolutions_offer_created_idx;
DROP INDEX IF EXISTS fiber_webhook_events_offer_idx;

-- "Was this invoice issued for this offer?" An invoice string is too long to
-- index as it is, so its hash is indexed and the string compared afterwards.
CREATE INDEX IF NOT EXISTS fiber_resolutions_invoice_idx
  ON fiber_resolutions (offer_id, md5(invoice ->> 'invoice'))
  WHERE invoice IS NOT NULL;

-- The resolutions that still count against an offer: everything that did not
-- end unpaid. For a single-use offer that is at most a handful of rows.
CREATE INDEX IF NOT EXISTS fiber_resolutions_counted_idx
  ON fiber_resolutions (offer_id, created_at)
  WHERE status NOT IN ('invoice_expired', 'invoice_failed', 'invoice_cancelled');
