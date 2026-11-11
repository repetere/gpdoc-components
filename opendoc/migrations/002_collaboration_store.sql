-- Original OpenDoc schema, MIT. Explicit collaboration bootstrap only.
-- __SCHEMA__ is validated and quoted by initializePostgresCollaborationSchema.
-- Standalone rooms, not REST documents. A fresh namespace is mandatory.
CREATE SCHEMA __SCHEMA__;

CREATE TABLE __SCHEMA__.collaboration_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  max_rooms_per_tenant integer NOT NULL CHECK (max_rooms_per_tenant BETWEEN 1 AND 10000),
  max_rooms integer NOT NULL CHECK (max_rooms BETWEEN 1 AND 1000000),
  max_bytes bigint NOT NULL CHECK (max_bytes BETWEEN 1 AND 9007199254740991),
  room_count bigint NOT NULL DEFAULT 0 CHECK (room_count BETWEEN 0 AND 1000000),
  byte_count bigint NOT NULL DEFAULT 0 CHECK (byte_count BETWEEN 0 AND 9007199254740991),
  CHECK (room_count <= max_rooms),
  CHECK (byte_count <= max_bytes)
);

CREATE TABLE __SCHEMA__.collaboration_rooms (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'),
  room_id text NOT NULL CHECK (room_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  state bytea NOT NULL CHECK (octet_length(state) BETWEEN 2 AND 1048576),
  -- Logical bytes: snapshot plus ASCII scope identifiers, not physical DB size.
  logical_bytes bigint NOT NULL CHECK (logical_bytes = octet_length(state) + octet_length(tenant_id) + octet_length(room_id)),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, room_id)
);
