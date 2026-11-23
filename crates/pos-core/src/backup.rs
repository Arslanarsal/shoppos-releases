use crate::db;
use crate::error::{user, Error, Result};
use crate::util::{now_iso, safe_name, sha256_file, stamp};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const ROOT_NAME: &str = "ShopPOS Backups";
const KEEP_LATEST: usize = 30;

pub fn status_path(data_dir: &Path) -> PathBuf {
    data_dir.join("backup-status.json")
}

pub fn read_status(data_dir: &Path) -> Value {
    fs::read_to_string(status_path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_status(data_dir: &Path, v: &Value) {
    let p = status_path(data_dir);
    let tmp = p.with_extension("tmp");
    if fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default()).is_ok() {
        let _ = fs::rename(&tmp, &p);
    }
}

pub fn record_failure(data_dir: &Path, dest: &str, msg: &str) {
    let mut st = read_status(data_dir);
    st["last_attempt_at"] = json!(now_iso());
    st["last_error"] = json!(msg);
    st["dest"] = json!(dest);
    write_status(data_dir, &st);
}

pub fn shop_dir(dest_root: &Path, shop_id: &str, shop_name: &str) -> PathBuf {
    let short: String = shop_id.chars().take(8).collect();
    dest_root.join(ROOT_NAME).join(format!("{} - {}", safe_name(shop_name), short))
}

fn check_dest(dest_root: &Path) -> Result<()> {
    if dest_root.as_os_str().is_empty() {
        return user("No backup place has been chosen yet");
    }
    if !dest_root.is_dir() {
        return user(format!(
            "The backup drive or folder \"{}\" cannot be found. If it is a USB drive, please plug it in. The app will try again by itself.",
            dest_root.display()
        ));
    }
    let probe = dest_root.join(format!(".shoppos-write-test-{}", uuid::Uuid::new_v4()));
    match fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => user(format!("The app cannot save to \"{}\" ({e}). Choose another backup place or check the drive is not full or locked.", dest_root.display())),
    }
}

fn list_files(base: &Path, sub: &str, out: &mut Vec<(String, PathBuf)>) -> std::io::Result<()> {
    let dir = base.join(sub);
    if !dir.exists() {
        return Ok(());
    }
    for e in fs::read_dir(&dir)? {
        let e = e?;
        let rel = format!("{sub}/{}", e.file_name().to_string_lossy());
        if e.file_type()?.is_dir() {
            list_files(base, &rel, out)?;
        } else if !rel.ends_with(".tmp") {
            out.push((rel, e.path()));
        }
    }
    Ok(())
}

fn sha_from_name(rel: &str) -> Option<String> {
    let stem = Path::new(rel).file_stem()?.to_string_lossy().to_string();
    let stem = stem.rsplit('-').next().unwrap_or(&stem).to_string();
    if stem.len() == 64 && stem.chars().all(|c| c.is_ascii_hexdigit()) { Some(stem) } else { None }
}

pub fn run(conn: &Connection, data_dir: &Path, dest_root: &Path, app_version: &str, deep: bool) -> Result<Value> {
    let started = now_iso();
    let res = run_inner(conn, data_dir, dest_root, app_version, deep);
    let mut st = read_status(data_dir);
    st["last_attempt_at"] = json!(started);
    st["dest"] = json!(dest_root.display().to_string());
    match &res {
        Ok(v) => {
            st["last_success_at"] = json!(now_iso());
            st["last_success_path"] = v["path"].clone();
            st["last_error"] = Value::Null;
            st["last_counts"] = v["counts"].clone();
            if deep {
                st["last_deep_verify_at"] = json!(now_iso());
            }
        }
        Err(e) => {
            st["last_error"] = json!(e.to_string());
        }
    }
    write_status(data_dir, &st);
    res
}

fn run_inner(conn: &Connection, data_dir: &Path, dest_root: &Path, app_version: &str, deep: bool) -> Result<Value> {
    check_dest(dest_root)?;
    let shop_id = db::meta_get(conn, "shop_id")?.unwrap_or_else(|| "unknown".into());
    let shop_name = crate::settings::get(conn, "shop_name")?.as_str().unwrap_or("Shop").to_string();
    let sdir = shop_dir(dest_root, &shop_id, &shop_name);
    let snaps = sdir.join("snapshots");
    let store = sdir.join("files");
    fs::create_dir_all(&snaps)?;
    fs::create_dir_all(&store)?;
    fs::write(
        sdir.join("README.txt"),
        "These are automatic backups of your shop made by the ShopPOS app.\r\nDo not edit or delete these files.\r\nTo restore: open ShopPOS on any computer, choose Restore from backup, and pick this folder.\r\n",
    )?;
    let mut ts = stamp();
    while snaps.join(&ts).exists() {
        ts = format!("{ts}b");
    }
    let tmp = snaps.join(format!(".partial-{ts}"));
    if tmp.exists() {
        fs::remove_dir_all(&tmp)?;
    }
    fs::create_dir_all(&tmp)?;
    let db_copy = tmp.join("shop.db");
    db::snapshot_to(conn, &db_copy)?;

    let mut files = Vec::new();
    list_files(data_dir, "photos", &mut files)?;
    list_files(data_dir, "branding", &mut files)?;
    let mut entries = Vec::new();
    let mut copied = 0u64;
    for (rel, src) in &files {
        let dst = store.join(rel);
        let src_len = fs::metadata(src)?.len();
        let fresh = !(dst.exists() && fs::metadata(&dst)?.len() == src_len);
        if fresh {
            if let Some(p) = dst.parent() {
                fs::create_dir_all(p)?;
            }
            let part = dst.with_extension("copying");
            fs::copy(src, &part)?;
            fs::rename(&part, &dst)?;
            copied += 1;
        }
        let expected = match sha_from_name(rel) {
            Some(s) => s,
            None => sha256_file(src)?,
        };
        if fresh || deep {
            let got = sha256_file(&dst)?;
            if got != expected {
                let _ = fs::remove_file(&dst);
                return user(format!("Backup check failed for {rel}. The backup drive may be faulty."));
            }
        }
        entries.push(json!({ "path": rel, "sha256": expected, "bytes": src_len }));
    }

    let snap_conn = db::open_readonly(&db_copy)?;
    if !db::integrity_ok(&snap_conn)? {
        return user("The backup copy of the database failed its check");
    }
    let counts = db::counts(&snap_conn)?;
    let live_counts = db::counts(conn)?;
    if counts != live_counts {
        return user("The backup copy does not match the shop data. It will be tried again.");
    }
    let schema = db::schema_version(&snap_conn)?;
    drop(snap_conn);
    let manifest = json!({
        "format": 1,
        "app": "ShopPOS",
        "shop_id": shop_id,
        "shop_name": shop_name,
        "created_at": now_iso(),
        "app_version": app_version,
        "schema_version": schema,
        "db": { "file": "shop.db", "sha256": sha256_file(&db_copy)?, "bytes": fs::metadata(&db_copy)?.len() },
        "counts": counts,
        "files": entries,
    });
    fs::write(tmp.join("manifest.json"), serde_json::to_string_pretty(&manifest)?)?;
    let fin = snaps.join(&ts);
    fs::rename(&tmp, &fin)?;
    verify(&fin, false)?;
    prune(&snaps)?;
    Ok(json!({ "path": fin.display().to_string(), "counts": manifest["counts"], "files": manifest["files"].as_array().map(|a| a.len()).unwrap_or(0), "copied": copied }))
}

fn prune(snaps: &Path) -> Result<()> {
    let mut names: Vec<String> = fs::read_dir(snaps)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join("manifest.json").exists())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort();
    if names.len() <= KEEP_LATEST {
        return Ok(());
    }
    let keep_from = names.len() - KEEP_LATEST;
    let mut seen_month = std::collections::HashSet::new();
    for (i, n) in names.iter().enumerate() {
        let month = n.get(..7).unwrap_or("").to_string();
        let first_of_month = seen_month.insert(month);
        if i < keep_from && !first_of_month {
            let _ = fs::remove_dir_all(snaps.join(n));
        }
    }
    Ok(())
}

pub fn read_manifest(snap: &Path) -> Result<Value> {
    let p = snap.join("manifest.json");
    let s = fs::read_to_string(&p).map_err(|_| Error::User(format!("{} is not a ShopPOS backup", snap.display())))?;
    let v: Value = serde_json::from_str(&s)?;
    if v["app"] != "ShopPOS" {
        return user("This folder is not a ShopPOS backup");
    }
    Ok(v)
}

fn store_for(snap: &Path) -> PathBuf {
    snap.parent().and_then(|p| p.parent()).map(|p| p.join("files")).unwrap_or_default()
}

pub fn verify(snap: &Path, deep: bool) -> Result<Value> {
    let m = read_manifest(snap)?;
    let db_path = snap.join("shop.db");
    if sha256_file(&db_path)? != m["db"]["sha256"].as_str().unwrap_or("") {
        return user("The backup database file is damaged");
    }
    let c = db::open_readonly(&db_path)?;
    if !db::integrity_ok(&c)? {
        return user("The backup database failed its check");
    }
    if db::counts(&c)? != m["counts"] {
        return user("The backup database does not match its record");
    }
    let store = store_for(snap);
    for f in m["files"].as_array().cloned().unwrap_or_default() {
        let rel = f["path"].as_str().unwrap_or("");
        let p = store.join(rel);
        let meta = fs::metadata(&p).map_err(|_| Error::User(format!("A photo or logo is missing from the backup: {rel}")))?;
        if meta.len() != f["bytes"].as_u64().unwrap_or(0) {
            return user(format!("A photo or logo in the backup is damaged: {rel}"));
        }
        if deep && sha256_file(&p)? != f["sha256"].as_str().unwrap_or("") {
            return user(format!("A photo or logo in the backup is damaged: {rel}"));
        }
    }
    Ok(m)
}

pub fn find_snapshots(path: &Path) -> Result<Vec<Value>> {
    let mut snaps: Vec<PathBuf> = Vec::new();
    let mut consider = |p: &Path| {
        if p.join("manifest.json").exists() {
            snaps.push(p.to_path_buf());
        }
    };
    let scan_shop = |shop: &Path, consider: &mut dyn FnMut(&Path)| {
        if let Ok(rd) = fs::read_dir(shop.join("snapshots")) {
            for e in rd.flatten() {
                if !e.file_name().to_string_lossy().starts_with('.') {
                    consider(&e.path());
                }
            }
        }
    };
    if path.join("manifest.json").exists() {
        consider(path);
    } else if path.join("snapshots").is_dir() {
        scan_shop(path, &mut consider);
    } else {
        let root = if path.join(ROOT_NAME).is_dir() { path.join(ROOT_NAME) } else { path.to_path_buf() };
        if let Ok(rd) = fs::read_dir(&root) {
            for e in rd.flatten() {
                if e.path().join("snapshots").is_dir() {
                    scan_shop(&e.path(), &mut consider);
                }
            }
        }
    }
    let mut out = Vec::new();
    for s in snaps {
        if let Ok(m) = read_manifest(&s) {
            out.push(json!({
                "path": s.display().to_string(), "created_at": m["created_at"], "shop_name": m["shop_name"], "shop_id": m["shop_id"],
                "app_version": m["app_version"], "schema_version": m["schema_version"], "counts": m["counts"],
                "files": m["files"].as_array().map(|a| a.len()).unwrap_or(0)
            }));
        }
    }
    out.sort_by(|a, b| b["created_at"].as_str().cmp(&a["created_at"].as_str()));
    if out.is_empty() {
        return user(format!("No ShopPOS backups were found in \"{}\". Choose the backup drive or the \"{ROOT_NAME}\" folder.", path.display()));
    }
    Ok(out)
}

pub fn move_aside(data_dir: &Path) -> Result<Option<PathBuf>> {
    let names = ["shop.db", "shop.db-wal", "shop.db-shm", "photos", "branding", "shop-id.txt", "backup-status.json"];
    if !names.iter().any(|n| data_dir.join(n).exists()) {
        return Ok(None);
    }
    let aside = data_dir.join("replaced").join(stamp());
    fs::create_dir_all(&aside)?;
    for n in names {
        let p = data_dir.join(n);
        if p.exists() {
            fs::rename(&p, aside.join(n))?;
        }
    }
    Ok(Some(aside))
}

pub fn restore(snap: &Path, data_dir: &Path) -> Result<Value> {
    let m = verify(snap, true)?;
    let sv = m["schema_version"].as_i64().unwrap_or(0);
    if sv > db::latest_version() {
        return user("This backup was made by a newer version of the app. Please update the app first, then restore.");
    }
    fs::create_dir_all(data_dir)?;
    let staging = data_dir.join(format!(".restore-{}", stamp()));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;
    {
        let src = db::open_readonly(&snap.join("shop.db"))?;
        db::snapshot_to(&src, &staging.join("shop.db"))?;
    }
    let store = store_for(snap);
    for f in m["files"].as_array().cloned().unwrap_or_default() {
        let rel = f["path"].as_str().unwrap_or("");
        if rel.contains("..") {
            continue;
        }
        let dst = staging.join(rel);
        if let Some(p) = dst.parent() {
            fs::create_dir_all(p)?;
        }
        fs::copy(store.join(rel), &dst)?;
        if sha256_file(&dst)? != f["sha256"].as_str().unwrap_or("") {
            return user(format!("Could not copy {rel} correctly. Try another backup."));
        }
    }
    let aside = move_aside(data_dir)?;
    for n in ["shop.db", "photos", "branding"] {
        let p = staging.join(n);
        if p.exists() {
            fs::rename(&p, data_dir.join(n))?;
        }
    }
    fs::write(data_dir.join("shop-id.txt"), m["shop_id"].as_str().unwrap_or(""))?;
    let _ = fs::remove_dir_all(&staging);
    let mut st = json!({});
    st["restored_from"] = json!(snap.display().to_string());
    st["restored_at"] = json!(now_iso());
    write_status(data_dir, &st);
    Ok(json!({ "restored_from": snap.display().to_string(), "previous_data_moved_to": aside.map(|p| p.display().to_string()), "counts": m["counts"], "created_at": m["created_at"] }))
}
