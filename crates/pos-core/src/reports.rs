use crate::error::{user, Result};
use crate::search::{csv, money_plain};
use crate::util::check_date;
use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize, Debug, Clone, Default)]
pub struct PeriodInput {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub category_id: Option<i64>,
}

pub fn figures(conn: &Connection, from: &str, to: &str, category_id: Option<i64>) -> Result<Value> {
    let from = check_date(from)?;
    let to = check_date(to)?;
    if from > to {
        return user("The start date is after the end date");
    }
    let mut s = conn.prepare(
        "SELECT t.kind, COALESCE(t.related_kind,''), l.direction, SUM(l.qty), SUM(l.net), SUM(l.cost), COUNT(DISTINCT t.id)
         FROM txn_lines l JOIN txns t ON t.id=l.txn_id JOIN items i ON i.id=l.item_id
         WHERE t.business_date BETWEEN ?1 AND ?2 AND (?3 IS NULL OR i.category_id=?3)
         GROUP BY t.kind, t.related_kind, l.direction",
    )?;
    let rows: Vec<(String, String, i64, i64, i64, i64, i64)> = s
        .query_map(params![from, to, category_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let (mut qp, mut sp, mut qs, mut rev, mut qr, mut refunds, mut cogs, mut adj_in, mut adj_out, mut sales_count) = (0i64, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    for (kind, rk, dir, q, net, cost, n) in rows {
        match (kind.as_str(), rk.as_str()) {
            ("purchase", _) => { qp += q; sp += net; }
            ("reversal", "purchase") => { qp -= q; sp -= net; }
            ("sale", _) => { qs += q; rev += net; cogs += cost; sales_count += n; }
            ("return", _) => { qr += q; refunds += net; cogs -= cost; }
            ("reversal", "sale") => { qr += q; refunds += net; cogs -= cost; }
            ("reversal", "return") => { qr -= q; refunds -= net; cogs += cost; }
            ("adjustment", _) => { if dir == 1 { adj_in += cost } else { adj_out += cost } }
            ("reversal", "adjustment") => { if dir == 1 { adj_out -= cost } else { adj_in -= cost } }
            _ => {}
        }
    }
    let (stock_qty, stock_value): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(m.qty),0), COALESCE(SUM(m.cost),0) FROM stock_moves m JOIN items i ON i.id=m.item_id
         WHERE m.business_date <= ?1 AND (?2 IS NULL OR i.category_id=?2)",
        params![to, category_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let net_sales = rev - refunds;
    Ok(json!({
        "from": from, "to": to, "category_id": category_id,
        "qty_purchased": qp, "purchase_spend": sp,
        "qty_sold": qs, "sales_revenue": rev, "sales_count": sales_count,
        "qty_refunded": qr, "refunds": refunds, "net_sales": net_sales,
        "cogs": cogs, "gross_profit": net_sales - cogs,
        "adjust_in_value": adj_in, "adjust_out_value": adj_out,
        "stock_qty": stock_qty, "stock_value": stock_value,
        "costing_method": "FIFO"
    }))
}

pub fn month_ranges(from: &str, to: &str) -> Result<Vec<(String, String, String)>> {
    let f = NaiveDate::parse_from_str(&check_date(from)?, "%Y-%m-%d").unwrap();
    let t = NaiveDate::parse_from_str(&check_date(to)?, "%Y-%m-%d").unwrap();
    if f > t {
        return user("The start date is after the end date");
    }
    let mut out = Vec::new();
    let mut y = f.year();
    let mut m = f.month();
    loop {
        let start = NaiveDate::from_ymd_opt(y, m, 1).unwrap();
        let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
        let end = NaiveDate::from_ymd_opt(ny, nm, 1).unwrap().pred_opt().unwrap();
        let s = start.max(f);
        let e = end.min(t);
        out.push((start.format("%Y-%m").to_string(), s.format("%Y-%m-%d").to_string(), e.format("%Y-%m-%d").to_string()));
        if end >= t || out.len() > 1200 {
            break;
        }
        y = ny;
        m = nm;
    }
    Ok(out)
}

pub fn monthly(conn: &Connection, p: &PeriodInput) -> Result<Value> {
    let mut rows = Vec::new();
    for (label, s, e) in month_ranges(&p.from, &p.to)? {
        let mut f = figures(conn, &s, &e, p.category_id)?;
        f["month"] = json!(label);
        rows.push(f);
    }
    let total = figures(conn, &p.from, &p.to, p.category_id)?;
    Ok(json!({ "months": rows, "total": total }))
}

pub fn stock_report(conn: &Connection, as_of: &str, category_id: Option<i64>, include_zero: bool) -> Result<Value> {
    let d = check_date(as_of)?;
    let mut s = conn.prepare(
        "SELECT i.id, i.name, i.identifier, c.name, i.tracking, COALESCE(SUM(m.qty),0) q, COALESCE(SUM(m.cost),0), i.archived_at IS NOT NULL
         FROM items i JOIN categories c ON c.id=i.category_id LEFT JOIN stock_moves m ON m.item_id=i.id AND m.business_date<=?1
         WHERE (?2 IS NULL OR i.category_id=?2) GROUP BY i.id HAVING (?3 OR q<>0) ORDER BY c.name COLLATE NOCASE, i.name COLLATE NOCASE",
    )?;
    let rows: Vec<Value> = s
        .query_map(params![d, category_id, include_zero], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?, "identifier": r.get::<_, String>(2)?,
                "category_name": r.get::<_, String>(3)?, "tracking": r.get::<_, String>(4)?, "qty": r.get::<_, i64>(5)?,
                "value": r.get::<_, i64>(6)?, "archived": r.get::<_, bool>(7)?
            }))
        })?
        .collect::<std::result::Result<_, _>>()?;
    let qty: i64 = rows.iter().map(|r| r["qty"].as_i64().unwrap_or(0)).sum();
    let value: i64 = rows.iter().map(|r| r["value"].as_i64().unwrap_or(0)).sum();
    Ok(json!({ "as_of": d, "rows": rows, "qty": qty, "value": value }))
}

pub fn monthly_csv(conn: &Connection, p: &PeriodInput) -> Result<String> {
    let m = monthly(conn, p)?;
    let mut out = vec![[
        "Month", "From", "To", "Qty purchased", "Purchase spend", "Qty sold", "Sales revenue", "Qty returned", "Refunds", "Net sales",
        "Cost of goods sold", "Gross profit", "Stock qty at end", "Stock value at end",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect::<Vec<_>>()];
    let mut push = |label: String, f: &Value| {
        let n = |k: &str| f[k].as_i64().unwrap_or(0);
        out.push(vec![
            label, f["from"].as_str().unwrap_or("").into(), f["to"].as_str().unwrap_or("").into(),
            n("qty_purchased").to_string(), money_plain(n("purchase_spend")), n("qty_sold").to_string(), money_plain(n("sales_revenue")),
            n("qty_refunded").to_string(), money_plain(n("refunds")), money_plain(n("net_sales")), money_plain(n("cogs")),
            money_plain(n("gross_profit")), n("stock_qty").to_string(), money_plain(n("stock_value")),
        ]);
    };
    for f in m["months"].as_array().unwrap() {
        push(f["month"].as_str().unwrap_or("").to_string(), f);
    }
    push("TOTAL".into(), &m["total"]);
    Ok(csv(&out))
}

pub fn stock_csv(conn: &Connection, as_of: &str, category_id: Option<i64>) -> Result<String> {
    let r = stock_report(conn, as_of, category_id, false)?;
    let mut out = vec![vec!["Item ID".to_string(), "Item".into(), "Number".into(), "Category".into(), "Quantity".into(), "Cost value".into()]];
    for x in r["rows"].as_array().unwrap() {
        out.push(vec![
            x["id"].to_string(), x["name"].as_str().unwrap_or("").into(), x["identifier"].as_str().unwrap_or("").into(),
            x["category_name"].as_str().unwrap_or("").into(), x["qty"].to_string(), money_plain(x["value"].as_i64().unwrap_or(0)),
        ]);
    }
    Ok(csv(&out))
}

pub fn dashboard(conn: &Connection, today: &str) -> Result<Value> {
    let month_start = format!("{}-01", &today[..7]);
    let t = figures(conn, today, today, None)?;
    let m = figures(conn, &month_start, today, None)?;
    let low: i64 = conn.query_row(
        "SELECT COUNT(*) FROM items i WHERE i.archived_at IS NULL AND i.reorder_level IS NOT NULL AND (SELECT COALESCE(SUM(qty),0) FROM stock_moves m WHERE m.item_id=i.id) <= i.reorder_level",
        [],
        |r| r.get(0),
    )?;
    let items: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE archived_at IS NULL", [], |r| r.get(0))?;
    let recent: Vec<Value> = conn
        .prepare("SELECT id, number, kind, related_kind, business_date, party, total FROM txns ORDER BY id DESC LIMIT 8")?
        .query_map([], |r| {
            Ok(json!({ "id": r.get::<_, i64>(0)?, "number": r.get::<_, String>(1)?, "kind": r.get::<_, String>(2)?, "related_kind": r.get::<_, Option<String>>(3)?,
                "business_date": r.get::<_, String>(4)?, "party": r.get::<_, String>(5)?, "total": r.get::<_, i64>(6)? }))
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(json!({ "today": t, "month": m, "low_stock": low, "item_count": items, "recent": recent }))
}
