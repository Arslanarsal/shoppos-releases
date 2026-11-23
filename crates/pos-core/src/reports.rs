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

const REV: &str = "EXISTS (SELECT 1 FROM txns r WHERE r.kind='reversal' AND r.related_txn_id=t.id)";

pub fn item_fin_cte(period: bool) -> String {
    let filt = if period { "WHERE t.business_date BETWEEN :from AND :to" } else { "" };
    format!(
        "fin AS (SELECT l.item_id,
          SUM(CASE WHEN t.kind='purchase' THEN l.qty WHEN t.kind='reversal' AND t.related_kind='purchase' THEN -l.qty ELSE 0 END) AS bought_qty,
          SUM(CASE WHEN t.kind='purchase' THEN l.net WHEN t.kind='reversal' AND t.related_kind='purchase' THEN -l.net ELSE 0 END) AS bought_cost,
          MIN(CASE WHEN t.kind='purchase' AND NOT {REV} THEN t.business_date END) AS first_bought,
          MAX(CASE WHEN t.kind='purchase' AND NOT {REV} THEN t.business_date END) AS last_bought,
          SUM(CASE WHEN t.kind='sale' THEN l.qty WHEN t.kind='return' THEN -l.qty WHEN t.kind='reversal' AND t.related_kind='sale' THEN -l.qty WHEN t.kind='reversal' AND t.related_kind='return' THEN l.qty ELSE 0 END) AS sold_qty,
          SUM(CASE WHEN t.kind='sale' THEN l.net WHEN t.kind='return' THEN -l.net WHEN t.kind='reversal' AND t.related_kind='sale' THEN -l.net WHEN t.kind='reversal' AND t.related_kind='return' THEN l.net ELSE 0 END) AS revenue,
          SUM(CASE WHEN t.kind='sale' THEN l.cost WHEN t.kind='return' THEN -l.cost WHEN t.kind='reversal' AND t.related_kind='sale' THEN -l.cost WHEN t.kind='reversal' AND t.related_kind='return' THEN l.cost ELSE 0 END) AS sold_cost,
          MAX(CASE WHEN t.kind='sale' AND NOT {REV} THEN t.business_date END) AS last_sold,
          SUM(CASE WHEN t.kind='adjustment' AND l.direction=-1 THEN l.cost WHEN t.kind='reversal' AND t.related_kind='adjustment' AND l.direction=1 THEN -l.cost ELSE 0 END) AS written_off,
          SUM(CASE WHEN t.kind='adjustment' AND l.direction=-1 THEN l.qty WHEN t.kind='reversal' AND t.related_kind='adjustment' AND l.direction=1 THEN -l.qty ELSE 0 END) AS written_off_qty
         FROM txn_lines l JOIN txns t ON t.id=l.txn_id {filt} GROUP BY l.item_id)"
    )
}

pub const STATUS_SQL: &str = "CASE WHEN i.archived_at IS NOT NULL THEN 'inactive' WHEN i.condition='damaged' THEN 'damaged' WHEN COALESCE(s.q,0) > 0 THEN 'in_stock' WHEN COALESCE(f.sold_qty,0) > 0 THEN 'sold' ELSE 'out_of_stock' END";

pub fn fin_json(r: &rusqlite::Row, start: usize) -> rusqlite::Result<Value> {
    let g = |k: usize| -> rusqlite::Result<i64> { Ok(r.get::<_, Option<i64>>(start + k)?.unwrap_or(0)) };
    let bought_qty = g(0)?;
    let bought_cost = g(1)?;
    let revenue = g(5)?;
    let sold_cost = g(6)?;
    let written_off = g(8)?;
    let profit = revenue - sold_cost - written_off;
    Ok(json!({
        "bought_qty": bought_qty, "bought_cost": bought_cost,
        "avg_cost": if bought_qty > 0 { crate::util::mul_div_round(bought_cost, 1, bought_qty) } else { 0 },
        "first_bought": r.get::<_, Option<String>>(start + 2)?, "last_bought": r.get::<_, Option<String>>(start + 3)?,
        "sold_qty": g(4)?, "revenue": revenue, "sold_cost": sold_cost,
        "last_sold": r.get::<_, Option<String>>(start + 7)?, "written_off": written_off, "written_off_qty": g(9)?,
        "profit": profit,
    }))
}

pub const FIN_COLS: &str = "f.bought_qty, f.bought_cost, f.first_bought, f.last_bought, f.sold_qty, f.revenue, f.sold_cost, f.last_sold, f.written_off, f.written_off_qty";

pub fn last_sale_price(conn: &Connection, item_id: i64) -> Result<Option<i64>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(
            &format!("SELECT l.unit_price FROM txn_lines l JOIN txns t ON t.id=l.txn_id WHERE l.item_id=?1 AND t.kind='sale' AND NOT {REV} ORDER BY t.business_date DESC, t.id DESC LIMIT 1"),
            [item_id],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn item_money(conn: &Connection, item_id: i64) -> Result<Value> {
    let sql = format!(
        "WITH {}, s AS (SELECT item_id, SUM(qty) q FROM stock_moves GROUP BY item_id)
         SELECT {FIN_COLS}, {STATUS_SQL} FROM items i LEFT JOIN fin f ON f.item_id=i.id LEFT JOIN s ON s.item_id=i.id WHERE i.id=:id",
        item_fin_cte(false)
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut v = stmt.query_row(rusqlite::named_params! { ":id": item_id }, |r| {
        let mut v = fin_json(r, 0)?;
        v["status"] = json!(r.get::<_, String>(10)?);
        Ok(v)
    })?;
    v["last_sale_price"] = json!(last_sale_price(conn, item_id)?);
    Ok(v)
}

pub fn month_end(conn: &Connection, p: &PeriodInput) -> Result<Value> {
    let base = figures(conn, &p.from, &p.to, p.category_id)?;
    let from = check_date(&p.from)?;
    let to = check_date(&p.to)?;
    let sql = format!(
        "WITH {} SELECT i.id, i.name, i.identifier, c.name, {FIN_COLS} FROM fin f JOIN items i ON i.id=f.item_id JOIN categories c ON c.id=i.category_id
         WHERE (:cat IS NULL OR i.category_id=:cat) AND (f.sold_qty<>0 OR f.revenue<>0 OR f.written_off<>0 OR f.sold_cost<>0)
         ORDER BY i.name COLLATE NOCASE",
        item_fin_cte(true)
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<Value> = stmt
        .query_map(rusqlite::named_params! { ":from": from, ":to": to, ":cat": p.category_id }, |r| {
            let mut v = fin_json(r, 4)?;
            v["id"] = json!(r.get::<_, i64>(0)?);
            v["name"] = json!(r.get::<_, String>(1)?);
            v["identifier"] = json!(r.get::<_, String>(2)?);
            v["category_name"] = json!(r.get::<_, String>(3)?);
            Ok(v)
        })?
        .collect::<std::result::Result<_, _>>()?;
    let mut total_profit = 0i64;
    let mut total_loss = 0i64;
    let mut profit_items = Vec::new();
    let mut loss_items = Vec::new();
    for r in rows {
        let pr = r["profit"].as_i64().unwrap_or(0);
        if pr >= 0 {
            total_profit += pr;
            profit_items.push(r);
        } else {
            total_loss += -pr;
            loss_items.push(r);
        }
    }
    loss_items.sort_by_key(|r| r["profit"].as_i64().unwrap_or(0));
    let mut wo = conn.prepare(
        "SELECT t.id, t.number, t.business_date, t.reason, l.item_id, l.description, l.qty, l.cost,
                EXISTS (SELECT 1 FROM txns r WHERE r.kind='reversal' AND r.related_txn_id=t.id)
         FROM txn_lines l JOIN txns t ON t.id=l.txn_id JOIN items i ON i.id=l.item_id
         WHERE t.kind='adjustment' AND l.direction=-1 AND t.business_date BETWEEN ?1 AND ?2 AND (?3 IS NULL OR i.category_id=?3)
         ORDER BY t.business_date, t.id",
    )?;
    let write_offs: Vec<Value> = wo
        .query_map(params![from, to, p.category_id], |r| {
            Ok(json!({ "txn_id": r.get::<_, i64>(0)?, "number": r.get::<_, String>(1)?, "business_date": r.get::<_, String>(2)?,
                "reason": r.get::<_, String>(3)?, "item_id": r.get::<_, i64>(4)?, "description": r.get::<_, String>(5)?,
                "qty": r.get::<_, i64>(6)?, "cost": r.get::<_, i64>(7)?, "reversed": r.get::<_, bool>(8)? }))
        })?
        .collect::<std::result::Result<_, _>>()?;
    let in_stock_items: i64 = conn.query_row(
        "SELECT COUNT(*) FROM (SELECT m.item_id FROM stock_moves m JOIN items i ON i.id=m.item_id WHERE m.business_date<=?1 AND (?2 IS NULL OR i.category_id=?2) GROUP BY m.item_id HAVING SUM(m.qty)>0)",
        params![to, p.category_id],
        |r| r.get(0),
    )?;
    Ok(json!({
        "from": from, "to": to,
        "sold": { "qty": base["qty_sold"].as_i64().unwrap_or(0) - base["qty_refunded"].as_i64().unwrap_or(0), "net_sales": base["net_sales"], "sales_count": base["sales_count"] },
        "unsold": { "qty": base["stock_qty"], "value": base["stock_value"], "items": in_stock_items },
        "total_profit": total_profit, "total_loss": total_loss, "net_result": total_profit - total_loss,
        "loss_items": loss_items, "profit_items": profit_items, "write_offs": write_offs, "figures": base
    }))
}
