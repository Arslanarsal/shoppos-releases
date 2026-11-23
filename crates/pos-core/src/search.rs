use crate::catalog::{display_value, field_get, field_row_pub, from_stored, to_stored, FieldDef};
use crate::error::{user, Result};
use crate::stock::money_fmt_fn;
use crate::util::opt_date;
use rusqlite::types::Value as Sql;
use rusqlite::{params_from_iter, Connection};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize, Default, Debug, Clone)]
pub struct FieldFilter {
    pub field_id: i64,
    #[serde(default = "eq")]
    pub op: String,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub value2: Value,
}

fn eq() -> String {
    "eq".into()
}

#[derive(Deserialize, Default, Debug, Clone)]
pub struct ItemSearch {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub category_id: Option<i64>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub filters: Vec<FieldFilter>,
    #[serde(default)]
    pub purchased_from: Option<String>,
    #[serde(default)]
    pub purchased_to: Option<String>,
    #[serde(default)]
    pub sold_from: Option<String>,
    #[serde(default)]
    pub sold_to: Option<String>,
    #[serde(default)]
    pub as_of: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

const NOT_REVERSED: &str = "NOT EXISTS (SELECT 1 FROM txns r WHERE r.kind='reversal' AND r.related_txn_id=t.id)";

fn field_cond(def: &FieldDef, f: &FieldFilter, args: &mut Vec<Sql>) -> Result<String> {
    let base = format!("EXISTS (SELECT 1 FROM item_values v WHERE v.item_id=i.id AND v.field_id={}", def.id);
    let op = f.op.as_str();
    if op == "is_set" {
        return Ok(format!("{base} AND (v.v_text IS NOT NULL OR v.v_int IS NOT NULL))"));
    }
    if op == "not_set" {
        return Ok(format!("NOT {base} AND (v.v_text IS NOT NULL OR v.v_int IS NOT NULL))"));
    }
    let numeric = matches!(def.kind.as_str(), "int" | "money" | "decimal" | "bool");
    let col = if numeric { "v.v_num" } else { "v.v_text" };
    let conv = |v: &Value| -> Result<Sql> {
        if def.kind == "choice" || def.kind == "text" || def.kind == "longtext" {
            return Ok(Sql::Text(match v {
                Value::String(s) => s.trim().to_string(),
                o => o.to_string(),
            }));
        }
        match to_stored(def, v)? {
            Some(s) => Ok(if numeric { Sql::Real(s.v_num.unwrap_or(0.0)) } else { Sql::Text(s.v_text.unwrap_or_default()) }),
            None => user(format!("Type a value to filter \"{}\"", def.name)),
        }
    };
    let cond = match op {
        "contains" => {
            args.push(Sql::Text(format!("%{}%", f.value.as_str().unwrap_or("").trim())));
            format!("{col} LIKE ? COLLATE NOCASE")
        }
        "eq" => {
            args.push(conv(&f.value)?);
            if numeric { format!("{col} = ?") } else { format!("{col} = ? COLLATE NOCASE") }
        }
        "ne" => {
            args.push(conv(&f.value)?);
            format!("{col} <> ?")
        }
        "gt" | "gte" | "lt" | "lte" => {
            args.push(conv(&f.value)?);
            let sym = match op { "gt" => ">", "gte" => ">=", "lt" => "<", _ => "<=" };
            format!("{col} {sym} ?")
        }
        "between" => {
            args.push(conv(&f.value)?);
            args.push(conv(&f.value2)?);
            format!("{col} BETWEEN ? AND ?")
        }
        other => return user(format!("Unknown filter {other}")),
    };
    Ok(format!("{base} AND {cond})"))
}

pub fn item_search(conn: &Connection, q: &ItemSearch) -> Result<Value> {
    let as_of = opt_date(&q.as_of)?.unwrap_or_else(|| "9999-12-31".into());
    let mut wh: Vec<String> = Vec::new();
    let mut args: Vec<Sql> = vec![Sql::Text(as_of.clone())];
    let text = q.text.trim();
    if !text.is_empty() {
        for word in text.split_whitespace() {
            let like = format!("%{word}%");
            wh.push("(i.name LIKE ? OR i.identifier LIKE ? OR i.notes LIKE ? OR c.name LIKE ? OR EXISTS (SELECT 1 FROM item_values v WHERE v.item_id=i.id AND v.v_text LIKE ?))".into());
            for _ in 0..5 {
                args.push(Sql::Text(like.clone()));
            }
        }
    }
    if let Some(c) = q.category_id {
        wh.push("i.category_id = ?".into());
        args.push(Sql::Integer(c));
    }
    match q.status.as_str() {
        "all" => {}
        "archived" => wh.push("i.archived_at IS NOT NULL".into()),
        "in_stock" => wh.push("i.archived_at IS NULL AND COALESCE(s.q,0) > 0".into()),
        "out_of_stock" => wh.push("i.archived_at IS NULL AND COALESCE(s.q,0) <= 0".into()),
        "low" => wh.push("i.archived_at IS NULL AND i.reorder_level IS NOT NULL AND COALESCE(s.q,0) <= i.reorder_level".into()),
        _ => wh.push("i.archived_at IS NULL".into()),
    }
    for f in &q.filters {
        let def = field_get(conn, f.field_id)?;
        wh.push(field_cond(&def, f, &mut args)?);
    }
    for (kind, from, to) in [("purchase", &q.purchased_from, &q.purchased_to), ("sale", &q.sold_from, &q.sold_to)] {
        let f = opt_date(from)?;
        let t = opt_date(to)?;
        if f.is_some() || t.is_some() {
            wh.push(format!(
                "EXISTS (SELECT 1 FROM txn_lines l JOIN txns t ON t.id=l.txn_id WHERE l.item_id=i.id AND t.kind='{kind}' AND t.business_date BETWEEN ? AND ? AND {NOT_REVERSED})"
            ));
            args.push(Sql::Text(f.unwrap_or_else(|| "0000-01-01".into())));
            args.push(Sql::Text(t.unwrap_or_else(|| "9999-12-31".into())));
        }
    }
    let where_sql = if wh.is_empty() { "1".to_string() } else { wh.join(" AND ") };
    let from_sql = format!(
        "WITH s AS (SELECT item_id, SUM(qty) q, SUM(cost) c FROM stock_moves WHERE business_date <= ? GROUP BY item_id)
         SELECT {{cols}} FROM items i JOIN categories c ON c.id=i.category_id LEFT JOIN s ON s.item_id=i.id WHERE {where_sql}"
    );
    let total: i64 = conn.query_row(&from_sql.replace("{cols}", "COUNT(*)"), params_from_iter(args.iter()), |r| r.get(0))?;
    let limit = q.limit.unwrap_or(100).clamp(1, 100_000);
    let offset = q.offset.unwrap_or(0).max(0);
    let sql = format!(
        "{} ORDER BY i.name COLLATE NOCASE, i.id LIMIT {limit} OFFSET {offset}",
        from_sql.replace(
            "{cols}",
            "i.id, i.name, i.identifier, i.tracking, i.category_id, c.name, COALESCE(s.q,0), COALESCE(s.c,0), i.archived_at IS NOT NULL, i.sale_price, i.reorder_level,
             (SELECT file FROM photos p WHERE p.item_id=i.id AND p.archived_at IS NULL ORDER BY p.sort_order, p.id LIMIT 1)"
        )
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows: Vec<Value> = stmt
        .query_map(params_from_iter(args.iter()), |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?, "identifier": r.get::<_, String>(2)?,
                "tracking": r.get::<_, String>(3)?, "category_id": r.get::<_, i64>(4)?, "category_name": r.get::<_, String>(5)?,
                "stock": r.get::<_, i64>(6)?, "stock_value": r.get::<_, i64>(7)?, "archived": r.get::<_, bool>(8)?,
                "sale_price": r.get::<_, Option<i64>>(9)?, "reorder_level": r.get::<_, Option<i64>>(10)?, "photo": r.get::<_, Option<String>>(11)?
            }))
        })?
        .collect::<std::result::Result<_, _>>()?;

    let list_fields = list_fields(conn, q.category_id)?;
    if !list_fields.is_empty() && !rows.is_empty() {
        let ids: Vec<String> = rows.iter().map(|r| r["id"].to_string()).collect();
        let fids: Vec<String> = list_fields.iter().map(|f| f.id.to_string()).collect();
        let money = money_fmt_fn(conn)?;
        let mut s = conn.prepare(&format!(
            "SELECT item_id, field_id, v_text, v_int FROM item_values WHERE item_id IN ({}) AND field_id IN ({})",
            ids.join(","),
            fids.join(",")
        ))?;
        let vals: Vec<(i64, i64, Option<String>, Option<i64>)> =
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<std::result::Result<_, _>>()?;
        for row in rows.iter_mut() {
            row["fields"] = json!({});
        }
        for (iid, fid, t, i) in vals {
            if let Some(def) = list_fields.iter().find(|f| f.id == fid) {
                let v = from_stored(&def.kind, t, i);
                if let Some(row) = rows.iter_mut().find(|r| r["id"].as_i64() == Some(iid)) {
                    row["fields"][fid.to_string()] = json!(display_value(def, &v, &money));
                }
            }
        }
    }
    Ok(json!({ "total": total, "rows": rows, "list_fields": list_fields, "as_of": if as_of == "9999-12-31" { Value::Null } else { json!(as_of) } }))
}

fn list_fields(conn: &Connection, category_id: Option<i64>) -> Result<Vec<FieldDef>> {
    let sql = format!(
        "SELECT {} FROM field_defs WHERE show_in_list=1 AND archived_at IS NULL AND item_id IS NULL AND (?1 IS NULL OR category_id=?1) ORDER BY category_id, sort_order, id",
        crate::catalog::FIELD_COLS_PUB
    );
    let mut s = conn.prepare(&sql)?;
    let rows = s.query_map([category_id], field_row_pub)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[derive(Deserialize, Default, Debug, Clone)]
pub struct LineSearch {
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub category_id: Option<i64>,
    #[serde(default)]
    pub item_id: Option<i64>,
    #[serde(default)]
    pub txn_id: Option<i64>,
    #[serde(default)]
    pub hide_reversed: bool,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

pub fn kinds_sql(kinds: &[String]) -> String {
    let mut parts = Vec::new();
    for k in kinds {
        let k = k.as_str();
        match k.split_once(':') {
            Some(("reversal", rk)) if is_kind(rk) => parts.push(format!("(t.kind='reversal' AND t.related_kind='{rk}')")),
            None if is_kind(k) || k == "reversal" => parts.push(format!("t.kind='{k}'")),
            _ => {}
        }
    }
    if parts.is_empty() { "1".into() } else { format!("({})", parts.join(" OR ")) }
}

fn is_kind(k: &str) -> bool {
    matches!(k, "purchase" | "sale" | "return" | "adjustment")
}

pub fn line_search(conn: &Connection, q: &LineSearch) -> Result<Value> {
    let mut wh = vec![kinds_sql(&q.kinds)];
    let mut args: Vec<Sql> = Vec::new();
    if let Some(f) = opt_date(&q.from)? {
        wh.push("t.business_date >= ?".into());
        args.push(Sql::Text(f));
    }
    if let Some(t) = opt_date(&q.to)? {
        wh.push("t.business_date <= ?".into());
        args.push(Sql::Text(t));
    }
    if let Some(c) = q.category_id {
        wh.push("i.category_id = ?".into());
        args.push(Sql::Integer(c));
    }
    if let Some(it) = q.item_id {
        wh.push("l.item_id = ?".into());
        args.push(Sql::Integer(it));
    }
    if let Some(tid) = q.txn_id {
        wh.push("t.id = ?".into());
        args.push(Sql::Integer(tid));
    }
    if q.hide_reversed {
        wh.push(format!("t.kind <> 'reversal' AND {NOT_REVERSED}"));
    }
    for word in q.text.split_whitespace() {
        let like = format!("%{word}%");
        wh.push("(i.name LIKE ? OR l.description LIKE ? OR i.identifier LIKE ? OR t.number LIKE ? OR t.party LIKE ? OR t.notes LIKE ?)".into());
        for _ in 0..6 {
            args.push(Sql::Text(like.clone()));
        }
    }
    let base = format!(
        "FROM txn_lines l JOIN txns t ON t.id=l.txn_id JOIN items i ON i.id=l.item_id JOIN categories c ON c.id=i.category_id WHERE {}",
        wh.join(" AND ")
    );
    let (count, qty, net, cost): (i64, i64, i64, i64) = conn.query_row(
        &format!("SELECT COUNT(*), COALESCE(SUM(l.qty),0), COALESCE(SUM(l.net),0), COALESCE(SUM(l.cost),0) {base}"),
        params_from_iter(args.iter()),
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let limit = q.limit.unwrap_or(200).clamp(1, 1_000_000);
    let offset = q.offset.unwrap_or(0).max(0);
    let mut s = conn.prepare(&format!(
        "SELECT t.id, t.number, t.kind, t.related_kind, t.business_date, t.party, l.item_id, i.name, l.description, i.identifier, c.name,
                l.qty, l.direction, l.unit_price, l.line_discount + l.alloc_discount, l.net, l.cost, t.reason,
                (SELECT r.number FROM txns r WHERE r.kind='reversal' AND r.related_txn_id=t.id), l.id
         {base} ORDER BY t.business_date DESC, t.id DESC, l.line_no LIMIT {limit} OFFSET {offset}"
    ))?;
    let rows: Vec<Value> = s
        .query_map(params_from_iter(args.iter()), |r| {
            Ok(json!({
                "txn_id": r.get::<_, i64>(0)?, "number": r.get::<_, String>(1)?, "kind": r.get::<_, String>(2)?,
                "related_kind": r.get::<_, Option<String>>(3)?, "business_date": r.get::<_, String>(4)?, "party": r.get::<_, String>(5)?,
                "item_id": r.get::<_, i64>(6)?, "item_name": r.get::<_, String>(7)?, "description": r.get::<_, String>(8)?,
                "identifier": r.get::<_, String>(9)?, "category_name": r.get::<_, String>(10)?, "qty": r.get::<_, i64>(11)?,
                "direction": r.get::<_, i64>(12)?, "unit_price": r.get::<_, i64>(13)?, "discount": r.get::<_, i64>(14)?,
                "net": r.get::<_, i64>(15)?, "cost": r.get::<_, i64>(16)?, "reason": r.get::<_, String>(17)?,
                "reversed_by": r.get::<_, Option<String>>(18)?, "line_id": r.get::<_, i64>(19)?
            }))
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(json!({ "total": count, "sum_qty": qty, "sum_net": net, "sum_cost": cost, "rows": rows }))
}

pub fn csv_escape(s: &str) -> String {
    let s = if s.starts_with(['=', '+', '-', '@']) && s.parse::<f64>().is_err() { format!("'{s}") } else { s.to_string() };
    if s.contains([',', '"', '\n', '\r']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s }
}

pub fn money_plain(c: i64) -> String {
    let neg = c < 0;
    let a = c.unsigned_abs();
    format!("{}{}.{:02}", if neg { "-" } else { "" }, a / 100, a % 100)
}

pub fn csv(rows: &[Vec<String>]) -> String {
    let mut out = String::from("\u{feff}");
    for r in rows {
        out.push_str(&r.iter().map(|c| csv_escape(c)).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    out
}

pub fn items_csv(conn: &Connection, q: &ItemSearch) -> Result<String> {
    let mut q = q.clone();
    q.limit = Some(100_000);
    q.offset = Some(0);
    let res = item_search(conn, &q)?;
    let all_defs: Vec<FieldDef> = match q.category_id {
        Some(c) => crate::catalog::field_list(conn, Some(c), None, true)?,
        None => Vec::new(),
    };
    let money = money_fmt_fn(conn)?;
    let mut header: Vec<String> = ["Item ID", "Name", "Number", "Category", "Tracking", "In stock", "Stock value", "Selling price", "Archived"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    header.extend(all_defs.iter().map(|d| if d.unit.is_empty() { d.name.clone() } else { format!("{} ({})", d.name, d.unit) }));
    let mut out = vec![header];
    for r in res["rows"].as_array().unwrap() {
        let id = r["id"].as_i64().unwrap_or(0);
        let mut row = vec![
            id.to_string(),
            r["name"].as_str().unwrap_or("").into(),
            r["identifier"].as_str().unwrap_or("").into(),
            r["category_name"].as_str().unwrap_or("").into(),
            r["tracking"].as_str().unwrap_or("").into(),
            r["stock"].to_string(),
            money_plain(r["stock_value"].as_i64().unwrap_or(0)),
            r["sale_price"].as_i64().map(money_plain).unwrap_or_default(),
            if r["archived"].as_bool() == Some(true) { "yes".into() } else { "".into() },
        ];
        if !all_defs.is_empty() {
            let vals = crate::catalog::item_values(conn, id)?;
            for d in &all_defs {
                let v = vals.get(&d.id.to_string()).cloned().unwrap_or(Value::Null);
                let s = match (d.kind.as_str(), &v) {
                    ("money", Value::Number(n)) => money_plain(n.as_i64().unwrap_or(0)),
                    _ => {
                        let mut dd = d.clone();
                        dd.unit = String::new();
                        display_value(&dd, &v, &money)
                    }
                };
                row.push(s);
            }
        }
        out.push(row);
    }
    Ok(csv(&out))
}

pub fn lines_csv(conn: &Connection, q: &LineSearch) -> Result<String> {
    let mut q = q.clone();
    q.limit = Some(1_000_000);
    q.offset = Some(0);
    let res = line_search(conn, &q)?;
    let mut out = vec![["Date", "Number", "Type", "Reverses", "Customer or supplier", "Item", "Description", "Number on item", "Category", "Quantity", "Stock in/out", "Unit price", "Discount", "Amount", "Cost", "Reason", "Reversed by"]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()];
    for r in res["rows"].as_array().unwrap() {
        let s = |k: &str| r[k].as_str().unwrap_or("").to_string();
        out.push(vec![
            s("business_date"), s("number"), s("kind"), s("related_kind"), s("party"), s("item_name"), s("description"), s("identifier"),
            s("category_name"), r["qty"].to_string(), if r["direction"].as_i64() == Some(1) { "in".into() } else { "out".into() },
            money_plain(r["unit_price"].as_i64().unwrap_or(0)), money_plain(r["discount"].as_i64().unwrap_or(0)),
            money_plain(r["net"].as_i64().unwrap_or(0)), money_plain(r["cost"].as_i64().unwrap_or(0)), s("reason"), s("reversed_by"),
        ]);
    }
    Ok(csv(&out))
}

pub fn values_map_to_display(conn: &Connection, defs: &[FieldDef], vals: &Map<String, Value>) -> Result<Vec<Value>> {
    let money = money_fmt_fn(conn)?;
    Ok(defs
        .iter()
        .filter_map(|d| vals.get(&d.id.to_string()).map(|v| json!({ "name": d.name, "value": display_value(d, v, &money) })))
        .collect())
}
