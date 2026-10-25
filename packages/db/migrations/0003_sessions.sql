-- Login sessions. Local to this computer (never synced): each device logs its own users in.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE INDEX ix_sessions_user ON sessions(user_id);

-- NULL until the user chooses their own PIN (first-run and owner-reset PINs are temporary).
ALTER TABLE users ADD COLUMN pin_set_at TEXT;
