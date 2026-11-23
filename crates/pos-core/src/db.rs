use crate::error::{user, Error, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::path::Path;
use std::time::Duration;

#[derive(Clone, Copy, Debug)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration { version: 1, name: "initial", sql: include_str!("../migrations/0001_initial.sql") },
    Migration { version: 2, name: "reorder level", sql: include_str!("../migrations/0002_reorder_level.sql") },
    Migration { version: 3, name: "item condition", sql: include_str!("../migrations/0003_item_condition.sql") },
    Migration { version: 4, name: "photos on sales and purchases", sql: include_str!("../migrations/0004_txn_photos.sql") },
    Migration { version: 5, name: "notes and customer changes after a sale", sql: include_str!("../migrations/0005_txn_extras.sql") },
    Migration { version: 6, name: "extra details on sales and purchases", sql: include_str!("../migrations/0006_txn_details.sql") },
    Migration { version: 7, name: "print all item details on receipts", sql: include_str!("../migrations/0007_print_all_fields.sql") },
    Migration { version: 8, name: "photos can never be removed", sql: include_str!("../migrations/0008_photos_permanent.sql") },
];

pub fn latest_version() -> i64 {
    MIGRATIONS.last().map(|m| m.version).unwrap_or(0)
}

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn)?;
    Ok(conn)
}

pub fn open_reader(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(Duration::from_secs(10))?;
    Ok(conn)
}

pub fn open_existing(path: &Path) -> Result<Connection> {
    if !path.exists() {
        return Err(Error::NotFound(format!("{} not found", path.display())));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    configure(&conn)?;
    Ok(conn)
}

pub fn open_readonly(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(Duration::from_secs(10))?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(10))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

pub fn schema_version(conn: &Connection) -> Result<i64> {
    let has_meta: bool = conn
        .query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'", [], |_| Ok(true))
        .optional()?
        .unwrap_or(false);
    if !has_meta {
        return Ok(0);
    }
    let v: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0))
        .optional()?;
    Ok(v.and_then(|s| s.parse().ok()).unwrap_or(0))
}

pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0)).optional()?)
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [key, value],
    )?;
    Ok(())
}

pub fn pending(conn: &Connection, list: &[Migration]) -> Result<Vec<i64>> {
    let cur = schema_version(conn)?;
    Ok(list.iter().filter(|m| m.version > cur).map(|m| m.version).collect())
}

pub fn migrate(conn: &mut Connection, list: &[Migration], up_to: Option<i64>) -> Result<Vec<i64>> {
    let cur = schema_version(conn)?;
    let max = list.last().map(|m| m.version).unwrap_or(0);
    if cur > max {
        return user(format!(
            "This shop data was saved by a newer version of the app (data version {cur}, this app understands up to {max}). Please install the latest version of the app. Your data has not been changed."
        ));
    }
    let mut done = Vec::new();
    for m in list.iter().filter(|m| m.version > cur && up_to.is_none_or(|u| m.version <= u)) {
        let tx = conn.transaction()?;
        tx.execute_batch(m.sql).map_err(|e| {
            Error::User(format!("Update step {} ({}) failed: {e}", m.version, m.name))
        })?;
        meta_set(&tx, "schema_version", &m.version.to_string())?;
        tx.execute(
            "INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [format!("migrated_{}", m.version), crate::util::now_iso()],
        )?;
        tx.commit()?;
        done.push(m.version);
    }
    Ok(done)
}

pub fn snapshot_to(conn: &Connection, dest: &Path) -> Result<()> {
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p)?;
    }
    if dest.exists() {
        return user(format!("{} already exists", dest.display()));
    }
    let tmp = dest.with_extension("partial");
    let _ = std::fs::remove_file(&tmp);
    {
        let mut out = Connection::open(&tmp)?;
        let b = rusqlite::backup::Backup::new(conn, &mut out)?;
        b.run_to_completion(i32::MAX, Duration::from_millis(0), None)?;
    }
    {
        let out = Connection::open(&tmp)?;
        out.pragma_update(None, "journal_mode", "DELETE")?;
        let ok: String = out.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if ok != "ok" {
            return user(format!("Backup copy failed its check: {ok}"));
        }
    }
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

pub fn integrity_ok(conn: &Connection) -> Result<bool> {
    let ok: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    Ok(ok == "ok")
}

pub fn counts(conn: &Connection) -> Result<serde_json::Value> {
    let mut m = serde_json::Map::new();
    for t in ["categories", "items", "field_defs", "item_values", "photos", "txns", "txn_lines", "stock_moves", "audit_log", "settings"] {
        let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))?;
        m.insert(t.into(), n.into());
    }
    Ok(serde_json::Value::Object(m))
}
