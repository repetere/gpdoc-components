-- Original OpenDoc schema, MIT. Explicit account bootstrap only.
-- __SCHEMA__ is validated and quoted by initializePostgresAccountSchema.
-- A dedicated fresh namespace is mandatory, never a runtime migration.
CREATE SCHEMA __SCHEMA__;

CREATE TABLE __SCHEMA__.account_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  max_principals integer NOT NULL CHECK (max_principals BETWEEN 1 AND 1000000),
  max_identity_bindings integer NOT NULL CHECK (max_identity_bindings BETWEEN 1 AND 1000000),
  max_memberships integer NOT NULL CHECK (max_memberships BETWEEN 1 AND 1000000),
  max_memberships_per_tenant integer NOT NULL CHECK (max_memberships_per_tenant BETWEEN 1 AND 10000),
  max_bytes bigint NOT NULL CHECK (max_bytes BETWEEN 1 AND 9007199254740991),
  principal_count bigint NOT NULL DEFAULT 0 CHECK (principal_count BETWEEN 0 AND 1000000),
  identity_binding_count bigint NOT NULL DEFAULT 0 CHECK (identity_binding_count BETWEEN 0 AND 1000000),
  membership_count bigint NOT NULL DEFAULT 0 CHECK (membership_count BETWEEN 0 AND 1000000),
  byte_count bigint NOT NULL DEFAULT 0 CHECK (byte_count BETWEEN 0 AND 9007199254740991),
  CHECK (principal_count <= max_principals),
  CHECK (identity_binding_count <= max_identity_bindings),
  CHECK (membership_count <= max_memberships),
  CHECK (byte_count <= max_bytes)
);

CREATE TABLE __SCHEMA__.principals (
  principal_id text COLLATE "C" PRIMARY KEY CHECK (principal_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  active boolean NOT NULL
);

CREATE TABLE __SCHEMA__.identity_bindings (
  issuer bytea NOT NULL CHECK (octet_length(issuer) BETWEEN 1 AND 8192),
  subject bytea NOT NULL CHECK (octet_length(subject) BETWEEN 1 AND 2048),
  -- Fixed-width keys keep the index bounded even for maximum-length Unicode.
  -- sha256(bytea) is a PostgreSQL built-in; no extension or external service.
  -- Exact duplicate pairs necessarily collide and are therefore unique. Distinct
  -- digest collisions fail closed: runtime comparisons always include raw bytes.
  issuer_hash bytea GENERATED ALWAYS AS (sha256(issuer)) STORED,
  subject_hash bytea GENERATED ALWAYS AS (sha256(subject)) STORED,
  principal_id text COLLATE "C" NOT NULL REFERENCES __SCHEMA__.principals (principal_id),
  PRIMARY KEY (issuer_hash, subject_hash)
);

CREATE TABLE __SCHEMA__.memberships (
  tenant_id text COLLATE "C" NOT NULL CHECK (tenant_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'),
  principal_id text COLLATE "C" NOT NULL REFERENCES __SCHEMA__.principals (principal_id),
  role text COLLATE "C" NOT NULL CHECK (role IN ('owner', 'editor', 'viewer', 'commenter')),
  PRIMARY KEY (tenant_id, principal_id)
);
