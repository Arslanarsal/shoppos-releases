ALTER TABLE items ADD COLUMN reorder_level INTEGER;
CREATE INDEX items_archived ON items(archived_at);
