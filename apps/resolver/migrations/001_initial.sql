CREATE TABLE IF NOT EXISTS fiber_offers (
  offer_id text PRIMARY KEY CHECK (offer_id ~ '^0x[0-9a-f]{64}$'),
  offer jsonb NOT NULL,
  encoded_offer text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  ownership jsonb,
  revocation jsonb,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fiber_addresses (
  username text PRIMARY KEY CHECK (username ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  offer_id text NOT NULL REFERENCES fiber_offers(offer_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiber_addresses_offer_idx ON fiber_addresses (offer_id);

CREATE TABLE IF NOT EXISTS fiber_resolutions (
  resolution_id text PRIMARY KEY,
  offer_id text NOT NULL REFERENCES fiber_offers(offer_id) ON DELETE CASCADE,
  status text NOT NULL,
  amount text NOT NULL,
  asset jsonb NOT NULL,
  invoice jsonb,
  recurrence jsonb,
  idempotency_key text,
  idempotency_fingerprint text,
  reservation_expires_at timestamptz,
  settlement jsonb NOT NULL DEFAULT '{}'::jsonb,
  status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  received_at timestamptz,
  settled_at timestamptz,
  expired_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fiber_resolutions_idempotency_idx
  ON fiber_resolutions (offer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS fiber_resolutions_recurrence_cycle_idx
  ON fiber_resolutions (offer_id, ((recurrence ->> 'cycle')::integer))
  WHERE recurrence IS NOT NULL AND status <> 'invoice_failed';

CREATE INDEX IF NOT EXISTS fiber_resolutions_offer_created_idx
  ON fiber_resolutions (offer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fiber_resolutions_open_idx
  ON fiber_resolutions (status, updated_at)
  WHERE status IN ('invoice_pending', 'invoice_created', 'invoice_received');

CREATE TABLE IF NOT EXISTS fiber_webhooks (
  webhook_id text PRIMARY KEY,
  offer_id text NOT NULL REFERENCES fiber_offers(offer_id) ON DELETE CASCADE,
  url text NOT NULL,
  events jsonb NOT NULL,
  secret text NOT NULL,
  secret_hint text,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiber_webhooks_offer_idx ON fiber_webhooks (offer_id);

CREATE TABLE IF NOT EXISTS fiber_webhook_events (
  event_id text PRIMARY KEY,
  offer_id text NOT NULL REFERENCES fiber_offers(offer_id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiber_webhook_events_offer_idx
  ON fiber_webhook_events (offer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fiber_webhook_deliveries (
  event_id text NOT NULL REFERENCES fiber_webhook_events(event_id) ON DELETE CASCADE,
  webhook_id text NOT NULL,
  url text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  response_status integer,
  response_body text,
  error jsonb,
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, webhook_id)
);

CREATE INDEX IF NOT EXISTS fiber_webhook_deliveries_pending_idx
  ON fiber_webhook_deliveries (status, updated_at)
  WHERE status IN ('pending', 'failed');
