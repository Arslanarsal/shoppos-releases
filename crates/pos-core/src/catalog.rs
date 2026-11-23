use crate::error::{user, Error, Result};
use crate::util::{check_date, now_iso};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub const KINDS: &[&str] = &["text", "longtext", "int", "decimal", "money", "date", "bool", "choice"];

pub fn audit(conn: &Connection, entity: &str, id: Option<i64>, action: &str, detail: &Value) -> Result<()> {
    conn.execute(
        "INSERT INTO audit_log(at,entity,entity_id,action,detail) VALUES(?1,?2,?3,?4,?5)",
        params![now_iso(), entity, id, action, detail.to_string()],
    )?;
    Ok(())
}

fn clean(s: &str) -> String {
    s.trim().to_string()
}

#[derive(Serialize, Clone, Debug)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub archived: bool,
    pub item_count: i64,
    pub field_count: i64,
}

pub fn category_list(conn: &Connection, include_archived: bool) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.archived_at IS NOT NULL,
            (SELECT COUNT(*) FROM items i WHERE i.category_id=c.id AND i.archived_at IS NULL),
            (SELECT COUNT(*) FROM field_defs f WHERE f.category_id=c.id AND f.archived_at IS NULL)
         FROM categories c WHERE (?1 OR c.archived_at IS NULL) ORDER BY c.archived_at IS NOT NULL, c.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([include_archived], |r| {
        Ok(Category { id: r.get(0)?, name: r.get(1)?, archived: r.get(2)?, item_count: r.get(3)?, field_count: r.get(4)? })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn category_create(conn: &Connection, name: &str) -> Result<i64> {
    let name = clean(name);
    if name.is_empty() {
        return user("Please type a category name");
    }
    let exists: Option<i64> = conn
        .query_row("SELECT id FROM categories WHERE name=?1 COLLATE NOCASE AND archived_at IS NULL", [&name], |r| r.get(0))
        .optional()?;
    if exists.is_some() {
        return user(format!("A category called \"{name}\" already exists"));
    }
    conn.execute("INSERT INTO categories(name,created_at) VALUES(?1,?2)", params![name, now_iso()])?;
    let id = conn.last_insert_rowid();
    audit(conn, "category", Some(id), "create", &json!({ "name": name }))?;
    Ok(id)
}

pub fn category_rename(conn: &Connection, id: i64, name: &str) -> Result<()> {
    let name = clean(name);
    if name.is_empty() {
        return user("Please type a category name");
    }
    let old: String = conn
        .query_row("SELECT name FROM categories WHERE id=?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| Error::NotFound("Category not found".into()))?;
    let clash: Option<i64> = conn
        .query_row("SELECT id FROM categories WHERE name=?1 COLLATE NOCASE AND archived_at IS NULL AND id<>?2", params![name, id], |r| r.get(0))
        .optional()?;
    if clash.is_some() {
        return user(format!("A category called \"{name}\" already exists"));
    }
    conn.execute("UPDATE categories SET name=?1 WHERE id=?2", params![name, id])?;
    audit(conn, "category", Some(id), "rename", &json!({ "from": old, "to": name }))?;
    Ok(())
}

pub fn category_archive(conn: &Connection, id: i64, archived: bool) -> Result<()> {
    if !archived {
        let name: String = conn.query_row("SELECT name FROM categories WHERE id=?1", [id], |r| r.get(0))?;
        let clash: Option<i64> = conn
            .query_row("SELECT id FROM categories WHERE name=?1 COLLATE NOCASE AND archived_at IS NULL AND id<>?2", params![name, id], |r| r.get(0))
            .optional()?;
        if clash.is_some() {
            return user(format!("Another active category is already called \"{name}\". Rename one first."));
        }
    }
    let at = if archived { Some(now_iso()) } else { None };
    conn.execute("UPDATE categories SET archived_at=?1 WHERE id=?2", params![at, id])?;
    audit(conn, "category", Some(id), if archived { "archive" } else { "unarchive" }, &json!({}))?;
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct FieldDef {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub category_id: Option<i64>,
    #[serde(default)]
    pub item_id: Option<i64>,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub group_name: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub show_in_list: bool,
    #[serde(default = "yes")]
    pub show_on_receipt: bool,
    #[serde(default)]
    pub archived: bool,
}

fn yes() -> bool {
    true
}

const FIELD_COLS: &str = "id, category_id, item_id, name, kind, unit, options, required, group_name, sort_order, show_in_list, show_on_receipt, archived_at IS NOT NULL";

fn field_row(r: &Row) -> rusqlite::Result<FieldDef> {
    let opts: String = r.get(6)?;
    Ok(FieldDef {
        id: r.get(0)?,
        category_id: r.get(1)?,
        item_id: r.get(2)?,
        name: r.get(3)?,
        kind: r.get(4)?,
        unit: r.get(5)?,
        options: serde_json::from_str(&opts).unwrap_or_default(),
        required: r.get(7)?,
        group_name: r.get(8)?,
        sort_order: r.get(9)?,
        show_in_list: r.get(10)?,
        show_on_receipt: r.get(11)?,
        archived: r.get(12)?,
    })
}

pub fn field_get(conn: &Connection, id: i64) -> Result<FieldDef> {
    conn.query_row(&format!("SELECT {FIELD_COLS} FROM field_defs WHERE id=?1"), [id], field_row)
        .optional()?
        .ok_or_else(|| Error::NotFound("Field not found".into()))
}

pub fn field_list(conn: &Connection, category_id: Option<i64>, item_id: Option<i64>, include_archived: bool) -> Result<Vec<FieldDef>> {
    let mut out = Vec::new();
    if let Some(c) = category_id {
        let mut s = conn.prepare(&format!(
            "SELECT {FIELD_COLS} FROM field_defs WHERE category_id=?1 AND (?2 OR archived_at IS NULL) ORDER BY sort_order, id"
        ))?;
        for f in s.query_map(params![c, include_archived], field_row)? {
            out.push(f?);
        }
    }
    if let Some(i) = item_id {
        let mut s = conn.prepare(&format!(
            "SELECT {FIELD_COLS} FROM field_defs WHERE item_id=?1 AND (?2 OR archived_at IS NULL) ORDER BY sort_order, id"
        ))?;
        for f in s.query_map(params![i, include_archived], field_row)? {
            out.push(f?);
        }
    }
    Ok(out)
}

pub fn field_all(conn: &Connection) -> Result<Vec<FieldDef>> {
    let mut s = conn.prepare(&format!("SELECT {FIELD_COLS} FROM field_defs WHERE item_id IS NULL ORDER BY category_id, sort_order, id"))?;
    let rows = s.query_map([], field_row)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn validate_def(d: &FieldDef) -> Result<FieldDef> {
    let mut d = d.clone();
    d.name = clean(&d.name);
    d.unit = clean(&d.unit);
    d.group_name = clean(&d.group_name);
    if d.name.is_empty() {
        return user("Please type a name for the field");
    }
    if !KINDS.contains(&d.kind.as_str()) {
        return user(format!("Unknown field type {}", d.kind));
    }
    let mut seen = HashSet::new();
    d.options = d
        .options
        .iter()
        .map(|o| clean(o))
        .filter(|o| !o.is_empty() && seen.insert(o.to_lowercase()))
        .collect();
    if d.kind == "choice" && d.options.is_empty() {
        return user("A choice list needs at least one choice");
    }
    Ok(d)
}

pub fn field_create(conn: &Connection, def: &FieldDef) -> Result<FieldDef> {
    let d = validate_def(def)?;
    if d.category_id.is_some() == d.item_id.is_some() {
        return user("A field belongs either to a category or to one item");
    }
    let clash: Option<i64> = conn
        .query_row(
            "SELECT id FROM field_defs WHERE name=?1 COLLATE NOCASE AND archived_at IS NULL AND category_id IS ?2 AND item_id IS ?3",
            params![d.name, d.category_id, d.item_id],
            |r| r.get(0),
        )
        .optional()?;
    if clash.is_some() {
        return user(format!("There is already a field called \"{}\" here", d.name));
    }
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order),0)+1 FROM field_defs WHERE category_id IS ?1 AND item_id IS ?2",
        params![d.category_id, d.item_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO field_defs(category_id,item_id,name,kind,unit,options,required,group_name,sort_order,show_in_list,show_on_receipt,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            d.category_id, d.item_id, d.name, d.kind, d.unit, serde_json::to_string(&d.options)?, d.required, d.group_name,
            next, d.show_in_list, d.show_on_receipt, now_iso()
        ],
    )?;
    let id = conn.last_insert_rowid();
    let f = field_get(conn, id)?;
    audit(conn, "field", Some(id), "create", &serde_json::to_value(&f)?)?;
    Ok(f)
}

pub fn field_update(conn: &Connection, id: i64, patch: &Map<String, Value>) -> Result<FieldDef> {
    let before = field_get(conn, id)?;
    let mut merged = serde_json::to_value(&before)?;
    for (k, v) in patch {
        if ["name", "unit", "options", "required", "group_name", "show_in_list", "show_on_receipt", "kind"].contains(&k.as_str()) {
            merged[k] = v.clone();
        }
    }
    let after: FieldDef = serde_json::from_value(merged)?;
    let after = validate_def(&after)?;
    if after.kind != before.kind {
        let used: i64 = conn.query_row(
            "SELECT COUNT(*) FROM item_values WHERE field_id=?1 AND (v_text IS NOT NULL OR v_int IS NOT NULL OR v_num IS NOT NULL)",
            [id],
            |r| r.get(0),
        )?;
        if used > 0 {
            return user("This field already has saved values, so its type cannot change. Archive it and create a new field instead.");
        }
    }
    if after.name.to_lowercase() != before.name.to_lowercase() {
        let clash: Option<i64> = conn
            .query_row(
                "SELECT id FROM field_defs WHERE name=?1 COLLATE NOCASE AND archived_at IS NULL AND category_id IS ?2 AND item_id IS ?3 AND id<>?4",
                params![after.name, before.category_id, before.item_id, id],
                |r| r.get(0),
            )
            .optional()?;
        if clash.is_some() {
            return user(format!("There is already a field called \"{}\" here", after.name));
        }
    }
    conn.execute(
        "UPDATE field_defs SET name=?1, kind=?2, unit=?3, options=?4, required=?5, group_name=?6, show_in_list=?7, show_on_receipt=?8 WHERE id=?9",
        params![
            after.name, after.kind, after.unit, serde_json::to_string(&after.options)?, after.required, after.group_name,
            after.show_in_list, after.show_on_receipt, id
        ],
    )?;
    let f = field_get(conn, id)?;
    audit(conn, "field", Some(id), "update", &json!({ "from": before, "to": f }))?;
    Ok(f)
}

pub fn field_reorder(conn: &Connection, ids: &[i64]) -> Result<()> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute("UPDATE field_defs SET sort_order=?1 WHERE id=?2", params![i as i64 + 1, id])?;
    }
    audit(conn, "field", None, "reorder", &json!({ "order": ids }))?;
    Ok(())
}

pub fn field_archive(conn: &Connection, id: i64, archived: bool) -> Result<()> {
    field_get(conn, id)?;
    let at = if archived { Some(now_iso()) } else { None };
    conn.execute("UPDATE field_defs SET archived_at=?1 WHERE id=?2", params![at, id])?;
    audit(conn, "field", Some(id), if archived { "archive" } else { "unarchive" }, &json!({}))?;
    Ok(())
}

pub fn field_promote(conn: &Connection, id: i64) -> Result<FieldDef> {
    let f = field_get(conn, id)?;
    let item_id = match f.item_id {
        Some(i) => i,
        None => return Ok(f),
    };
    let cat: i64 = conn.query_row("SELECT category_id FROM items WHERE id=?1", [item_id], |r| r.get(0))?;
    let clash: Option<i64> = conn
        .query_row("SELECT id FROM field_defs WHERE name=?1 COLLATE NOCASE AND archived_at IS NULL AND category_id=?2", params![f.name, cat], |r| r.get(0))
        .optional()?;
    if clash.is_some() {
        return user(format!("The category already has a field called \"{}\"", f.name));
    }
    let next: i64 = conn.query_row("SELECT COALESCE(MAX(sort_order),0)+1 FROM field_defs WHERE category_id=?1", [cat], |r| r.get(0))?;
    conn.execute("UPDATE field_defs SET item_id=NULL, category_id=?1, sort_order=?2 WHERE id=?3", params![cat, next, id])?;
    audit(conn, "field", Some(id), "share_with_category", &json!({ "category_id": cat, "item_id": item_id }))?;
    field_get(conn, id)
}

pub struct Stored {
    pub v_text: Option<String>,
    pub v_int: Option<i64>,
    pub v_num: Option<f64>,
}

pub fn normalize_decimal(s: &str) -> Option<String> {
    let t: String = s.trim().replace(',', "");
    if t.is_empty() {
        return None;
    }
    let (neg, body) = match t.strip_prefix('-') {
        Some(b) => (true, b.to_string()),
        None => (false, t.trim_start_matches('+').to_string()),
    };
    let mut parts = body.splitn(2, '.');
    let ip = parts.next().unwrap_or("");
    let fp = parts.next().unwrap_or("");
    if (ip.is_empty() && fp.is_empty()) || !ip.chars().all(|c| c.is_ascii_digit()) || !fp.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let ip = ip.trim_start_matches('0');
    let ip = if ip.is_empty() { "0" } else { ip };
    let fp = fp.trim_end_matches('0');
    let mut out = String::new();
    if neg && !(ip == "0" && fp.is_empty()) {
        out.push('-');
    }
    out.push_str(ip);
    if !fp.is_empty() {
        out.push('.');
        out.push_str(fp);
    }
    Some(out)
}

pub fn to_stored(def: &FieldDef, v: &Value) -> Result<Option<Stored>> {
    let empty = matches!(v, Value::Null) || v.as_str().is_some_and(|s| s.trim().is_empty());
    if empty {
        return Ok(None);
    }
    let bad = || Error::User(format!("\"{}\" has a value that does not fit its type ({})", def.name, def.kind));
    let s = match def.kind.as_str() {
        "text" | "longtext" => Stored { v_text: Some(as_text(v)), v_int: None, v_num: None },
        "choice" => {
            let t = as_text(v);
            let canon = def.options.iter().find(|o| o.eq_ignore_ascii_case(t.trim())).cloned();
            match canon {
                Some(c) => Stored { v_text: Some(c), v_int: None, v_num: None },
                None => return user(format!("\"{t}\" is not one of the choices for \"{}\"", def.name)),
            }
        }
        "int" => {
            let n = match v {
                Value::Number(n) => n.as_i64().ok_or_else(bad)?,
                Value::String(s) => s.trim().replace(',', "").parse::<i64>().map_err(|_| bad())?,
                _ => return Err(bad()),
            };
            Stored { v_text: None, v_int: Some(n), v_num: Some(n as f64) }
        }
        "money" => {
            let n = match v {
                Value::Number(n) => n.as_i64().ok_or_else(bad)?,
                Value::String(s) => s.trim().parse::<i64>().map_err(|_| bad())?,
                _ => return Err(bad()),
            };
            Stored { v_text: None, v_int: Some(n), v_num: Some(n as f64) }
        }
        "decimal" => {
            let raw = match v {
                Value::Number(n) => n.to_string(),
                Value::String(s) => s.clone(),
                _ => return Err(bad()),
            };
            let d = normalize_decimal(&raw).ok_or_else(bad)?;
            let num: f64 = d.parse().map_err(|_| bad())?;
            Stored { v_text: Some(d), v_int: None, v_num: Some(num) }
        }
        "date" => Stored { v_text: Some(check_date(&as_text(v))?), v_int: None, v_num: None },
        "bool" => {
            let b = match v {
                Value::Bool(b) => *b,
                Value::Number(n) => n.as_i64() == Some(1),
                Value::String(s) => matches!(s.to_lowercase().as_str(), "yes" | "true" | "1"),
                _ => return Err(bad()),
            };
            Stored { v_text: None, v_int: Some(b as i64), v_num: Some(b as i64 as f64) }
        }
        _ => return Err(bad()),
    };
    Ok(Some(s))
}

fn as_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub fn from_stored(kind: &str, t: Option<String>, i: Option<i64>) -> Value {
    match kind {
        "int" | "money" => i.map(Value::from).unwrap_or(Value::Null),
        "bool" => i.map(|x| Value::Bool(x == 1)).unwrap_or(Value::Null),
        _ => t.map(Value::String).unwrap_or(Value::Null),
    }
}

pub fn display_value(def: &FieldDef, v: &Value, money: &dyn Fn(i64) -> String) -> String {
    let base = match (def.kind.as_str(), v) {
        (_, Value::Null) => return String::new(),
        ("bool", Value::Bool(b)) => if *b { "Yes".into() } else { "No".into() },
        ("money", Value::Number(n)) => money(n.as_i64().unwrap_or(0)),
        (_, Value::String(s)) => s.clone(),
        (_, other) => other.to_string(),
    };
    if def.unit.is_empty() || def.kind == "money" { base } else { format!("{base} {}", def.unit) }
}

fn write_value(conn: &Connection, item_id: i64, def: &FieldDef, v: &Value) -> Result<Option<(Value, Value)>> {
    let old: Option<(Option<String>, Option<i64>)> = conn
        .query_row("SELECT v_text, v_int FROM item_values WHERE item_id=?1 AND field_id=?2", params![item_id, def.id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let old_v = old.clone().map(|(t, i)| from_stored(&def.kind, t, i)).unwrap_or(Value::Null);
    let st = to_stored(def, v)?;
    let new_v = st.as_ref().map(|s| from_stored(&def.kind, s.v_text.clone(), s.v_int)).unwrap_or(Value::Null);
    if old_v == new_v {
        return Ok(None);
    }
    let (t, i, n) = match st {
        Some(s) => (s.v_text, s.v_int, s.v_num),
        None => (None, None, None),
    };
    conn.execute(
        "INSERT INTO item_values(item_id,field_id,v_text,v_int,v_num,updated_at) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(item_id,field_id) DO UPDATE SET v_text=excluded.v_text, v_int=excluded.v_int, v_num=excluded.v_num, updated_at=excluded.updated_at",
        params![item_id, def.id, t, i, n, now_iso()],
    )?;
    Ok(Some((old_v, new_v)))
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct PhotoRef {
    pub file: String,
    pub sha256: String,
    pub bytes: i64,
    #[serde(default)]
    pub original_name: String,
}

#[derive(Deserialize, Debug, Default)]
pub struct ItemInput {
    #[serde(default)]
    pub id: Option<i64>,
    pub category_id: i64,
    pub name: String,
    #[serde(default)]
    pub tracking: Option<String>,
    #[serde(default)]
    pub identifier: String,
    #[serde(default)]
    pub sale_price: Option<i64>,
    #[serde(default)]
    pub reorder_level: Option<i64>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub values: Map<String, Value>,
    #[serde(default)]
    pub new_fields: Vec<NewItemField>,
    #[serde(default)]
    pub add_photos: Vec<PhotoRef>,
    #[serde(default)]
    pub archive_photo_ids: Vec<i64>,
    #[serde(default)]
    pub photo_order: Vec<i64>,
}

#[derive(Deserialize, Debug)]
pub struct NewItemField {
    pub key: String,
    #[serde(flatten)]
    pub def: FieldDef,
}

pub fn item_save(conn: &Connection, input: &ItemInput) -> Result<i64> {
    if !input.archive_photo_ids.is_empty() {
        return user("Photos cannot be removed once saved");
    }
    let name = clean(&input.name);
    if name.is_empty() {
        return user("Please type the item name");
    }
    let cat_ok: Option<bool> = conn
        .query_row("SELECT archived_at IS NULL FROM categories WHERE id=?1", [input.category_id], |r| r.get(0))
        .optional()?;
    if cat_ok.is_none() {
        return user("Please choose a category");
    }
    let identifier = clean(&input.identifier);
    let now = now_iso();
    let (id, is_new, before) = match input.id {
        None => {
            let tracking = input.tracking.clone().unwrap_or_else(|| "quantity".into());
            if tracking != "unique" && tracking != "quantity" {
                return user("Tracking must be unique or quantity");
            }
            if tracking == "unique" {
                check_identifier_free(conn, &identifier, None)?;
            }
            if input.sale_price.is_some_and(|p| p < 0) {
                return user("Selling price cannot be negative");
            }
            conn.execute(
                "INSERT INTO items(category_id,name,identifier,tracking,sale_price,reorder_level,notes,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)",
                params![input.category_id, name, identifier, tracking, input.sale_price, input.reorder_level, input.notes, now],
            )?;
            (conn.last_insert_rowid(), true, Value::Null)
        }
        Some(id) => {
            let before = item_row(conn, id)?;
            if before["tracking"] == "unique" {
                check_identifier_free(conn, &identifier, Some(id))?;
            }
            conn.execute(
                "UPDATE items SET category_id=?1, name=?2, identifier=?3, sale_price=?4, reorder_level=?5, notes=?6, updated_at=?7 WHERE id=?8",
                params![input.category_id, name, identifier, input.sale_price, input.reorder_level, input.notes, now, id],
            )?;
            (id, false, before)
        }
    };

    let mut key_to_id: HashMap<String, i64> = HashMap::new();
    for nf in &input.new_fields {
        let mut d = nf.def.clone();
        d.item_id = Some(id);
        d.category_id = None;
        let f = field_create(conn, &d)?;
        key_to_id.insert(nf.key.clone(), f.id);
    }

    let mut changes = Map::new();
    for (k, v) in &input.values {
        let fid = if let Some(rest) = k.strip_prefix("new:") {
            match key_to_id.get(rest) {
                Some(i) => *i,
                None => continue,
            }
        } else {
            match k.parse::<i64>() {
                Ok(i) => i,
                Err(_) => continue,
            }
        };
        let def = field_get(conn, fid)?;
        let in_scope = def.category_id == Some(input.category_id) || def.item_id == Some(id) || has_value(conn, id, fid)?;
        if !in_scope {
            continue;
        }
        if let Some((from, to)) = write_value(conn, id, &def, v)? {
            changes.insert(def.name.clone(), json!({ "field_id": fid, "from": from, "to": to }));
        }
    }

    let scope = field_list(conn, Some(input.category_id), Some(id), false)?;
    let missing: Vec<String> = scope
        .iter()
        .filter(|f| f.required)
        .filter(|f| !has_value(conn, id, f.id).unwrap_or(false))
        .map(|f| f.name.clone())
        .collect();
    if !missing.is_empty() {
        return user(format!("Please fill in: {}", missing.join(", ")));
    }

    let mut next_order: i64 = conn.query_row("SELECT COALESCE(MAX(sort_order),0)+1 FROM photos WHERE item_id=?1", [id], |r| r.get(0))?;
    for p in &input.add_photos {
        conn.execute(
            "INSERT INTO photos(item_id,file,sha256,bytes,original_name,sort_order,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![id, p.file, p.sha256, p.bytes, p.original_name, next_order, now],
        )?;
        next_order += 1;
        changes.insert(format!("photo added {}", next_order), json!({ "file": p.file, "original_name": p.original_name }));
    }
    for (i, pid) in input.photo_order.iter().enumerate() {
        conn.execute("UPDATE photos SET sort_order=?1 WHERE id=?2 AND item_id=?3", params![i as i64 + 1, pid, id])?;
    }

    let after = item_row(conn, id)?;
    if is_new {
        audit(conn, "item", Some(id), "create", &json!({ "item": after, "values": changes }))?;
    } else {
        let mut diff = Map::new();
        for k in ["category_id", "name", "identifier", "sale_price", "reorder_level", "notes"] {
            if before[k] != after[k] {
                diff.insert(k.into(), json!({ "from": before[k], "to": after[k] }));
            }
        }
        if !diff.is_empty() || !changes.is_empty() {
            audit(conn, "item", Some(id), "update", &json!({ "item": diff, "values": changes }))?;
        }
    }
    Ok(id)
}

fn check_identifier_free(conn: &Connection, identifier: &str, except: Option<i64>) -> Result<()> {
    if identifier.is_empty() {
        return user("A unique item needs its own number (for example a chassis or serial number)");
    }
    if let Some((n, num)) = identifier_owner(conn, identifier, except)? {
        return user(format!("Chassis / serial number {identifier} is already used by \"{n}\" ({num}). Each one must be different."));
    }
    Ok(())
}

pub fn identifier_key(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_uppercase()).collect()
}

pub fn identifier_owner(conn: &Connection, identifier: &str, except: Option<i64>) -> Result<Option<(String, String)>> {
    let key = identifier_key(identifier);
    if key.is_empty() {
        return Ok(None);
    }
    let mut st = conn.prepare("SELECT id, name, identifier FROM items WHERE tracking='unique' AND identifier <> ''")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    for row in rows {
        let (id, name, ident) = row?;
        if Some(id) != except && identifier_key(&ident) == key {
            return Ok(Some((name, ident)));
        }
    }
    Ok(None)
}

fn has_value(conn: &Connection, item_id: i64, field_id: i64) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM item_values WHERE item_id=?1 AND field_id=?2 AND (v_text IS NOT NULL OR v_int IS NOT NULL OR v_num IS NOT NULL)",
            params![item_id, field_id],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false))
}

pub fn item_row(conn: &Connection, id: i64) -> Result<Value> {
    conn.query_row(
        "SELECT i.id, i.category_id, c.name, i.name, i.identifier, i.tracking, i.sale_price, i.reorder_level, i.notes, i.created_at, i.updated_at, i.archived_at, c.archived_at IS NOT NULL, i.condition
         FROM items i JOIN categories c ON c.id=i.category_id WHERE i.id=?1",
        [id],
        |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?, "category_id": r.get::<_, i64>(1)?, "category_name": r.get::<_, String>(2)?,
                "name": r.get::<_, String>(3)?, "identifier": r.get::<_, String>(4)?, "tracking": r.get::<_, String>(5)?,
                "sale_price": r.get::<_, Option<i64>>(6)?, "reorder_level": r.get::<_, Option<i64>>(7)?, "notes": r.get::<_, String>(8)?,
                "created_at": r.get::<_, String>(9)?, "updated_at": r.get::<_, String>(10)?,
                "archived": r.get::<_, Option<String>>(11)?.is_some(), "category_archived": r.get::<_, bool>(12)?,
                "condition": r.get::<_, String>(13)?
            }))
        },
    )
    .optional()?
    .ok_or_else(|| Error::NotFound("Item not found".into()))
}

pub fn item_values(conn: &Connection, item_id: i64) -> Result<Map<String, Value>> {
    let mut s = conn.prepare(
        "SELECT v.field_id, f.kind, v.v_text, v.v_int FROM item_values v JOIN field_defs f ON f.id=v.field_id
         WHERE v.item_id=?1 AND (v.v_text IS NOT NULL OR v.v_int IS NOT NULL OR v.v_num IS NOT NULL)",
    )?;
    let rows = s.query_map([item_id], |r| {
        let kind: String = r.get(1)?;
        Ok((r.get::<_, i64>(0)?, from_stored(&kind, r.get(2)?, r.get(3)?)))
    })?;
    let mut m = Map::new();
    for row in rows {
        let (k, v) = row?;
        m.insert(k.to_string(), v);
    }
    Ok(m)
}

pub fn item_photos(conn: &Connection, item_id: i64, include_archived: bool) -> Result<Vec<Value>> {
    let mut s = conn.prepare(
        "SELECT id, file, original_name, sha256, bytes, created_at, archived_at IS NOT NULL FROM photos WHERE item_id=?1 AND (?2 OR archived_at IS NULL) ORDER BY archived_at IS NOT NULL, sort_order, id",
    )?;
    let rows = s.query_map(params![item_id, include_archived], |r| {
        Ok(json!({ "id": r.get::<_, i64>(0)?, "file": r.get::<_, String>(1)?, "original_name": r.get::<_, String>(2)?,
            "sha256": r.get::<_, String>(3)?, "bytes": r.get::<_, i64>(4)?, "created_at": r.get::<_, String>(5)?, "archived": r.get::<_, bool>(6)? }))
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn item_fields(conn: &Connection, item_id: i64, category_id: i64) -> Result<Vec<FieldDef>> {
    let mut fields = field_list(conn, Some(category_id), Some(item_id), true)?;
    let ids: HashSet<i64> = fields.iter().map(|f| f.id).collect();
    let mut s = conn.prepare(&format!(
        "SELECT {FIELD_COLS} FROM field_defs WHERE id IN (SELECT field_id FROM item_values WHERE item_id=?1 AND (v_text IS NOT NULL OR v_int IS NOT NULL OR v_num IS NOT NULL))"
    ))?;
    for f in s.query_map([item_id], field_row)? {
        let f = f?;
        if !ids.contains(&f.id) {
            fields.push(f);
        }
    }
    let vals = item_values(conn, item_id)?;
    fields.retain(|f| !f.archived || vals.contains_key(&f.id.to_string()));
    Ok(fields)
}

pub fn item_set_condition(conn: &Connection, id: i64, condition: &str) -> Result<()> {
    if condition != "good" && condition != "damaged" {
        return user("Condition must be good or damaged");
    }
    let before = item_row(conn, id)?;
    if before["condition"] == condition {
        return Ok(());
    }
    conn.execute("UPDATE items SET condition=?1, updated_at=?2 WHERE id=?3", params![condition, now_iso(), id])?;
    audit(conn, "item", Some(id), if condition == "damaged" { "mark_damaged" } else { "mark_good" }, &json!({ "from": before["condition"], "to": condition }))?;
    Ok(())
}

pub fn item_archive(conn: &Connection, id: i64, archived: bool) -> Result<()> {
    item_row(conn, id)?;
    let at = if archived { Some(now_iso()) } else { None };
    conn.execute("UPDATE items SET archived_at=?1, updated_at=?2 WHERE id=?3", params![at, now_iso(), id])?;
    audit(conn, "item", Some(id), if archived { "archive" } else { "unarchive" }, &json!({}))?;
    Ok(())
}

pub fn history(conn: &Connection, entity: &str, id: i64) -> Result<Vec<Value>> {
    let mut s = conn.prepare("SELECT at, action, detail FROM audit_log WHERE entity=?1 AND entity_id=?2 ORDER BY id DESC")?;
    let rows = s.query_map(params![entity, id], |r| {
        let d: String = r.get(2)?;
        Ok(json!({ "at": r.get::<_, String>(0)?, "action": r.get::<_, String>(1)?, "detail": serde_json::from_str::<Value>(&d).unwrap_or(Value::Null) }))
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub const FIELD_COLS_PUB: &str = FIELD_COLS;

pub fn field_row_pub(r: &Row) -> rusqlite::Result<FieldDef> {
    field_row(r)
}
