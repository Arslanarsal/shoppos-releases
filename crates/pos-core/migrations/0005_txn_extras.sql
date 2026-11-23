CREATE TABLE txn_extras (
    id INTEGER PRIMARY KEY,
    txn_id INTEGER NOT NULL REFERENCES txns(id),
    kind TEXT NOT NULL CHECK (kind IN ('note','party')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX txn_extras_txn ON txn_extras(txn_id, id);
CREATE TRIGGER keep_txn_extras BEFORE DELETE ON txn_extras BEGIN SELECT RAISE(ABORT, 'Saved records cannot be deleted.'); END;
CREATE TRIGGER fixed_txn_extras BEFORE UPDATE ON txn_extras BEGIN SELECT RAISE(ABORT, 'Saved records cannot be changed.'); END;
