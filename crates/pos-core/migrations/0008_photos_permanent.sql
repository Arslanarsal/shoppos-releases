UPDATE photos SET archived_at = NULL WHERE archived_at IS NOT NULL;
CREATE TRIGGER photos_never_hidden BEFORE UPDATE OF archived_at ON photos WHEN NEW.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Photos cannot be removed once saved.'); END;
CREATE TRIGGER photos_file_fixed BEFORE UPDATE OF file, sha256, item_id ON photos BEGIN SELECT RAISE(ABORT, 'Photos cannot be changed once saved.'); END;
