use crate::catalog::{self, FieldDef, ItemInput, PhotoRef};
use crate::db::{self, Migration, MIGRATIONS};
use crate::error::{user, Error, Result};
use crate::search::{self, ItemSearch, LineSearch};
use crate::stock::{self, AdjustInput, DocInput, ReturnInput, ReverseInput};
use crate::util::{now_iso, sha256_bytes, stamp, today};
use crate::{backup, reports, settings};
use base64::Engine;
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Core {
    pub data_dir: PathBuf,
    pub app_version: String,
    migrations: Vec<Migration>,
    conn: Mutex<Option<Connection>>,
    state: Mutex<Value>,
}

const MAX_UPLOAD: usize = 40 * 1024 * 1024;

fn arg<T: DeserializeOwned>(v: &Value) -> Result<T> {
    Ok(serde_json::from_value(v.clone())?)
}

fn id_of(v: &Value) -> Result<i64> {
    v.get("id").and_then(|x| x.as_i64()).ok_or_else(|| Error::User("Missing id".into()))
}

fn flag(v: &Value, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

impl Core {
    pub fn new(data_dir: impl Into<PathBuf>, app_version: &str) -> Self {
        let mut migrations: Vec<Migration> = MIGRATIONS.to_vec();
        if std::env::var("SHOPPOS_TEST_BAD_MIGRATION").is_ok_and(|v| v == "1") {
            migrations.push(Migration {
                version: db::latest_version() + 1,
                name: "test failure",
                sql: "CREATE TABLE test_half_done(x); SELECT no_such_function();",
            });
        }
        Self::with_migrations(data_dir, app_version, migrations)
    }

    pub fn with_migrations(data_dir: impl Into<PathBuf>, app_version: &str, migrations: Vec<Migration>) -> Self {
        Core {
            data_dir: data_dir.into(),
            app_version: app_version.to_string(),
            migrations,
            conn: Mutex::new(None),
            state: Mutex::new(json!({ "state": "closed" })),
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("shop.db")
    }

    fn marker(&self) -> PathBuf {
        self.data_dir.join("shop-id.txt")
    }

    fn latest(&self) -> i64 {
        self.migrations.last().map(|m| m.version).unwrap_or(0)
    }

    fn set_state(&self, v: Value) -> Value {
        let mut base = v;
        base["data_dir"] = json!(self.data_dir.display().to_string());
        base["app_version"] = json!(self.app_version);
        base["latest_schema"] = json!(self.latest());
        *self.state.lock().unwrap() = base.clone();
        base
    }

    pub fn is_open(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }

    pub fn close(&self) {
        let mut g = self.conn.lock().unwrap();
        if let Some(c) = g.take() {
            let _ = c.pragma_update(None, "wal_checkpoint", "TRUNCATE");
            drop(c);
        }
    }

    pub fn open(&self) -> Value {
        if self.is_open() {
            return self.state.lock().unwrap().clone();
        }
        match self.open_inner() {
            Ok(v) => self.set_state(v),
            Err(e) => self.set_state(json!({ "state": "error", "message": e.to_string() })),
        }
    }

    fn open_inner(&self) -> Result<Value> {
        std::fs::create_dir_all(&self.data_dir)?;
        let dbp = self.db_path();
        if !dbp.exists() {
            if self.marker().exists() {
                return Ok(json!({ "state": "missing_data", "message": "The shop data file is missing from this computer. Nothing new was created. Please restore from your backup drive." }));
            }
            return Ok(json!({ "state": "new" }));
        }
        let mut conn = db::open_existing(&dbp)?;
        let cur = db::schema_version(&conn)?;
        if cur == 0 {
            return Ok(json!({ "state": "error", "message": "The shop data file is not readable by this app. Nothing was changed." }));
        }
        if cur > self.latest() {
            return Ok(json!({
                "state": "incompatible", "schema_version": cur,
                "message": format!("This shop data was saved by a newer version of the app (data version {cur}). This copy of the app is older and will not open it, so nothing gets damaged. Please install the latest version.")
            }));
        }
        let mut safety = Value::Null;
        if cur < self.latest() {
            let dest = self.data_dir.join("backups").join("before-update").join(format!("{}-v{}-to-v{}", stamp(), cur, self.latest())).join("shop.db");
            if let Err(e) = db::snapshot_to(&conn, &dest) {
                return Ok(json!({ "state": "migration_failed", "schema_version": cur, "message": format!("The app could not make a safety copy before updating your data, so it did not update anything. ({e})") }));
            }
            safety = json!(dest.display().to_string());
            if let Err(e) = db::migrate(&mut conn, &self.migrations, None) {
                let now = db::schema_version(&conn).unwrap_or(cur);
                return Ok(json!({
                    "state": "migration_failed", "schema_version": now, "safety_copy": safety,
                    "message": format!("The update could not finish preparing your data. Your data was left exactly as it was (data version {now}). A safety copy is at {}. Details: {e}", dest.display())
                }));
            }
        }
        let id = match db::meta_get(&conn, "shop_id")? {
            Some(i) => i,
            None => {
                let i = uuid::Uuid::new_v4().to_string();
                db::meta_set(&conn, "shop_id", &i)?;
                i
            }
        };
        if !self.marker().exists() {
            std::fs::write(self.marker(), &id)?;
        }
        db::meta_set(&conn, "last_opened_app_version", &self.app_version)?;
        let v = db::schema_version(&conn)?;
        *self.conn.lock().unwrap() = Some(conn);
        Ok(json!({ "state": "ready", "schema_version": v, "migrated_from": if cur < v { json!(cur) } else { Value::Null }, "safety_copy": safety }))
    }

    pub fn status(&self) -> Value {
        self.state.lock().unwrap().clone()
    }

    fn create_shop(&self, args: &Value) -> Result<Value> {
        if self.db_path().exists() || self.marker().exists() {
            return user("A shop already exists on this computer");
        }
        std::fs::create_dir_all(&self.data_dir)?;
        let mut conn = db::open(&self.db_path())?;
        db::migrate(&mut conn, &self.migrations, None)?;
        let id = uuid::Uuid::new_v4().to_string();
        db::meta_set(&conn, "shop_id", &id)?;
        db::meta_set(&conn, "created_at", &now_iso())?;
        if let Some(m) = args.as_object() {
            settings::set_many(&conn, m)?;
        }
        std::fs::write(self.marker(), &id)?;
        drop(conn);
        Ok(self.open())
    }

    fn with_conn<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut g = self.conn.lock().unwrap();
        match g.as_mut() {
            Some(c) => f(c),
            None => user("The shop is not open yet"),
        }
    }

    fn store_upload(&self, sub: &str, prefix: &str, args: &Value) -> Result<PhotoRef> {
        let name = s(args, "name").to_string();
        let data = s(args, "data");
        let data = data.split_once(',').map(|(_, b)| b).unwrap_or(data);
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| Error::User("The picture could not be read".into()))?;
        if bytes.is_empty() || bytes.len() > MAX_UPLOAD {
            return user("The picture is empty or too large (40 MB limit)");
        }
        let ext = detect_image(&bytes).ok_or_else(|| Error::User("This file is not a picture the app can use (JPG, PNG, WEBP, GIF or BMP)".into()))?;
        let sha = sha256_bytes(&bytes);
        let rel = format!("{sub}/{}/{prefix}{sha}.{ext}", &sha[..2]);
        let dst = self.data_dir.join(&rel);
        if !(dst.exists() && std::fs::metadata(&dst)?.len() == bytes.len() as u64) {
            std::fs::create_dir_all(dst.parent().unwrap())?;
            let tmp = dst.with_extension("tmp");
            std::fs::write(&tmp, &bytes)?;
            std::fs::rename(&tmp, &dst)?;
        }
        Ok(PhotoRef { file: rel, sha256: sha, bytes: bytes.len() as i64, original_name: name })
    }

    pub fn backup_dest(&self) -> Result<(PathBuf, bool)> {
        let d = self.with_conn(|c| Ok(settings::get(c, "backup_dest")?.as_str().unwrap_or("").to_string()))?;
        if d.trim().is_empty() {
            Ok((self.data_dir.join("local-backups"), false))
        } else {
            Ok((PathBuf::from(d), true))
        }
    }

    pub fn backup_now(&self, deep: bool) -> Result<Value> {
        let (dest, chosen) = self.backup_dest()?;
        if chosen && !dest.is_dir() {
            let msg = format!("The backup drive or folder \"{}\" cannot be found. If it is a USB drive, please plug it in. The app will try again by itself.", dest.display());
            backup::record_failure(&self.data_dir, &dest.display().to_string(), &msg);
            return user(msg);
        }
        if !chosen {
            std::fs::create_dir_all(&dest)?;
        }
        self.with_conn(|c| backup::run(c, &self.data_dir, &dest, &self.app_version, deep))
    }

    pub fn backup_status(&self) -> Result<Value> {
        let (dest, chosen) = self.backup_dest()?;
        let interval = self.with_conn(|c| Ok(settings::get(c, "backup_interval_minutes")?.as_i64().unwrap_or(60)))?;
        let mut st = backup::read_status(&self.data_dir);
        let last = st["last_success_at"].as_str().and_then(|x| chrono::DateTime::parse_from_rfc3339(x).ok());
        let age_min = last.map(|l| (chrono::Utc::now() - l.with_timezone(&chrono::Utc)).num_minutes());
        let last_deep = st["last_deep_verify_at"].as_str().and_then(|x| chrono::DateTime::parse_from_rfc3339(x).ok());
        let deep_due = last_deep.is_none_or(|l| (chrono::Utc::now() - l.with_timezone(&chrono::Utc)).num_days() >= 7);
        st["dest"] = json!(dest.display().to_string());
        st["dest_chosen"] = json!(chosen);
        st["dest_available"] = json!(dest.is_dir() || !chosen);
        st["interval_minutes"] = json!(interval);
        st["minutes_since_success"] = json!(age_min);
        st["due"] = json!(age_min.is_none_or(|a| a >= interval));
        st["deep_due"] = json!(deep_due);
        Ok(st)
    }

    pub fn backup_if_due(&self) -> Result<Value> {
        let st = self.backup_status()?;
        if st["due"].as_bool() != Some(true) {
            return Ok(json!({ "ran": false, "status": st }));
        }
        let deep = st["deep_due"].as_bool() == Some(true);
        let r = self.backup_now(deep);
        Ok(json!({ "ran": true, "ok": r.is_ok(), "error": r.as_ref().err().map(|e| e.to_string()), "status": self.backup_status()? }))
    }

    fn restore_from(&self, snap: &Path) -> Result<Value> {
        self.close();
        let r = backup::restore(snap, &self.data_dir)?;
        let st = self.open();
        Ok(json!({ "restore": r, "status": st }))
    }

    fn recovery_list(&self) -> Result<Value> {
        let dir = self.data_dir.join("backups").join("before-update");
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path().join("shop.db");
                if p.exists() {
                    let v = db::open_readonly(&p).and_then(|c| db::schema_version(&c)).unwrap_or(0);
                    out.push(json!({ "path": p.display().to_string(), "name": e.file_name().to_string_lossy(), "schema_version": v }));
                }
            }
        }
        out.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
        Ok(json!(out))
    }

    fn recovery_restore(&self, path: &Path) -> Result<Value> {
        let safe = self.data_dir.join("backups").join("before-update");
        let canon = path.canonicalize()?;
        if !canon.starts_with(safe.canonicalize()?) {
            return user("That is not one of the app's safety copies");
        }
        let src = db::open_readonly(&canon)?;
        if !db::integrity_ok(&src)? {
            return user("That safety copy is damaged");
        }
        let v = db::schema_version(&src)?;
        if v > self.latest() {
            return user("That safety copy is from a newer version of the app");
        }
        self.close();
        let aside = self.data_dir.join("replaced").join(stamp());
        std::fs::create_dir_all(&aside)?;
        for n in ["shop.db", "shop.db-wal", "shop.db-shm"] {
            let p = self.data_dir.join(n);
            if p.exists() {
                std::fs::rename(&p, aside.join(n))?;
            }
        }
        db::snapshot_to(&src, &self.db_path())?;
        drop(src);
        Ok(json!({ "previous_moved_to": aside.display().to_string(), "status": self.open() }))
    }

    pub fn call(&self, cmd: &str, args: Value) -> Value {
        match self.dispatch(cmd, &args) {
            Ok(v) => json!({ "ok": true, "data": v }),
            Err(e) => json!({ "ok": false, "error": e.to_json() }),
        }
    }

    pub fn dispatch(&self, cmd: &str, a: &Value) -> Result<Value> {
        match cmd {
            "startup_status" => return Ok(self.status()),
            "open" => return Ok(self.open()),
            "shop_create" => return self.create_shop(a),
            "restore_find" => return Ok(json!(backup::find_snapshots(Path::new(s(a, "path")))?)),
            "restore_verify" => return backup::verify(Path::new(s(a, "path")), true),
            "restore_apply" => return self.restore_from(Path::new(s(a, "path"))),
            "recovery_list" => return self.recovery_list(),
            "recovery_restore" => return self.recovery_restore(Path::new(s(a, "path"))),
            "app_info" => {
                return Ok(json!({ "app_version": self.app_version, "data_dir": self.data_dir.display().to_string(), "latest_schema": self.latest(), "today": today() }))
            }
            "backup_now" => return self.backup_now(flag(a, "deep")),
            "backup_status" => return self.backup_status(),
            "backup_if_due" => return self.backup_if_due(),
            "photo_store" => return Ok(serde_json::to_value(self.store_upload("photos", "", a)?)?),
            "logo_store" => {
                let p = self.store_upload("branding", "logo-", a)?;
                return self.with_conn(|c| {
                    let mut m = Map::new();
                    m.insert("shop_logo".into(), json!(p.file));
                    settings::set_many(c, &m)
                });
            }
            "export_csv" => {
                let text = self.with_conn(|c| export(c, a))?;
                let path = s(a, "path");
                if path.is_empty() {
                    return Ok(json!({ "csv": text }));
                }
                std::fs::write(path, text.as_bytes())?;
                return Ok(json!({ "path": path }));
            }
            _ => {}
        }
        self.with_conn(|c| business(c, cmd, a))
    }
}

fn export(c: &Connection, a: &Value) -> Result<String> {
    let p = a.get("params").cloned().unwrap_or(json!({}));
    match s(a, "kind") {
        "items" => search::items_csv(c, &arg::<ItemSearch>(&p)?),
        "lines" => search::lines_csv(c, &arg::<LineSearch>(&p)?),
        "monthly" => reports::monthly_csv(c, &arg(&p)?),
        "stock" => reports::stock_csv(c, s(&p, "as_of"), p.get("category_id").and_then(|x| x.as_i64())),
        other => user(format!("Unknown export {other}")),
    }
}

#[derive(Deserialize)]
struct FieldUpdate {
    id: i64,
    #[serde(default)]
    patch: Map<String, Value>,
}

fn business(c: &mut Connection, cmd: &str, a: &Value) -> Result<Value> {
    Ok(match cmd {
        "settings_get" => settings::get_all(c)?,
        "settings_set" => settings::set_many(c, a.as_object().ok_or_else(|| Error::User("Bad settings".into()))?)?,
        "dashboard" => {
            let d = if s(a, "today").is_empty() { today() } else { s(a, "today").to_string() };
            reports::dashboard(c, &d)?
        }
        "category_list" => json!(catalog::category_list(c, flag(a, "include_archived"))?),
        "category_create" => {
            let tx = c.transaction()?;
            let id = catalog::category_create(&tx, s(a, "name"))?;
            tx.commit()?;
            json!({ "id": id })
        }
        "category_rename" => {
            catalog::category_rename(c, id_of(a)?, s(a, "name"))?;
            json!(true)
        }
        "category_archive" => {
            catalog::category_archive(c, id_of(a)?, flag(a, "archived"))?;
            json!(true)
        }
        "field_list" => {
            let cat = a.get("category_id").and_then(|x| x.as_i64());
            let item = a.get("item_id").and_then(|x| x.as_i64());
            json!(catalog::field_list(c, cat, item, flag(a, "include_archived"))?)
        }
        "field_all" => json!(catalog::field_all(c)?),
        "field_create" => {
            let d: FieldDef = arg(a)?;
            let tx = c.transaction()?;
            let f = catalog::field_create(&tx, &d)?;
            tx.commit()?;
            json!(f)
        }
        "field_create_many" => {
            let defs: Vec<FieldDef> = arg(a.get("fields").unwrap_or(&json!([])))?;
            let tx = c.transaction()?;
            let mut n = 0;
            for d in &defs {
                catalog::field_create(&tx, d)?;
                n += 1;
            }
            tx.commit()?;
            json!({ "created": n })
        }
        "field_update" => {
            let u: FieldUpdate = arg(a)?;
            let tx = c.transaction()?;
            let f = catalog::field_update(&tx, u.id, &u.patch)?;
            tx.commit()?;
            json!(f)
        }
        "field_reorder" => {
            let ids: Vec<i64> = arg(a.get("ids").unwrap_or(&json!([])))?;
            let tx = c.transaction()?;
            catalog::field_reorder(&tx, &ids)?;
            tx.commit()?;
            json!(true)
        }
        "field_archive" => {
            catalog::field_archive(c, id_of(a)?, flag(a, "archived"))?;
            json!(true)
        }
        "field_promote" => {
            let tx = c.transaction()?;
            let f = catalog::field_promote(&tx, id_of(a)?)?;
            tx.commit()?;
            json!(f)
        }
        "item_save" => {
            let input: ItemInput = arg(a)?;
            let tx = c.transaction()?;
            let id = catalog::item_save(&tx, &input)?;
            tx.commit()?;
            item_get(c, id)?
        }
        "item_get" => item_get(c, id_of(a)?)?,
        "item_archive" => {
            catalog::item_archive(c, id_of(a)?, flag(a, "archived"))?;
            json!(true)
        }
        "item_history" => {
            let id = id_of(a)?;
            json!({
                "purchases": search::line_search(c, &LineSearch { kinds: vec!["purchase".into(), "reversal:purchase".into()], item_id: Some(id), limit: Some(100000), ..Default::default() })?,
                "sales": search::line_search(c, &LineSearch { kinds: vec!["sale".into(), "return".into(), "reversal:sale".into(), "reversal:return".into()], item_id: Some(id), limit: Some(100000), ..Default::default() })?,
                "moves": stock::item_moves(c, id)?,
                "edits": catalog::history(c, "item", id)?,
            })
        }
        "item_stock_on" => {
            let (q, v) = stock::stock_on(c, id_of(a)?, Some(&crate::util::check_date(s(a, "date"))?))?;
            json!({ "qty": q, "value": v })
        }
        "item_search" => search::item_search(c, &arg(a)?)?,
        "line_search" => search::line_search(c, &arg(a)?)?,
        "purchase_post" => stock::purchase_post(c, &arg::<DocInput>(a)?)?,
        "sale_post" => stock::sale_post(c, &arg::<DocInput>(a)?)?,
        "return_post" => stock::return_post(c, &arg::<ReturnInput>(a)?)?,
        "reverse_post" => stock::reverse_post(c, &arg::<ReverseInput>(a)?)?,
        "adjust_post" => stock::adjust_post(c, &arg::<AdjustInput>(a)?)?,
        "txn_get" => stock::txn_get(c, id_of(a)?)?,
        "report_figures" => {
            let p: reports::PeriodInput = arg(a)?;
            reports::figures(c, &p.from, &p.to, p.category_id)?
        }
        "report_monthly" => reports::monthly(c, &arg(a)?)?,
        "report_stock" => reports::stock_report(c, s(a, "as_of"), a.get("category_id").and_then(|x| x.as_i64()), flag(a, "include_zero"))?,
        "history" => json!(catalog::history(c, s(a, "entity"), id_of(a)?)?),
        "integrity_check" => json!({ "ok": db::integrity_ok(c)?, "counts": db::counts(c)? }),
        other => return user(format!("Unknown command {other}")),
    })
}

fn item_get(c: &Connection, id: i64) -> Result<Value> {
    let item = catalog::item_row(c, id)?;
    let cat = item["category_id"].as_i64().unwrap_or(0);
    let fields = catalog::item_fields(c, id, cat)?;
    let values = catalog::item_values(c, id)?;
    let photos = catalog::item_photos(c, id, false)?;
    let (qty, value) = stock::stock_on(c, id, None)?;
    Ok(json!({ "item": item, "fields": fields, "values": values, "photos": photos, "stock": { "qty": qty, "value": value } }))
}

fn detect_image(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("png")
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("webp")
    } else if b.starts_with(b"GIF8") {
        Some("gif")
    } else if b.starts_with(b"BM") {
        Some("bmp")
    } else {
        None
    }
}
