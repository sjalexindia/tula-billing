-- Local only (never synced): changes the cloud copy or this computer refused to apply,
-- e.g. two computers created the same daily rate. Kept so nothing is lost silently;
-- shown on the Devices & sync screen. See docs/07-sync-and-phones.md.
CREATE TABLE sync_rejects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  direction    TEXT NOT NULL CHECK (direction IN ('push','pull')),
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error        TEXT NOT NULL,
  at           TEXT NOT NULL
);
