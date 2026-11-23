CREATE TABLE txn_details (
    id INTEGER PRIMARY KEY,
    txn_id INTEGER NOT NULL REFERENCES txns(id),
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    print INTEGER NOT NULL DEFAULT 0 CHECK (print IN (0,1)),
    created_at TEXT NOT NULL
);
CREATE INDEX txn_details_txn ON txn_details(txn_id, id);
CREATE TRIGGER keep_txn_details BEFORE DELETE ON txn_details BEGIN SELECT RAISE(ABORT, 'Saved records cannot be deleted.'); END;
CREATE TRIGGER fixed_txn_details BEFORE UPDATE ON txn_details BEGIN SELECT RAISE(ABORT, 'Saved records cannot be changed.'); END;
