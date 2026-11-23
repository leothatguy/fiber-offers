-- A webhook delivery records only the status code of the answer.
--
-- Earlier versions also stored the first 2,000 characters of each response
-- body. With a webhook pointed at an internal address, that turned delivery
-- history into a way to read what internal services answer. The resolver no
-- longer writes or returns the body; this clears what was already stored.
-- The column stays so that a replica still running the previous version keeps
-- working during a rolling upgrade.
UPDATE fiber_webhook_deliveries SET response_body = NULL WHERE response_body IS NOT NULL;
