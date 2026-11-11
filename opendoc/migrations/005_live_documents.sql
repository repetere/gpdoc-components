-- Original OpenDoc schema, MIT. Explicit fresh Yjs document namespace only.
CREATE SCHEMA __SCHEMA__;
CREATE TABLE __SCHEMA__.live_document_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  max_documents_per_tenant integer NOT NULL CHECK (max_documents_per_tenant BETWEEN 1 AND 10000),
  max_documents integer NOT NULL CHECK (max_documents BETWEEN 1 AND 1000000),
  max_bytes bigint NOT NULL CHECK (max_bytes BETWEEN 1 AND 9007199254740991),
  document_count bigint NOT NULL DEFAULT 0 CHECK (document_count BETWEEN 0 AND 1000000),
  byte_count bigint NOT NULL DEFAULT 0 CHECK (byte_count BETWEEN 0 AND 9007199254740991),
  CHECK (document_count <= max_documents), CHECK (byte_count <= max_bytes)
);
CREATE TABLE __SCHEMA__.live_documents (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'),
  document_id text NOT NULL CHECK (document_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  state bytea NOT NULL CHECK (octet_length(state) BETWEEN 2 AND 1048576),
  -- JSON bytea projections preserve NUL and never rely on PostgreSQL text encoding.
  title_json bytea NOT NULL CHECK (octet_length(title_json) <= 1202),
  content_json bytea NOT NULL CHECK (octet_length(content_json) <= 1572866),
  logical_bytes bigint NOT NULL CHECK (logical_bytes = octet_length(state) + octet_length(tenant_id) + octet_length(document_id) + octet_length(title_json) + octet_length(content_json)),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, document_id)
);
