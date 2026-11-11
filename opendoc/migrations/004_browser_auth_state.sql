-- Original OpenDoc shared browser authentication. MIT.
-- Explicit administrative bootstrap; __SCHEMA__ is validated/quoted by code.
-- Never use a document/account schema or apply this implicitly at login time.
CREATE SCHEMA __SCHEMA__;
CREATE TABLE __SCHEMA__.browser_auth_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  policy jsonb NOT NULL,
  key_check bytea NOT NULL CHECK (octet_length(key_check) = 32),
  max_bytes bigint NOT NULL CHECK (max_bytes BETWEEN 1 AND 16777216)
);
CREATE TABLE __SCHEMA__.browser_auth_records (
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('sessions', 'transactions', 'intents', 'tickets')),
  record_key bytea NOT NULL CHECK (octet_length(record_key) = 32),
  payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 29 AND 16384),
  expires_at bigint NOT NULL CHECK (expires_at BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (kind, record_key)
);
CREATE INDEX browser_auth_expiry ON __SCHEMA__.browser_auth_records (expires_at);
