-- One non-secret marker for verifying the running commit and its actual DB.
-- It is populated by the release executor after the final commit is frozen.
CREATE TABLE pilot_release_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  database_revision uuid NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  expected_commit_sha text NOT NULL CHECK (expected_commit_sha ~ '^[a-f0-9]{40}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
