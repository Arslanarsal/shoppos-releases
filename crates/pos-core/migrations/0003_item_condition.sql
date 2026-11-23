ALTER TABLE items ADD COLUMN condition TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'damaged'));
CREATE INDEX items_condition ON items(condition);
