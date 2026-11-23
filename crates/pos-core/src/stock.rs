use crate::catalog::{display_value, field_list, item_row, item_values};
use crate::error::{user, Error, Result};
use crate::settings;
use crate::util::{allocate, check_date, mul_div_round, now_iso};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn fmt_money(cents: i64, decimals: i64, symbol: &str) -> String {
    let neg = cents < 0;
    let a = cents.unsigned_abs();
    let body = if decimals == 2 {
        format!("{}.{:02}", group(a / 100), a % 100)
    } else {
        let whole = (a + 50) / 100;
        group(whole)
    };
    let sign = if neg { "-" } else { "" };
    if symbol.is_empty() { format!("{sign}{body}") } else { format!("{sign}{symbol} {body}") }
}

fn group(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn money_fmt_fn(conn: &Connection) -> Result<impl Fn(i64) -> String> {
    let s = settings::get_all(conn)?;
    let dec = s["money_decimals"].as_i64().unwrap_or(0);
    let sym = s["currency_symbol"].as_str().unwrap_or("").to_string();
    Ok(move |c: i64| fmt_money(c, dec, &sym))
}

#[derive(Debug, Clone)]
struct Lot {
    line_id: i64,
    date: String,
    qty: i64,
    cost: i64,
}

fn lots_open(conn: &Connection, item_id: i64, as_of: &str) -> Result<Vec<Lot>> {
    let mut s = conn.prepare(
        "SELECT lot_line_id, lot_date, SUM(qty), SUM(cost) FROM stock_moves WHERE item_id=?1 AND lot_date<=?2
         GROUP BY lot_line_id HAVING SUM(qty)>0 ORDER BY lot_date, lot_line_id",
    )?;
    let rows = s.query_map(params![item_id, as_of], |r| Ok(Lot { line_id: r.get(0)?, date: r.get(1)?, qty: r.get(2)?, cost: r.get(3)? }))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn lot_remaining(conn: &Connection, lot_line_id: i64) -> Result<(i64, i64)> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(qty),0), COALESCE(SUM(cost),0) FROM stock_moves WHERE lot_line_id=?1",
        [lot_line_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

pub fn stock_on(conn: &Connection, item_id: i64, as_of: Option<&str>) -> Result<(i64, i64)> {
    let d = as_of.unwrap_or("9999-12-31");
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(qty),0), COALESCE(SUM(cost),0) FROM stock_moves WHERE item_id=?1 AND business_date<=?2",
        params![item_id, d],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

pub fn available_on(conn: &Connection, item_id: i64, date: &str) -> Result<i64> {
    let mut s = conn.prepare("SELECT business_date, SUM(qty) FROM stock_moves WHERE item_id=?1 GROUP BY business_date ORDER BY business_date")?;
    let rows: Vec<(String, i64)> = s.query_map([item_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
    let mut bal = 0i64;
    let mut at_date = 0i64;
    let mut min_after: Option<i64> = None;
    for (d, q) in rows {
        bal += q;
        if d.as_str() <= date {
            at_date = bal;
        } else {
            min_after = Some(min_after.map_or(bal, |m| m.min(bal)));
        }
    }
    Ok(match min_after {
        Some(m) => at_date.min(m),
        None => at_date,
    })
}

#[derive(Deserialize, Debug, Clone)]
pub struct LineInput {
    pub item_id: i64,
    pub qty: i64,
    #[serde(default)]
    pub unit_price: i64,
    #[serde(default)]
    pub line_discount: i64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct DocInput {
    pub client_token: String,
    pub business_date: String,
    #[serde(default)]
    pub party: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub discount: i64,
    pub lines: Vec<LineInput>,
    #[serde(default)]
    pub photos: Vec<crate::catalog::PhotoRef>,
    #[serde(default)]
    pub details: Vec<DetailInput>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct DetailInput {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub print: bool,
}

fn insert_txn_details(tx: &Connection, txn_id: i64, details: &[DetailInput]) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    for d in details {
        let (n, v) = (d.name.trim(), d.value.trim());
        if n.is_empty() && v.is_empty() {
            continue;
        }
        if n.is_empty() {
            return user(format!("Give the detail \"{v}\" a name, like Phone or CNIC"));
        }
        if v.is_empty() {
            return user(format!("Type a value for \"{n}\" or take it off"));
        }
        tx.execute("INSERT INTO txn_details(txn_id,name,value,print,created_at) VALUES(?1,?2,?3,?4,?5)", params![txn_id, n, v, d.print as i64, now])?;
    }
    Ok(())
}

pub fn detail_names(conn: &Connection) -> Result<Value> {
    let names: Vec<String> = conn
        .prepare("SELECT name FROM txn_details GROUP BY name COLLATE NOCASE ORDER BY COUNT(*) DESC, MAX(id) DESC LIMIT 50")?
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(json!(names))
}

fn insert_txn_photos(tx: &Connection, txn_id: i64, photos: &[crate::catalog::PhotoRef]) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let start: i64 = tx.query_row("SELECT COUNT(*) FROM txn_photos WHERE txn_id=?1", [txn_id], |r| r.get(0))?;
    for (i, p) in photos.iter().enumerate() {
        if !p.file.starts_with("photos/") || p.file.contains("..") || p.file.contains('\\') {
            return user("A picture could not be attached. Please add it again.");
        }
        tx.execute(
            "INSERT INTO txn_photos(txn_id,file,sha256,bytes,original_name,sort_order,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![txn_id, p.file, p.sha256, p.bytes, p.original_name, start + i as i64, now],
        )?;
    }
    Ok(())
}

fn existing_token(conn: &Connection, token: &str) -> Result<Option<i64>> {
    if token.trim().is_empty() {
        return user("Missing request id");
    }
    Ok(conn.query_row("SELECT id FROM txns WHERE client_token=?1", [token], |r| r.get(0)).optional()?)
}

fn next_number(conn: &Connection, kind: &str) -> Result<String> {
    let prefix = match kind {
        "purchase" => "P",
        "sale" => "S",
        "return" => "RT",
        "adjustment" => "ADJ",
        _ => "RV",
    };
    let n: i64 = conn.query_row("SELECT COUNT(*)+1 FROM txns WHERE kind=?1", [kind], |r| r.get(0))?;
    Ok(format!("{prefix}-{n:06}"))
}

fn describe(conn: &Connection, item_id: i64) -> Result<(String, Value)> {
    let it = item_row(conn, item_id)?;
    let mut desc = it["name"].as_str().unwrap_or("").to_string();
    let ident = it["identifier"].as_str().unwrap_or("");
    if !ident.is_empty() {
        desc = format!("{desc} ({ident})");
    }
    let cat = it["category_id"].as_i64().unwrap_or(0);
    let defs = field_list(conn, Some(cat), Some(item_id), false)?;
    let vals = item_values(conn, item_id)?;
    let money = money_fmt_fn(conn)?;
    let mut details = Vec::new();
    for d in defs.iter().filter(|d| d.show_on_receipt) {
        if let Some(v) = vals.get(&d.id.to_string()) {
            let s = display_value(d, v, &money);
            if !s.is_empty() {
                details.push(json!({ "name": d.name, "value": s }));
            }
        }
    }
    Ok((desc, Value::Array(details)))
}

struct NewTxn<'a> {
    kind: &'a str,
    date: &'a str,
    party: &'a str,
    notes: &'a str,
    reason: &'a str,
    related: Option<(i64, String)>,
    subtotal: i64,
    discount: i64,
    total: i64,
    token: &'a str,
}

fn insert_txn(tx: &Transaction, t: NewTxn) -> Result<(i64, String)> {
    let number = next_number(tx, t.kind)?;
    let snap = settings::receipt_snapshot(tx)?;
    tx.execute(
        "INSERT INTO txns(kind,number,business_date,created_at,party,notes,reason,related_txn_id,related_kind,subtotal,discount,total,client_token,snapshot)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            t.kind, number, t.date, now_iso(), t.party.trim(), t.notes.trim(), t.reason.trim(),
            t.related.as_ref().map(|r| r.0), t.related.as_ref().map(|r| r.1.clone()),
            t.subtotal, t.discount, t.total, t.token, snap.to_string()
        ],
    )?;
    Ok((tx.last_insert_rowid(), number))
}

#[allow(clippy::too_many_arguments)]
fn insert_line(
    tx: &Transaction, txn_id: i64, no: i64, item_id: i64, qty: i64, direction: i64, unit_price: i64, line_discount: i64,
    alloc: i64, net: i64, cost: i64, related_line: Option<i64>, desc: &str, details: &Value,
) -> Result<i64> {
    tx.execute(
        "INSERT INTO txn_lines(txn_id,line_no,item_id,qty,direction,unit_price,line_discount,alloc_discount,net,cost,related_line_id,description,details)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![txn_id, no, item_id, qty, direction, unit_price, line_discount, alloc, net, cost, related_line, desc, details.to_string()],
    )?;
    Ok(tx.last_insert_rowid())
}

#[allow(clippy::too_many_arguments)]
fn insert_move(tx: &Transaction, txn_id: i64, line_id: i64, item_id: i64, lot_line_id: i64, lot_date: &str, qty: i64, cost: i64, date: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO stock_moves(txn_id,line_id,item_id,lot_line_id,lot_date,qty,cost,business_date,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![txn_id, line_id, item_id, lot_line_id, lot_date, qty, cost, date, now_iso()],
    )?;
    Ok(())
}

fn plan_fifo(conn: &Connection, item_id: i64, qty: i64, date: &str) -> Result<(Vec<(i64, String, i64, i64)>, i64)> {
    let lots = lots_open(conn, item_id, date)?;
    let mut left = qty;
    let mut cost = 0i64;
    let mut plan = Vec::new();
    for lot in lots {
        if left == 0 {
            break;
        }
        let take = left.min(lot.qty);
        let c = if take == lot.qty { lot.cost } else { mul_div_round(lot.cost, take, lot.qty) };
        plan.push((lot.line_id, lot.date.clone(), take, c));
        cost += c;
        left -= take;
    }
    if left > 0 {
        return user("Not enough stock for this date");
    }
    Ok((plan, cost))
}

fn apply_plan(tx: &Transaction, txn_id: i64, line_id: i64, item_id: i64, plan: &[(i64, String, i64, i64)], date: &str) -> Result<()> {
    for (lot, lot_date, q, c) in plan {
        insert_move(tx, txn_id, line_id, item_id, *lot, lot_date, -q, -c, date)?;
    }
    Ok(())
}

struct Checked {
    item: Value,
    name: String,
}

fn check_item_for_trade(conn: &Connection, item_id: i64) -> Result<Checked> {
    let item = item_row(conn, item_id)?;
    let name = item["name"].as_str().unwrap_or("").to_string();
    if item["archived"].as_bool() == Some(true) {
        return user(format!("\"{name}\" is archived. Bring it back from the archive first."));
    }
    Ok(Checked { item, name })
}

fn validate_doc(d: &DocInput) -> Result<(String, Vec<i64>, Vec<i64>, i64)> {
    let date = check_date(&d.business_date)?;
    if d.lines.is_empty() {
        return user("Add at least one item");
    }
    let mut gross = Vec::new();
    for l in &d.lines {
        if l.qty <= 0 {
            return user("Quantity must be at least 1");
        }
        if l.unit_price < 0 || l.line_discount < 0 {
            return user("Prices and discounts cannot be negative");
        }
        let g = l.qty.checked_mul(l.unit_price).ok_or_else(|| Error::User("Amount is too large".into()))?;
        if l.line_discount > g {
            return user("A discount is bigger than the line amount");
        }
        gross.push(g - l.line_discount);
    }
    let sum: i64 = gross.iter().sum();
    if d.discount < 0 || d.discount > sum {
        return user("The discount is bigger than the total");
    }
    let alloc = allocate(d.discount, &gross);
    Ok((date, gross, alloc, sum))
}

fn begin(conn: &mut Connection) -> Result<Transaction<'_>> {
    Ok(conn.transaction_with_behavior(TransactionBehavior::Immediate)?)
}

pub fn purchase_post(conn: &mut Connection, d: &DocInput) -> Result<Value> {
    let tx = begin(conn)?;
    if let Some(id) = existing_token(&tx, &d.client_token)? {
        drop(tx);
        return dup(conn, id);
    }
    let (date, gross, alloc, sum) = validate_doc(d)?;
    let mut uniq_seen = std::collections::HashSet::new();
    for l in &d.lines {
        let c = check_item_for_trade(&tx, l.item_id)?;
        if c.item["tracking"] == "unique" {
            if l.qty != 1 || !uniq_seen.insert(l.item_id) {
                return user(format!("\"{}\" is a one of a kind item. Buy it with quantity 1.", c.name));
            }
            let (now, _) = stock_on(&tx, l.item_id, None)?;
            if now != 0 {
                return user(format!("\"{}\" is already in stock. A one of a kind item can only be bought again after it is sold.", c.name));
            }
        }
    }
    let total = sum - d.discount;
    let (txn_id, _) = insert_txn(&tx, NewTxn {
        kind: "purchase", date: &date, party: &d.party, notes: &d.notes, reason: "", related: None,
        subtotal: sum, discount: d.discount, total, token: &d.client_token,
    })?;
    for (i, l) in d.lines.iter().enumerate() {
        let net = gross[i] - alloc[i];
        let (desc, details) = describe(&tx, l.item_id)?;
        let line_id = insert_line(&tx, txn_id, i as i64 + 1, l.item_id, l.qty, 1, l.unit_price, l.line_discount, alloc[i], net, net, None, &desc, &details)?;
        insert_move(&tx, txn_id, line_id, l.item_id, line_id, &date, l.qty, net, &date)?;
    }
    insert_txn_photos(&tx, txn_id, &d.photos)?;
    insert_txn_details(&tx, txn_id, &d.details)?;
    tx.commit()?;
    txn_get(conn, txn_id)
}

pub fn sale_post(conn: &mut Connection, d: &DocInput) -> Result<Value> {
    let tx = begin(conn)?;
    if let Some(id) = existing_token(&tx, &d.client_token)? {
        drop(tx);
        return dup(conn, id);
    }
    let (date, gross, alloc, sum) = validate_doc(d)?;
    let mut need: BTreeMap<i64, i64> = BTreeMap::new();
    for l in &d.lines {
        *need.entry(l.item_id).or_default() += l.qty;
    }
    for (item_id, q) in &need {
        let c = check_item_for_trade(&tx, *item_id)?;
        let avail = available_on(&tx, *item_id, &date)?;
        let lots: i64 = lots_open(&tx, *item_id, &date)?.iter().map(|l| l.qty).sum();
        let can = avail.min(lots).max(0);
        if *q > can {
            if c.item["tracking"] == "unique" {
                return user(format!("\"{}\" is not in stock on {date}. It may already be sold.", c.name));
            }
            return user(format!("Only {can} of \"{}\" in stock on {date}, but this sale needs {q}.", c.name));
        }
    }
    let total = sum - d.discount;
    let (txn_id, _) = insert_txn(&tx, NewTxn {
        kind: "sale", date: &date, party: &d.party, notes: &d.notes, reason: "", related: None,
        subtotal: sum, discount: d.discount, total, token: &d.client_token,
    })?;
    for (i, l) in d.lines.iter().enumerate() {
        let net = gross[i] - alloc[i];
        let (desc, details) = describe(&tx, l.item_id)?;
        let (plan, cost) = plan_fifo(&tx, l.item_id, l.qty, &date)?;
        let line_id = insert_line(&tx, txn_id, i as i64 + 1, l.item_id, l.qty, -1, l.unit_price, l.line_discount, alloc[i], net, cost, None, &desc, &details)?;
        apply_plan(&tx, txn_id, line_id, l.item_id, &plan, &date)?;
    }
    insert_txn_photos(&tx, txn_id, &d.photos)?;
    insert_txn_details(&tx, txn_id, &d.details)?;
    tx.commit()?;
    txn_get(conn, txn_id)
}

#[derive(Deserialize, Debug)]
pub struct ReturnInput {
    pub client_token: String,
    pub sale_id: i64,
    pub business_date: String,
    pub reason: String,
    pub lines: Vec<ReturnLine>,
}

#[derive(Deserialize, Debug)]
pub struct ReturnLine {
    pub line_id: i64,
    pub qty: i64,
}

fn txn_head(conn: &Connection, id: i64) -> Result<(String, String, String)> {
    conn.query_row("SELECT kind, business_date, number FROM txns WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?
        .ok_or_else(|| Error::NotFound("Transaction not found".into()))
}

fn reversed_by(conn: &Connection, id: i64) -> Result<Option<i64>> {
    Ok(conn.query_row("SELECT id FROM txns WHERE kind='reversal' AND related_txn_id=?1", [id], |r| r.get(0)).optional()?)
}

fn returned_on_line(conn: &Connection, sale_line: i64) -> Result<(i64, i64)> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(l.qty),0), COALESCE(SUM(l.net),0) FROM txn_lines l JOIN txns t ON t.id=l.txn_id
         WHERE l.related_line_id=?1 AND t.kind='return' AND NOT EXISTS (SELECT 1 FROM txns r WHERE r.kind='reversal' AND r.related_txn_id=t.id)",
        [sale_line],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

pub fn return_post(conn: &mut Connection, d: &ReturnInput) -> Result<Value> {
    let tx = begin(conn)?;
    if let Some(id) = existing_token(&tx, &d.client_token)? {
        drop(tx);
        return dup(conn, id);
    }
    let date = check_date(&d.business_date)?;
    if d.reason.trim().is_empty() {
        return user("Please write the reason for the return");
    }
    let (kind, sale_date, sale_no) = txn_head(&tx, d.sale_id)?;
    if kind != "sale" {
        return user("Only a sale can be returned");
    }
    if reversed_by(&tx, d.sale_id)?.is_some() {
        return user("This sale was already reversed");
    }
    if date < sale_date {
        return user("The return date cannot be before the sale date");
    }
    let lines: Vec<&ReturnLine> = d.lines.iter().filter(|l| l.qty > 0).collect();
    if lines.is_empty() {
        return user("Choose at least one item to return");
    }
    let party: String = tx.query_row("SELECT party FROM txns WHERE id=?1", [d.sale_id], |r| r.get(0))?;
    struct Plan {
        line: i64,
        item: i64,
        qty: i64,
        unit_price: i64,
        refund: i64,
        desc: String,
        details: String,
    }
    let mut plans = Vec::new();
    for rl in &lines {
        let (txn_id, item_id, qty, unit_price, net, desc, details): (i64, i64, i64, i64, i64, String, String) = tx.query_row(
            "SELECT txn_id, item_id, qty, unit_price, net, description, details FROM txn_lines WHERE id=?1",
            [rl.line_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )?;
        if txn_id != d.sale_id {
            return user("That line is not part of this sale");
        }
        let (rq, rn) = returned_on_line(&tx, rl.line_id)?;
        if rl.qty > qty - rq {
            return user(format!("Only {} of \"{desc}\" can still be returned", qty - rq));
        }
        let refund = if rl.qty == qty - rq { net - rn } else { mul_div_round(net, rl.qty, qty) };
        plans.push(Plan { line: rl.line_id, item: item_id, qty: rl.qty, unit_price, refund, desc, details });
    }
    let total: i64 = plans.iter().map(|p| p.refund).sum();
    let (txn_id, _) = insert_txn(&tx, NewTxn {
        kind: "return", date: &date, party: &party, notes: &format!("Return for sale {sale_no}"), reason: &d.reason,
        related: Some((d.sale_id, "sale".into())), subtotal: total, discount: 0, total, token: &d.client_token,
    })?;
    for (i, p) in plans.iter().enumerate() {
        let mut consumed: Vec<(i64, String, i64, i64)> = tx
            .prepare("SELECT lot_line_id, lot_date, -SUM(qty), -SUM(cost) FROM stock_moves WHERE line_id=?1 GROUP BY lot_line_id ORDER BY MIN(id)")?
            .query_map([p.line], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<std::result::Result<_, _>>()?;
        consumed.reverse();
        let mut left = p.qty;
        let mut moves = Vec::new();
        let mut cost_back = 0;
        for (lot, lot_date, cq, cc) in consumed {
            if left == 0 {
                break;
            }
            let (back_q, back_c): (i64, i64) = tx.query_row(
                "SELECT COALESCE(SUM(m.qty),0), COALESCE(SUM(m.cost),0) FROM stock_moves m JOIN txn_lines l ON l.id=m.line_id JOIN txns t ON t.id=m.txn_id
                 WHERE l.related_line_id=?1 AND m.lot_line_id=?2 AND t.kind='return'
                 AND NOT EXISTS (SELECT 1 FROM txns r WHERE r.kind='reversal' AND r.related_txn_id=t.id)",
                params![p.line, lot],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let rem_q = cq - back_q;
            let rem_c = cc - back_c;
            if rem_q <= 0 {
                continue;
            }
            let take = left.min(rem_q);
            let c = if take == rem_q { rem_c } else { mul_div_round(cc, take, cq) };
            moves.push((lot, lot_date, take, c));
            cost_back += c;
            left -= take;
        }
        let details: Value = serde_json::from_str(&p.details).unwrap_or(Value::Array(vec![]));
        let line_id = insert_line(&tx, txn_id, i as i64 + 1, p.item, p.qty, 1, p.unit_price, 0, 0, p.refund, cost_back, Some(p.line), &p.desc, &details)?;
        for (lot, lot_date, q, c) in moves {
            insert_move(&tx, txn_id, line_id, p.item, lot, &lot_date, q, c, &date)?;
        }
    }
    tx.commit()?;
    txn_get(conn, txn_id)
}

#[derive(Deserialize, Debug)]
pub struct ReverseInput {
    pub client_token: String,
    pub txn_id: i64,
    pub business_date: String,
    pub reason: String,
}

pub fn reverse_post(conn: &mut Connection, d: &ReverseInput) -> Result<Value> {
    let tx = begin(conn)?;
    if let Some(id) = existing_token(&tx, &d.client_token)? {
        drop(tx);
        return dup(conn, id);
    }
    let date = check_date(&d.business_date)?;
    if d.reason.trim().is_empty() {
        return user("Please write the reason for the reversal");
    }
    let (kind, orig_date, orig_no) = txn_head(&tx, d.txn_id)?;
    if kind == "reversal" {
        return user("A reversal cannot be reversed. Record a new transaction instead.");
    }
    if reversed_by(&tx, d.txn_id)?.is_some() {
        return user(format!("{orig_no} was already reversed"));
    }
    if date < orig_date {
        return user("The reversal date cannot be before the original date");
    }
    if kind == "sale" {
        let open_returns: i64 = tx.query_row(
            "SELECT COUNT(*) FROM txns t WHERE t.kind='return' AND t.related_txn_id=?1 AND NOT EXISTS (SELECT 1 FROM txns r WHERE r.kind='reversal' AND r.related_txn_id=t.id)",
            [d.txn_id],
            |r| r.get(0),
        )?;
        if open_returns > 0 {
            return user("Part of this sale was already returned. Use Return for the remaining items instead.");
        }
    }
    let moves: Vec<(i64, i64, i64, String, i64, i64)> = tx
        .prepare("SELECT line_id, item_id, lot_line_id, lot_date, qty, cost FROM stock_moves WHERE txn_id=?1 ORDER BY id")?
        .query_map([d.txn_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let mut by_lot: BTreeMap<i64, i64> = BTreeMap::new();
    let mut by_item: BTreeMap<i64, i64> = BTreeMap::new();
    for (_, item, lot, _, q, _) in &moves {
        if *q > 0 {
            *by_lot.entry(*lot).or_default() += q;
            *by_item.entry(*item).or_default() += q;
        }
    }
    for (lot, q) in &by_lot {
        let (rem, _) = lot_remaining(&tx, *lot)?;
        if rem < *q {
            return user("Some of these items were already sold or used, so this cannot be reversed. Record a stock adjustment or return instead.");
        }
    }
    for (item, q) in &by_item {
        if available_on(&tx, *item, &date)? < *q {
            return user("Reversing this would make the stock negative on a later date");
        }
    }
    let (party, subtotal, discount, total): (String, i64, i64, i64) =
        tx.query_row("SELECT party, subtotal, discount, total FROM txns WHERE id=?1", [d.txn_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
    let (txn_id, _) = insert_txn(&tx, NewTxn {
        kind: "reversal", date: &date, party: &party, notes: &format!("Reverses {orig_no}"), reason: &d.reason,
        related: Some((d.txn_id, kind.clone())), subtotal, discount, total, token: &d.client_token,
    })?;
    let lines: Vec<(i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, String, String)> = tx
        .prepare("SELECT id, line_no, item_id, qty, direction, unit_price, line_discount, alloc_discount, net, cost, description, details FROM txn_lines WHERE txn_id=?1 ORDER BY line_no")?
        .query_map([d.txn_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?, r.get(11)?))
        })?
        .collect::<std::result::Result<_, _>>()?;
    let mut map = BTreeMap::new();
    for (id, no, item, qty, dir, up, ld, ad, net, cost, desc, det) in lines {
        let details: Value = serde_json::from_str(&det).unwrap_or(Value::Array(vec![]));
        let nl = insert_line(&tx, txn_id, no, item, qty, -dir, up, ld, ad, net, cost, Some(id), &desc, &details)?;
        map.insert(id, nl);
    }
    for (line, item, lot, lot_date, q, c) in moves {
        insert_move(&tx, txn_id, map[&line], item, lot, &lot_date, -q, -c, &date)?;
    }
    tx.commit()?;
    txn_get(conn, txn_id)
}

#[derive(Deserialize, Debug)]
pub struct AdjustInput {
    pub client_token: String,
    pub business_date: String,
    pub item_id: i64,
    pub delta: i64,
    #[serde(default)]
    pub unit_cost: Option<i64>,
    pub reason: String,
}

pub fn adjust_post(conn: &mut Connection, d: &AdjustInput) -> Result<Value> {
    let tx = begin(conn)?;
    if let Some(id) = existing_token(&tx, &d.client_token)? {
        drop(tx);
        return dup(conn, id);
    }
    let date = check_date(&d.business_date)?;
    let reason = if d.reason.trim().is_empty() { "Stock correction".to_string() } else { d.reason.trim().to_string() };
    if d.delta == 0 {
        return user("The quantity did not change");
    }
    let c = check_item_for_trade(&tx, d.item_id)?;
    let (now, _) = stock_on(&tx, d.item_id, None)?;
    if c.item["tracking"] == "unique" && !(0..=1).contains(&(now + d.delta)) {
        return user(format!("\"{}\" is one of a kind. Its stock can only be 0 or 1.", c.name));
    }
    let (desc, details) = describe(&tx, d.item_id)?;
    let qty = d.delta.abs();
    if d.delta > 0 {
        let unit_cost = match d.unit_cost {
            Some(u) if u >= 0 => u,
            Some(_) => return user("Cost cannot be negative"),
            None => last_unit_cost(&tx, d.item_id)?,
        };
        let cost = qty * unit_cost;
        let (txn_id, _) = insert_txn(&tx, NewTxn {
            kind: "adjustment", date: &date, party: "", notes: "Stock added", reason: &reason, related: None,
            subtotal: cost, discount: 0, total: cost, token: &d.client_token,
        })?;
        let line_id = insert_line(&tx, txn_id, 1, d.item_id, qty, 1, unit_cost, 0, 0, cost, cost, None, &desc, &details)?;
        insert_move(&tx, txn_id, line_id, d.item_id, line_id, &date, qty, cost, &date)?;
        tx.commit()?;
        return txn_get(conn, txn_id);
    }
    let avail = available_on(&tx, d.item_id, &date)?.min(lots_open(&tx, d.item_id, &date)?.iter().map(|l| l.qty).sum());
    if qty > avail {
        return user(format!("Only {avail} of \"{}\" in stock on {date}", c.name));
    }
    let (txn_id, _) = insert_txn(&tx, NewTxn {
        kind: "adjustment", date: &date, party: "", notes: "Stock removed", reason: &reason, related: None,
        subtotal: 0, discount: 0, total: 0, token: &d.client_token,
    })?;
    let (plan, cost) = plan_fifo(&tx, d.item_id, qty, &date)?;
    let line_id = insert_line(&tx, txn_id, 1, d.item_id, qty, -1, 0, 0, 0, 0, cost, None, &desc, &details)?;
    apply_plan(&tx, txn_id, line_id, d.item_id, &plan, &date)?;
    tx.commit()?;
    txn_get(conn, txn_id)
}

fn last_unit_cost(conn: &Connection, item_id: i64) -> Result<i64> {
    let v: Option<(i64, i64)> = conn
        .query_row(
            "SELECT l.net, l.qty FROM txn_lines l JOIN txns t ON t.id=l.txn_id WHERE l.item_id=?1 AND t.kind='purchase' ORDER BY t.business_date DESC, l.id DESC LIMIT 1",
            [item_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(v.map(|(n, q)| mul_div_round(n, 1, q)).unwrap_or(0))
}

fn dup(conn: &Connection, id: i64) -> Result<Value> {
    let mut v = txn_get(conn, id)?;
    v["duplicate"] = json!(true);
    Ok(v)
}

pub fn txn_get(conn: &Connection, id: i64) -> Result<Value> {
    let mut t = conn
        .query_row(
            "SELECT id, kind, number, business_date, created_at, party, notes, reason, related_txn_id, related_kind, subtotal, discount, total, snapshot FROM txns WHERE id=?1",
            [id],
            |r| {
                let snap: String = r.get(13)?;
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "kind": r.get::<_, String>(1)?, "number": r.get::<_, String>(2)?,
                    "business_date": r.get::<_, String>(3)?, "created_at": r.get::<_, String>(4)?, "party": r.get::<_, String>(5)?,
                    "notes": r.get::<_, String>(6)?, "reason": r.get::<_, String>(7)?, "related_txn_id": r.get::<_, Option<i64>>(8)?,
                    "related_kind": r.get::<_, Option<String>>(9)?, "subtotal": r.get::<_, i64>(10)?, "discount": r.get::<_, i64>(11)?,
                    "total": r.get::<_, i64>(12)?, "snapshot": serde_json::from_str::<Value>(&snap).unwrap_or(json!({}))
                }))
            },
        )
        .optional()?
        .ok_or_else(|| Error::NotFound("Transaction not found".into()))?;
    let mut s = conn.prepare(
        "SELECT l.id, l.line_no, l.item_id, i.name, l.description, l.details, l.qty, l.direction, l.unit_price, l.line_discount, l.alloc_discount, l.net, l.cost, l.related_line_id, i.tracking
         FROM txn_lines l JOIN items i ON i.id=l.item_id WHERE l.txn_id=?1 ORDER BY l.line_no",
    )?;
    let lines: Vec<Value> = s
        .query_map([id], |r| {
            let det: String = r.get(5)?;
            Ok(json!({
                "id": r.get::<_, i64>(0)?, "line_no": r.get::<_, i64>(1)?, "item_id": r.get::<_, i64>(2)?, "item_name": r.get::<_, String>(3)?,
                "description": r.get::<_, String>(4)?, "details": serde_json::from_str::<Value>(&det).unwrap_or(json!([])),
                "qty": r.get::<_, i64>(6)?, "direction": r.get::<_, i64>(7)?, "unit_price": r.get::<_, i64>(8)?,
                "line_discount": r.get::<_, i64>(9)?, "alloc_discount": r.get::<_, i64>(10)?, "net": r.get::<_, i64>(11)?,
                "cost": r.get::<_, i64>(12)?, "related_line_id": r.get::<_, Option<i64>>(13)?, "tracking": r.get::<_, String>(14)?
            }))
        })?
        .collect::<std::result::Result<_, _>>()?;
    let mut lines = lines;
    if t["kind"] == "sale" {
        for l in lines.iter_mut() {
            let (rq, _) = returned_on_line(conn, l["id"].as_i64().unwrap_or(0))?;
            l["returned_qty"] = json!(rq);
        }
    }
    t["lines"] = Value::Array(lines);
    let photos: Vec<Value> = conn
        .prepare("SELECT id, file, original_name FROM txn_photos WHERE txn_id=?1 ORDER BY sort_order, id")?
        .query_map([id], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "file": r.get::<_, String>(1)?, "original_name": r.get::<_, String>(2)? })))?
        .collect::<std::result::Result<_, _>>()?;
    t["photos"] = Value::Array(photos);
    let extras: Vec<Value> = conn
        .prepare("SELECT id, kind, text, created_at FROM txn_extras WHERE txn_id=?1 ORDER BY id")?
        .query_map([id], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "kind": r.get::<_, String>(1)?, "text": r.get::<_, String>(2)?, "created_at": r.get::<_, String>(3)? })))?
        .collect::<std::result::Result<_, _>>()?;
    if let Some(p) = extras.iter().rev().find(|e| e["kind"] == "party") {
        t["party_original"] = t["party"].clone();
        t["party"] = p["text"].clone();
    }
    t["extras"] = Value::Array(extras);
    let info: Vec<Value> = conn
        .prepare("SELECT id, name, value, print, created_at FROM txn_details WHERE txn_id=?1 ORDER BY id")?
        .query_map([id], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?, "value": r.get::<_, String>(2)?, "print": r.get::<_, i64>(3)? == 1, "created_at": r.get::<_, String>(4)? })))?
        .collect::<std::result::Result<_, _>>()?;
    t["info"] = Value::Array(info);
    let rev = conn
        .query_row("SELECT id, number, business_date, reason FROM txns WHERE kind='reversal' AND related_txn_id=?1", [id], |r| {
            Ok(json!({ "id": r.get::<_, i64>(0)?, "number": r.get::<_, String>(1)?, "business_date": r.get::<_, String>(2)?, "reason": r.get::<_, String>(3)? }))
        })
        .optional()?;
    t["reversed_by"] = rev.unwrap_or(Value::Null);
    if let Some(rid) = t["related_txn_id"].as_i64() {
        let (k, d, n) = txn_head(conn, rid)?;
        t["related"] = json!({ "id": rid, "kind": k, "business_date": d, "number": n });
    }
    let returns: Vec<Value> = conn
        .prepare("SELECT id, number, business_date, total FROM txns WHERE kind='return' AND related_txn_id=?1 ORDER BY id")?
        .query_map([id], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "number": r.get::<_, String>(1)?, "business_date": r.get::<_, String>(2)?, "total": r.get::<_, i64>(3)? })))?
        .collect::<std::result::Result<_, _>>()?;
    t["returns"] = Value::Array(returns);
    Ok(t)
}

pub fn item_moves(conn: &Connection, item_id: i64) -> Result<Vec<Value>> {
    let mut s = conn.prepare(
        "SELECT t.id, t.number, t.kind, t.related_kind, m.business_date, SUM(m.qty), SUM(m.cost), t.reason, t.party
         FROM stock_moves m JOIN txns t ON t.id=m.txn_id WHERE m.item_id=?1 GROUP BY m.txn_id ORDER BY m.business_date, m.txn_id",
    )?;
    let rows: Vec<(i64, String, String, Option<String>, String, i64, i64, String, String)> = s
        .query_map([item_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let mut bal = 0;
    let mut out = Vec::new();
    for (id, no, kind, rk, date, q, c, reason, party) in rows {
        bal += q;
        out.push(json!({ "txn_id": id, "number": no, "kind": kind, "related_kind": rk, "business_date": date, "qty": q, "cost": c, "balance": bal, "reason": reason, "party": party }));
    }
    Ok(out)
}

#[derive(Deserialize, Debug)]
pub struct TxnAddInput {
    pub txn_id: i64,
    #[serde(default)]
    pub photos: Vec<crate::catalog::PhotoRef>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub party: Option<String>,
    #[serde(default)]
    pub details: Vec<DetailInput>,
}

pub fn txn_add(conn: &mut Connection, d: &TxnAddInput) -> Result<Value> {
    let tx = begin(conn)?;
    txn_head(&tx, d.txn_id)?;
    let now = chrono::Utc::now().to_rfc3339();
    let note = d.note.trim();
    let party = d.party.as_deref().map(str::trim);
    if d.photos.is_empty() && note.is_empty() && party.is_none() && d.details.iter().all(|x| x.name.trim().is_empty() && x.value.trim().is_empty()) {
        return user("Nothing to add");
    }
    insert_txn_photos(&tx, d.txn_id, &d.photos)?;
    insert_txn_details(&tx, d.txn_id, &d.details)?;
    if !note.is_empty() {
        tx.execute("INSERT INTO txn_extras(txn_id,kind,text,created_at) VALUES(?1,'note',?2,?3)", params![d.txn_id, note, now])?;
    }
    if let Some(p) = party {
        tx.execute("INSERT INTO txn_extras(txn_id,kind,text,created_at) VALUES(?1,'party',?2,?3)", params![d.txn_id, p, now])?;
    }
    tx.commit()?;
    txn_get(conn, d.txn_id)
}

pub fn cost_preview(conn: &Connection, item_id: i64, qty: i64, date: &str) -> Result<Value> {
    match plan_fifo(conn, item_id, qty, date) {
        Ok((plan, cost)) => {
            let mut lots = Vec::new();
            for (line, d, q, c) in &plan {
                let mut lot = json!({ "date": d, "qty": q, "cost": c });
                if let Some(src) = lot_source(conn, *line)? {
                    lot["source"] = src;
                }
                lots.push(lot);
            }
            Ok(json!({ "cost": cost, "lots": lots }))
        }
        Err(_) => Ok(json!({ "cost": null, "lots": [] })),
    }
}

fn lot_source(conn: &Connection, lot_line_id: i64) -> Result<Option<Value>> {
    let txn_id: Option<i64> = conn.query_row("SELECT txn_id FROM txn_lines WHERE id=?1", [lot_line_id], |r| r.get(0)).optional()?;
    let Some(txn_id) = txn_id else { return Ok(None) };
    let t = txn_get(conn, txn_id)?;
    let notes: Vec<Value> = t["extras"].as_array().cloned().unwrap_or_default().into_iter().filter(|e| e["kind"] == "note").map(|e| e["text"].clone()).collect();
    Ok(Some(json!({
        "txn_id": txn_id, "kind": t["kind"], "number": t["number"], "business_date": t["business_date"], "party": t["party"],
        "notes": t["notes"], "reason": t["reason"], "info": t["info"], "photos": t["photos"], "later_notes": notes,
    })))
}
