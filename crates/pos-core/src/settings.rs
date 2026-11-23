use crate::error::Result;
use crate::util::now_iso;
use rusqlite::Connection;
use serde_json::{json, Map, Value};

pub fn defaults() -> Value {
    json!({
        "shop_name": "My Shop",
        "shop_logo": "",
        "shop_address": "",
        "shop_phone": "",
        "shop_email": "",
        "currency_symbol": "Rs",
        "currency_code": "PKR",
        "money_decimals": 0,
        "date_format": "DD/MM/YYYY",
        "receipt_header": "",
        "receipt_footer": FOOTER,
        "receipt_show_logo": true,
        "receipt_watermark": true,
        "contacts": [],
        "theme": "light",
        "accent": "#1d4ed8",
        "font_scale": 1.0,
        "backup_dest": "",
        "backup_interval_minutes": 60,
        "costing_method": "FIFO"
    })
}

const ALLOWED: &[&str] = &[
    "shop_name", "shop_logo", "shop_address", "shop_phone", "shop_email", "currency_symbol", "currency_code",
    "money_decimals", "date_format", "receipt_header", "receipt_footer", "receipt_show_logo", "receipt_watermark", "contacts", "theme", "accent",
    "font_scale", "backup_dest", "backup_interval_minutes",
];

pub const OLD_FOOTER: &str = "Thank you for shopping with us";
pub const FOOTER: &str = "Thank you for your business.\nWarranty and free services as per the manufacturer's terms. Please keep this receipt for warranty, registration and service.";

pub fn get_all(conn: &Connection) -> Result<Value> {
    let mut out = defaults();
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let obj = out.as_object_mut().unwrap();
    for row in rows {
        let (k, v) = row?;
        if let Ok(val) = serde_json::from_str::<Value>(&v) {
            if k == "receipt_footer" && val.as_str() == Some(OLD_FOOTER) {
                continue;
            }
            obj.insert(k, val);
        }
    }
    Ok(out)
}

pub fn get(conn: &Connection, key: &str) -> Result<Value> {
    Ok(get_all(conn)?.get(key).cloned().unwrap_or(Value::Null))
}

pub fn set_many(conn: &Connection, values: &Map<String, Value>) -> Result<Value> {
    let before = get_all(conn)?;
    let mut changed = Map::new();
    for (k, v) in values {
        if !ALLOWED.contains(&k.as_str()) {
            continue;
        }
        let v = sanitize(k, v.clone());
        if before.get(k) == Some(&v) {
            continue;
        }
        conn.execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (k, serde_json::to_string(&v)?, now_iso()),
        )?;
        changed.insert(k.clone(), json!({ "from": before.get(k), "to": v }));
    }
    if !changed.is_empty() {
        crate::catalog::audit(conn, "settings", None, "update", &Value::Object(changed))?;
    }
    get_all(conn)
}

fn sanitize(k: &str, v: Value) -> Value {
    match k {
        "money_decimals" => json!(if v.as_i64() == Some(2) || v.as_str() == Some("2") { 2 } else { 0 }),
        "font_scale" => json!(v.as_f64().unwrap_or(1.0).clamp(0.9, 1.5)),
        "backup_interval_minutes" => json!(v.as_i64().unwrap_or(60).clamp(5, 24 * 60)),
        "receipt_show_logo" | "receipt_watermark" => json!(v.as_bool().unwrap_or(true)),
        "contacts" => {
            let rows = v.as_array().cloned().unwrap_or_default();
            let clean = |x: &Value, k: &str| x.get(k).and_then(|s| s.as_str()).unwrap_or("").trim().chars().take(80).collect::<String>();
            Value::Array(
                rows.iter()
                    .map(|r| json!({ "name": clean(r, "name"), "title": clean(r, "title"), "phone": clean(r, "phone") }))
                    .filter(|r| r["name"] != "" || r["title"] != "" || r["phone"] != "")
                    .take(20)
                    .collect(),
            )
        }
        "theme" => json!(if v.as_str() == Some("dark") { "dark" } else { "light" }),
        _ => match v {
            Value::String(s) => Value::String(s.chars().take(2000).collect()),
            Value::Null => Value::String(String::new()),
            other => Value::String(other.to_string()),
        },
    }
}

pub fn receipt_snapshot(conn: &Connection) -> Result<Value> {
    let s = get_all(conn)?;
    let pick = |k: &str| s.get(k).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "shop_name": pick("shop_name"), "shop_logo": pick("shop_logo"), "shop_address": pick("shop_address"),
        "shop_phone": pick("shop_phone"), "shop_email": pick("shop_email"), "currency_symbol": pick("currency_symbol"),
        "money_decimals": pick("money_decimals"), "date_format": pick("date_format"), "receipt_header": pick("receipt_header"),
        "receipt_footer": pick("receipt_footer"), "receipt_show_logo": pick("receipt_show_logo"), "receipt_watermark": pick("receipt_watermark"), "contacts": pick("contacts"), "accent": pick("accent")
    }))
}
