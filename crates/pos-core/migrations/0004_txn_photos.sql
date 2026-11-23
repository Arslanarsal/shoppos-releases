CREATE TABLE txn_photos (
    id INTEGER PRIMARY KEY,
    txn_id INTEGER NOT NULL REFERENCES txns(id),
    file TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    original_name TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX txn_photos_txn ON txn_photos(txn_id, sort_order);
CREATE TRIGGER keep_txn_photos BEFORE DELETE ON txn_photos BEGIN SELECT RAISE(ABORT, 'Saved records cannot be deleted.'); END;
CREATE TRIGGER fixed_txn_photos BEFORE UPDATE ON txn_photos BEGIN SELECT RAISE(ABORT, 'Saved records cannot be changed.'); END;
