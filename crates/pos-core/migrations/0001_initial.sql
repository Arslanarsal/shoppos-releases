CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    archived_at TEXT
);
CREATE UNIQUE INDEX categories_active_name ON categories(name COLLATE NOCASE) WHERE archived_at IS NULL;

CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name TEXT NOT NULL,
    identifier TEXT NOT NULL DEFAULT '',
    tracking TEXT NOT NULL CHECK (tracking IN ('unique', 'quantity')),
    sale_price INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
);
CREATE UNIQUE INDEX items_unique_identifier ON items(identifier COLLATE NOCASE) WHERE tracking = 'unique' AND identifier <> '';
CREATE INDEX items_category ON items(category_id);
CREATE INDEX items_name ON items(name COLLATE NOCASE);

CREATE TABLE field_defs (
    id INTEGER PRIMARY KEY,
    category_id INTEGER REFERENCES categories(id),
    item_id INTEGER REFERENCES items(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'longtext', 'int', 'decimal', 'money', 'date', 'bool', 'choice')),
    unit TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '[]',
    required INTEGER NOT NULL DEFAULT 0,
    group_name TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    show_in_list INTEGER NOT NULL DEFAULT 0,
    show_on_receipt INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    archived_at TEXT,
    CHECK ((category_id IS NULL) <> (item_id IS NULL))
);
CREATE INDEX field_defs_category ON field_defs(category_id, sort_order);
CREATE INDEX field_defs_item ON field_defs(item_id, sort_order);

CREATE TABLE item_values (
    item_id INTEGER NOT NULL REFERENCES items(id),
    field_id INTEGER NOT NULL REFERENCES field_defs(id),
    v_text TEXT,
    v_int INTEGER,
    v_num REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (item_id, field_id)
) WITHOUT ROWID;
CREATE INDEX item_values_int ON item_values(field_id, v_int);
CREATE INDEX item_values_num ON item_values(field_id, v_num);
CREATE INDEX item_values_text ON item_values(field_id, v_text COLLATE NOCASE);

CREATE TABLE photos (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id),
    file TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    original_name TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    archived_at TEXT
);
CREATE INDEX photos_item ON photos(item_id, sort_order);

CREATE TABLE txns (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('purchase', 'sale', 'return', 'adjustment', 'reversal')),
    number TEXT NOT NULL UNIQUE,
    business_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    party TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    related_txn_id INTEGER REFERENCES txns(id),
    related_kind TEXT,
    subtotal INTEGER NOT NULL,
    discount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    client_token TEXT UNIQUE,
    snapshot TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX txns_one_reversal ON txns(related_txn_id) WHERE kind = 'reversal';
CREATE INDEX txns_kind_date ON txns(kind, business_date);
CREATE INDEX txns_date ON txns(business_date);
CREATE INDEX txns_related ON txns(related_txn_id);

CREATE TABLE txn_lines (
    id INTEGER PRIMARY KEY,
    txn_id INTEGER NOT NULL REFERENCES txns(id),
    line_no INTEGER NOT NULL,
    item_id INTEGER NOT NULL REFERENCES items(id),
    qty INTEGER NOT NULL CHECK (qty > 0),
    direction INTEGER NOT NULL CHECK (direction IN (-1, 1)),
    unit_price INTEGER NOT NULL,
    line_discount INTEGER NOT NULL DEFAULT 0,
    alloc_discount INTEGER NOT NULL DEFAULT 0,
    net INTEGER NOT NULL,
    cost INTEGER NOT NULL DEFAULT 0,
    related_line_id INTEGER REFERENCES txn_lines(id),
    description TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX txn_lines_txn ON txn_lines(txn_id);
CREATE INDEX txn_lines_item ON txn_lines(item_id);
CREATE INDEX txn_lines_related ON txn_lines(related_line_id);

CREATE TABLE stock_moves (
    id INTEGER PRIMARY KEY,
    txn_id INTEGER NOT NULL REFERENCES txns(id),
    line_id INTEGER NOT NULL REFERENCES txn_lines(id),
    item_id INTEGER NOT NULL REFERENCES items(id),
    lot_line_id INTEGER NOT NULL REFERENCES txn_lines(id),
    lot_date TEXT NOT NULL,
    qty INTEGER NOT NULL,
    cost INTEGER NOT NULL,
    business_date TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX stock_moves_item ON stock_moves(item_id, business_date);
CREATE INDEX stock_moves_lot ON stock_moves(lot_line_id);
CREATE INDEX stock_moves_line ON stock_moves(line_id);

CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_entity ON audit_log(entity, entity_id);

CREATE TRIGGER keep_categories BEFORE DELETE ON categories BEGIN SELECT RAISE(ABORT, 'Saved records cannot be deleted. Archive them instead.'); END;
CREATE TRIGGER keep_items BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT, 'Saved records cannot be deleted. Archive them instead.'); END;
CREATE TRIGGER keep_field_defs BEFORE DELETE ON field_defs BEGIN SELECT RAISE(ABORT, 'Saved records cannot be deleted. Archive them instead.'); END;
CREATE TRIGGER keep_item_values BEFORE DELETE ON item_values BEGIN SELECT RAISE(ABORT, 'Saved records cannot be deleted.'); END;
CREATE TRIGGER keep_photos BEFORE DELETE ON photos BEGIN SELECT RAISE(ABORT, 'Saved records cannot be deleted. Archive them instead.'); END;
CREATE TRIGGER keep_txns BEFORE DELETE ON txns BEGIN SELECT RAISE(ABORT, 'Posted transactions cannot be deleted. Reverse them instead.'); END;
CREATE TRIGGER keep_txn_lines BEFORE DELETE ON txn_lines BEGIN SELECT RAISE(ABORT, 'Posted transactions cannot be deleted. Reverse them instead.'); END;
CREATE TRIGGER keep_stock_moves BEFORE DELETE ON stock_moves BEGIN SELECT RAISE(ABORT, 'Stock history cannot be deleted.'); END;
CREATE TRIGGER keep_audit BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'Edit history cannot be deleted.'); END;
CREATE TRIGGER fixed_txns BEFORE UPDATE ON txns BEGIN SELECT RAISE(ABORT, 'Posted transactions cannot be changed. Reverse them instead.'); END;
CREATE TRIGGER fixed_txn_lines BEFORE UPDATE ON txn_lines BEGIN SELECT RAISE(ABORT, 'Posted transactions cannot be changed. Reverse them instead.'); END;
CREATE TRIGGER fixed_stock_moves BEFORE UPDATE ON stock_moves BEGIN SELECT RAISE(ABORT, 'Stock history cannot be changed.'); END;
CREATE TRIGGER fixed_audit BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'Edit history cannot be changed.'); END;
