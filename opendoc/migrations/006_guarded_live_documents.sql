-- Original OpenDoc optional guarded namespace, MIT.
-- The fresh bootstrap appends this to 005 in ONE transaction, before inserting
-- any state. This is NOT a migration/adoption script for an existing namespace.
ALTER TABLE __SCHEMA__.live_document_state
  ADD COLUMN authority_id text NOT NULL CHECK (authority_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  ADD COLUMN quarantined boolean NOT NULL DEFAULT false;
CREATE TABLE __SCHEMA__.live_document_checkpoints (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'),
  document_id text NOT NULL CHECK (document_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  PRIMARY KEY (tenant_id, document_id)
  -- Deliberately no cascading foreign key: a retained checkpoint must expose a
  -- missing canonical row instead of disappearing along with its history.
);
