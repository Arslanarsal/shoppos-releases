use base64::Engine;
use pos_core::db::{Migration, MIGRATIONS};
use pos_core::Core;
use serde_json::{json, Value};
use std::path::Path;

const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0,
    0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF, 0x89, 0x99, 0x3D, 0x1D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

fn jpeg(tag: u8) -> Vec<u8> {
    let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0, tag];
    v.extend(std::iter::repeat_n(tag, 5000));
    v.extend([0xFF, 0xD9]);
    v
}

fn ok(core: &Core, cmd: &str, args: Value) -> Value {
    let r = core.call(cmd, args.clone());
    assert_eq!(r["ok"], true, "{cmd} {args} failed: {}", r["error"]);
    r["data"].clone()
}

fn err(core: &Core, cmd: &str, args: Value) -> String {
    let r = core.call(cmd, args);
    assert_eq!(r["ok"], false, "{cmd} should have failed but returned {}", r["data"]);
    r["error"]["message"].as_str().unwrap_or("").to_string()
}

fn tok() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn new_shop(dir: &Path) -> Core {
    let core = Core::new(dir, "1.0.0-test");
    assert_eq!(core.open()["state"], "new");
    let st = ok(&core, "shop_create", json!({ "shop_name": "Arslan Furniture and Bikes", "currency_symbol": "Rs", "money_decimals": 0 }));
    assert_eq!(st["state"], "ready");
    core
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

#[test]
fn a_custom_fields_photo_and_filter() {
    let t = tempfile::tempdir().unwrap();
    let core = new_shop(&t.path().join("data"));

    let logo = ok(&core, "logo_store", json!({ "name": "logo.png", "data": b64(PNG) }));
    let logo_file = logo["shop_logo"].as_str().unwrap().to_string();
    assert!(t.path().join("data").join(&logo_file).exists());

    let furniture = ok(&core, "category_create", json!({ "name": "Furniture" }))["id"].as_i64().unwrap();
    let scooter_cat = ok(&core, "category_create", json!({ "name": "Scooter" }))["id"].as_i64().unwrap();
    assert!(err(&core, "category_create", json!({ "name": "furniture" })).contains("already exists"));

    let downloads = t.path().join("Downloads");
    std::fs::create_dir_all(&downloads).unwrap();
    let original = downloads.join("desk.jpg");
    std::fs::write(&original, jpeg(7)).unwrap();
    let bytes = std::fs::read(&original).unwrap();
    let photo = ok(&core, "photo_store", json!({ "name": "desk.jpg", "data": b64(&bytes) }));

    let material = ok(&core, "field_create", json!({ "category_id": furniture, "name": "Material", "kind": "choice", "options": ["Wood", "Metal"] }));
    let drawers = ok(&core, "field_create", json!({ "category_id": furniture, "name": "Drawer count", "kind": "int", "group_name": "Size", "show_in_list": true, "show_on_receipt": true }));
    let length = ok(&core, "field_create", json!({ "category_id": furniture, "name": "Length", "kind": "decimal", "unit": "cm", "group_name": "Size" }));

    let desk = ok(&core, "item_save", json!({
        "category_id": furniture, "name": "Office desk", "tracking": "quantity",
        "values": { drawers["id"].to_string(): 4, material["id"].to_string(): "wood", length["id"].to_string(): "120.50", "new:a": "Scratch on left leg" },
        "new_fields": [{ "key": "a", "name": "Condition note", "kind": "longtext" }],
        "add_photos": [photo]
    }));
    let desk_id = desk["item"]["id"].as_i64().unwrap();
    assert_eq!(desk["values"][drawers["id"].to_string()], 4);
    assert_eq!(desk["values"][material["id"].to_string()], "Wood");
    assert_eq!(desk["values"][length["id"].to_string()], "120.5");
    let only_item = desk["fields"].as_array().unwrap().iter().find(|f| f["name"] == "Condition note").unwrap();
    assert_eq!(only_item["item_id"], desk_id);

    ok(&core, "item_save", json!({ "category_id": furniture, "name": "Small desk", "values": { drawers["id"].to_string(): 2 } }));
    ok(&core, "item_save", json!({ "category_id": scooter_cat, "name": "Honda", "tracking": "unique", "identifier": "CH-1" }));

    let found = ok(&core, "item_search", json!({ "category_id": furniture, "status": "all", "filters": [{ "field_id": drawers["id"], "op": "eq", "value": "4" }] }));
    assert_eq!(found["total"], 1);
    assert_eq!(found["rows"][0]["id"], desk_id);
    assert_eq!(found["rows"][0]["fields"][drawers["id"].to_string()], "4");
    let gt = ok(&core, "item_search", json!({ "status": "all", "filters": [{ "field_id": length["id"], "op": "between", "value": "100", "value2": "130" }] }));
    assert_eq!(gt["total"], 1);

    std::fs::rename(&original, t.path().join("moved.jpg")).unwrap();
    std::fs::remove_file(t.path().join("moved.jpg")).unwrap();
    let again = ok(&core, "item_get", json!({ "id": desk_id }));
    let f = again["photos"][0]["file"].as_str().unwrap();
    let kept = t.path().join("data").join(f);
    assert!(kept.exists(), "photo copy must survive the original being deleted");
    assert_eq!(std::fs::read(kept).unwrap(), bytes);

    ok(&core, "settings_set", json!({ "shop_name": "Arslan Store" }));
    ok(&core, "item_save", json!({ "id": desk_id, "category_id": furniture, "name": "Office desk XL", "values": { drawers["id"].to_string(): 5 } }));
    let h = ok(&core, "item_history", json!({ "id": desk_id }));
    assert!(h["edits"].as_array().unwrap().len() >= 2);

    let req = ok(&core, "field_create", json!({ "category_id": furniture, "name": "Colour", "kind": "text", "required": true }));
    assert!(err(&core, "item_save", json!({ "category_id": furniture, "name": "No colour" })).contains("Colour"));
    ok(&core, "field_archive", json!({ "id": req["id"], "archived": true }));
    ok(&core, "item_save", json!({ "category_id": furniture, "name": "Now fine" }));
}

#[test]
fn a_thousand_fields() {
    let t = tempfile::tempdir().unwrap();
    let core = new_shop(t.path());
    let cat = ok(&core, "category_create", json!({ "name": "Big" }))["id"].as_i64().unwrap();
    let defs: Vec<Value> = (0..1000)
        .map(|i| json!({ "category_id": cat, "name": format!("Field {i:04}"), "kind": if i % 2 == 0 { "int" } else { "text" }, "group_name": format!("Group {}", i / 50) }))
        .collect();
    let start = std::time::Instant::now();
    ok(&core, "field_create_many", json!({ "fields": defs }));
    let list = ok(&core, "field_list", json!({ "category_id": cat }));
    assert_eq!(list.as_array().unwrap().len(), 1000);
    let mut values = serde_json::Map::new();
    for f in list.as_array().unwrap().iter().take(1000) {
        let v = if f["kind"] == "int" { json!(f["id"].as_i64().unwrap() % 7) } else { json!(format!("text {}", f["id"])) };
        values.insert(f["id"].to_string(), v);
    }
    let item = ok(&core, "item_save", json!({ "category_id": cat, "name": "Thing", "values": values }));
    assert_eq!(item["values"].as_object().unwrap().len(), 1000);
    let target = &list[998];
    let res = ok(&core, "item_search", json!({ "filters": [{ "field_id": target["id"], "op": "eq", "value": target["id"].as_i64().unwrap() % 7 }] }));
    assert_eq!(res["total"], 1);
    assert!(start.elapsed().as_secs() < 30, "1000 fields took {:?}", start.elapsed());
}

fn setup_desks(core: &Core) -> (i64, i64) {
    let cat = ok(core, "category_create", json!({ "name": "Furniture" }))["id"].as_i64().unwrap();
    let desk = ok(core, "item_save", json!({ "category_id": cat, "name": "Desk" }))["item"]["id"].as_i64().unwrap();
    (cat, desk)
}

#[test]
fn b_desks_profit() {
    let t = tempfile::tempdir().unwrap();
    let core = new_shop(t.path());
    let (_, desk) = setup_desks(&core);
    let token = tok();
    let p = ok(&core, "purchase_post", json!({ "client_token": token, "business_date": "2026-03-10", "party": "Ali Traders", "lines": [{ "item_id": desk, "qty": 10, "unit_price": 800000 }] }));
    let again = ok(&core, "purchase_post", json!({ "client_token": token, "business_date": "2026-03-10", "lines": [{ "item_id": desk, "qty": 10, "unit_price": 800000 }] }));
    assert_eq!(again["duplicate"], true);
    assert_eq!(again["id"], p["id"]);
    let s = ok(&core, "sale_post", json!({ "client_token": tok(), "business_date": "2026-04-05", "party": "Bilal", "lines": [{ "item_id": desk, "qty": 3, "unit_price": 1200000 }] }));
    assert_eq!(s["total"], 3_600_000);

    let march = ok(&core, "report_figures", json!({ "from": "2026-03-01", "to": "2026-03-31" }));
    assert_eq!(march["purchase_spend"], 8_000_000);
    assert_eq!(march["qty_purchased"], 10);
    let april = ok(&core, "report_figures", json!({ "from": "2026-04-01", "to": "2026-04-30" }));
    assert_eq!(april["sales_revenue"], 3_600_000);
    assert_eq!(april["cogs"], 2_400_000);
    assert_eq!(april["gross_profit"], 1_200_000);
    assert_eq!(april["refunds"], 0);
    assert_eq!(april["net_sales"], 3_600_000);
    assert_eq!(april["stock_qty"], 7);
    assert_eq!(ok(&core, "item_get", json!({ "id": desk }))["stock"]["qty"], 7);
    assert_eq!(ok(&core, "item_stock_on", json!({ "id": desk, "date": "2026-03-31" }))["qty"], 10);
    assert_eq!(ok(&core, "item_stock_on", json!({ "id": desk, "date": "2026-03-01" }))["qty"], 0);

    let drill_p = ok(&core, "line_search", json!({ "kinds": ["purchase", "reversal:purchase"], "from": "2026-03-01", "to": "2026-03-31" }));
    assert_eq!(drill_p["total"], 1);
    assert_eq!(drill_p["sum_net"], 8_000_000);
    assert_eq!(drill_p["rows"][0]["unit_price"], 800000);
    let drill_s = ok(&core, "line_search", json!({ "kinds": ["sale"], "from": "2026-04-01", "to": "2026-04-30" }));
    assert_eq!(drill_s["sum_net"], 3_600_000);
    assert_eq!(drill_s["sum_cost"], 2_400_000);

    let on15 = ok(&core, "line_search", json!({ "kinds": ["purchase"], "from": "2026-03-10", "to": "2026-03-10" }));
    assert_eq!(on15["rows"][0]["qty"], 10);

    let m = ok(&core, "report_monthly", json!({ "from": "2026-03-01", "to": "2026-04-30" }));
    assert_eq!(m["months"].as_array().unwrap().len(), 2);
    assert_eq!(m["total"]["gross_profit"], 1_200_000);
    let csv = ok(&core, "export_csv", json!({ "kind": "monthly", "params": { "from": "2026-03-01", "to": "2026-04-30" } }));
    assert!(csv["csv"].as_str().unwrap().contains("2026-04"));
    assert!(csv["csv"].as_str().unwrap().contains("12000.00"));

    let msg = err(&core, "sale_post", json!({ "client_token": tok(), "business_date": "2026-04-06", "lines": [{ "item_id": desk, "qty": 8, "unit_price": 1 }] }));
    assert!(msg.contains("Only 7"), "{msg}");
    let msg = err(&core, "sale_post", json!({ "client_token": tok(), "business_date": "2026-03-01", "lines": [{ "item_id": desk, "qty": 1, "unit_price": 1 }] }));
    assert!(msg.contains("Only 0"), "{msg}");
}

#[test]
fn b_fifo_batches_discounts_and_returns() {
    let t = tempfile::tempdir().unwrap();
    let core = new_shop(t.path());
    let (_, chair) = setup_desks(&core);
    ok(&core, "purchase_post", json!({ "client_token": tok(), "business_date": "2026-01-01", "lines": [{ "item_id": chair, "qty": 5, "unit_price": 100000 }] }));
    ok(&core, "purchase_post", json!({ "client_token": tok(), "business_date": "2026-02-01", "lines": [{ "item_id": chair, "qty": 5, "unit_price": 133333 }] }));
    let s = ok(&core, "sale_post", json!({ "client_token": tok(), "business_date": "2026-03-01", "discount": 100,
        "lines": [{ "item_id": chair, "qty": 4, "unit_price": 200000 }, { "item_id": chair, "qty": 3, "unit_price": 200000, "line_discount": 50 }] }));
    assert_eq!(s["total"], 1_400_000 - 150);
    let l1 = &s["lines"][0];
    let l2 = &s["lines"][1];
    assert_eq!(l1["cost"], 400000);
    assert_eq!(l2["cost"], 100000 + 266666);
    assert_eq!(l1["net"].as_i64().unwrap() + l2["net"].as_i64().unwrap(), 1_399_850);

    let r = ok(&core, "return_post", json!({ "client_token": tok(), "sale_id": s["id"], "business_date": "2026-03-02", "reason": "Broken leg", "lines": [{ "line_id": l2["id"], "qty": 1 }] }));
    assert_eq!(r["lines"][0]["cost"], 133333);
    let f = ok(&core, "report_figures", json!({ "from": "2026-03-01", "to": "2026-03-31" }));
    assert_eq!(f["refunds"], r["total"]);
    assert_eq!(f["cogs"], 400000 + 266666 + 100000 - 133333);
    assert_eq!(f["stock_qty"], 4);
    assert!(err(&core, "return_post", json!({ "client_token": tok(), "sale_id": s["id"], "business_date": "2026-03-02", "reason": "x", "lines": [{ "line_id": l2["id"], "qty": 3 }] })).contains("Only 2"));
    let r2 = ok(&core, "return_post", json!({ "client_token": tok(), "sale_id": s["id"], "business_date": "2026-03-03", "reason": "Rest", "lines": [{ "line_id": l2["id"], "qty": 2 }] }));
    assert_eq!(r2["total"].as_i64().unwrap() + r["total"].as_i64().unwrap(), l2["net"].as_i64().unwrap());
    let all = ok(&core, "report_figures", json!({ "from": "2026-01-01", "to": "2026-12-31" }));
    assert_eq!(all["stock_qty"], 6);
    assert_eq!(all["stock_value"], 766665);
}

#[test]
fn c_unique_scooter_reversal() {
    let t = tempfile::tempdir().unwrap();
    let core = new_shop(t.path());
    let cat = ok(&core, "category_create", json!({ "name": "Scooter" }))["id"].as_i64().unwrap();
    let chassis = ok(&core, "field_create", json!({ "category_id": cat, "name": "Model year", "kind": "int" }));
    let sc = ok(&core, "item_save", json!({ "category_id": cat, "name": "Used Vespa", "tracking": "unique", "identifier": "CHS-778899", "values": { chassis["id"].to_string(): 2019 } }));
    let id = sc["item"]["id"].as_i64().unwrap();
    assert!(err(&core, "item_save", json!({ "category_id": cat, "name": "Copy", "tracking": "unique", "identifier": "chs-778899" })).contains("already used"));
    assert!(err(&core, "purchase_post", json!({ "client_token": tok(), "business_date": "2026-05-01", "lines": [{ "item_id": id, "qty": 2, "unit_price": 1 }] })).contains("quantity 1"));
    ok(&core, "purchase_post", json!({ "client_token": tok(), "business_date": "2026-05-01", "lines": [{ "item_id": id, "qty": 1, "unit_price": 15000000 }] }));
    let sale = ok(&core, "sale_post", json!({ "client_token": tok(), "business_date": "2026-05-10", "party": "Usman", "lines": [{ "item_id": id, "qty": 1, "unit_price": 18000000 }] }));
    let msg = err(&core, "sale_post", json!({ "client_token": tok(), "business_date": "2026-05-11", "lines": [{ "item_id": id, "qty": 1, "unit_price": 18000000 }] }));
    assert!(msg.contains("not in stock"), "{msg}");
    assert!(err(&core, "reverse_post", json!({ "client_token": tok(), "txn_id": sale["id"], "business_date": "2026-05-12", "reason": "" })).contains("reason"));
    let rev = ok(&core, "reverse_post", json!({ "client_token": tok(), "txn_id": sale["id"], "business_date": "2026-05-12", "reason": "Customer cancelled, money returned" }));
    assert_eq!(rev["related"]["number"], sale["number"]);
    assert!(err(&core, "reverse_post", json!({ "client_token": tok(), "txn_id": sale["id"], "business_date": "2026-05-12", "reason": "again" })).contains("already reversed"));
    let orig = ok(&core, "txn_get", json!({ "id": sale["id"] }));
    assert_eq!(orig["reversed_by"]["number"], rev["number"]);
    let hist = ok(&core, "line_search", json!({ "item_id": id }));
    assert_eq!(hist["total"], 3);
    assert_eq!(ok(&core, "item_get", json!({ "id": id }))["stock"]["qty"], 1);
    let f = ok(&core, "report_figures", json!({ "from": "2026-05-01", "to": "2026-05-31" }));
    assert_eq!(f["sales_revenue"], 18000000);
    assert_eq!(f["refunds"], 18000000);
    assert_eq!(f["gross_profit"], 0);
    ok(&core, "sale_post", json!({ "client_token": tok(), "business_date": "2026-05-20", "lines": [{ "item_id": id, "qty": 1, "unit_price": 17500000 }] }));
    assert_eq!(ok(&core, "item_get", json!({ "id": id }))["stock"]["qty"], 0);
}

#[test]
fn records_cannot_be_deleted_or_edited() {
    let t = tempfile::tempdir().unwrap();
    let dir = t.path().to_path_buf();
    let core = new_shop(&dir);
    let (_, desk) = setup_desks(&core);
    ok(&core, "purchase_post", json!({ "client_token": tok(), "business_date": "2026-01-01", "lines": [{ "item_id": desk, "qty": 1, "unit_price": 5 }] }));
    core.close();
    let c = rusqlite::Connection::open(dir.join("shop.db")).unwrap();
    for sql in ["DELETE FROM txns", "DELETE FROM items", "UPDATE txn_lines SET net=0", "DELETE FROM stock_moves", "DELETE FROM audit_log", "DELETE FROM categories"] {
        let e = c.execute(sql, []).unwrap_err().to_string();
        assert!(e.contains("cannot be"), "{sql}: {e}");
    }
}

#[test]
fn d_backup_and_restore_on_new_computer() {
    let t = tempfile::tempdir().unwrap();
    let a = t.path().join("pc1");
    let drive = t.path().join("E_drive");
    std::fs::create_dir_all(&drive).unwrap();
    let core = new_shop(&a);
    ok(&core, "logo_store", json!({ "name": "logo.png", "data": b64(PNG) }));
    ok(&core, "settings_set", json!({ "receipt_footer": "No refunds after 7 days", "accent": "#aa3300", "backup_dest": "" }));
    let (cat, desk) = setup_desks(&core);
    let f = ok(&core, "field_create", json!({ "category_id": cat, "name": "Drawers", "kind": "int", "show_on_receipt": true }));
    let photo = ok(&core, "photo_store", json!({ "name": "d.jpg", "data": b64(&jpeg(9)) }));
    ok(&core, "item_save", json!({ "id": desk, "category_id": cat, "name": "Desk", "values": { f["id"].to_string(): 4 }, "add_photos": [photo] }));
    ok(&core, "purchase_post", json!({ "client_token": tok(), "business_date": "2026-03-01", "lines": [{ "item_id": desk, "qty": 10, "unit_price": 800000 }] }));
    let sale = ok(&core, "sale_post", json!({ "client_token": tok(), "business_date": "2026-04-01", "lines": [{ "item_id": desk, "qty": 3, "unit_price": 1200000 }] }));

    let st = ok(&core, "backup_now", json!({}));
    assert!(st["path"].as_str().unwrap().contains("local-backups"));

    let missing = t.path().join("unplugged");
    ok(&core, "settings_set", json!({ "backup_dest": missing.display().to_string() }));
    let msg = err(&core, "backup_now", json!({}));
    assert!(msg.contains("plug it in"), "{msg}");
    let bs = ok(&core, "backup_status", json!({}));
    assert_eq!(bs["dest_available"], false);
    assert!(bs["last_error"].as_str().unwrap().contains("cannot be found"));

    ok(&core, "settings_set", json!({ "backup_dest": drive.display().to_string() }));
    let res = ok(&core, "backup_now", json!({ "deep": true }));
    let snap = res["path"].as_str().unwrap().to_string();
    assert_eq!(res["files"], 2);
    let bs = ok(&core, "backup_status", json!({}));
    assert!(bs["last_success_at"].is_string());
    assert_eq!(bs["last_error"], Value::Null);
    ok(&core, "backup_now", json!({}));

    let original_receipt = ok(&core, "txn_get", json!({ "id": sale["id"] }));
    let original_item = ok(&core, "item_get", json!({ "id": desk }));
    let original_settings = ok(&core, "settings_get", json!({}));
    drop(core);

    let b = t.path().join("pc2");
    let fresh = Core::new(&b, "1.0.0-test");
    assert_eq!(fresh.open()["state"], "new");
    let found = ok(&fresh, "restore_find", json!({ "path": drive.display().to_string() }));
    assert_eq!(found.as_array().unwrap().len(), 2);
    ok(&fresh, "restore_verify", json!({ "path": snap }));
    let r = ok(&fresh, "restore_apply", json!({ "path": snap }));
    assert_eq!(r["status"]["state"], "ready");
    assert_eq!(ok(&fresh, "txn_get", json!({ "id": sale["id"] })), original_receipt);
    let item = ok(&fresh, "item_get", json!({ "id": desk }));
    assert_eq!(item["values"], original_item["values"]);
    assert_eq!(item["stock"]["qty"], 7);
    let pf = item["photos"][0]["file"].as_str().unwrap();
    assert!(b.join(pf).exists());
    let s2 = ok(&fresh, "settings_get", json!({}));
    assert_eq!(s2["receipt_footer"], original_settings["receipt_footer"]);
    assert_eq!(s2["shop_logo"], original_settings["shop_logo"]);
    assert!(b.join(s2["shop_logo"].as_str().unwrap()).exists());
    assert_eq!(original_receipt["lines"][0]["details"][0]["value"], "4");

    let photo_in_backup = Path::new(&snap).parent().unwrap().parent().unwrap().join("files").join(pf);
    std::fs::write(&photo_in_backup, b"corrupt").unwrap();
    assert!(err(&fresh, "restore_verify", json!({ "path": snap })).contains("damaged"));
}

#[test]
fn d_missing_database_is_never_replaced_with_empty() {
    let t = tempfile::tempdir().unwrap();
    let core = new_shop(t.path());
    setup_desks(&core);
    drop(core);
    std::fs::rename(t.path().join("shop.db"), t.path().join("lost.db")).unwrap();
    let _ = std::fs::remove_file(t.path().join("shop.db-wal"));
    let core = Core::new(t.path(), "1.0.0-test");
    assert_eq!(core.open()["state"], "missing_data");
    assert!(!t.path().join("shop.db").exists());
    assert!(err(&core, "shop_create", json!({ "shop_name": "x" })).contains("already exists"));
}

fn v1_only() -> Vec<Migration> {
    MIGRATIONS.iter().filter(|m| m.version == 1).copied().collect()
}

#[test]
fn e_upgrade_v1_to_v2_keeps_data() {
    let t = tempfile::tempdir().unwrap();
    let v1 = Core::with_migrations(t.path(), "0.1.0", v1_only());
    v1.open();
    ok(&v1, "shop_create", json!({ "shop_name": "Old Shop" }));
    let cat = ok(&v1, "category_create", json!({ "name": "Chairs" }))["id"].as_i64().unwrap();
    v1.close();
    {
        let c = rusqlite::Connection::open(t.path().join("shop.db")).unwrap();
        assert_eq!(pos_core::db::schema_version(&c).unwrap(), 1);
        c.execute("INSERT INTO items(category_id,name,tracking,created_at,updated_at) VALUES(?1,'Old chair','quantity','x','x')", [cat]).unwrap();
    }
    drop(v1);
    let v2 = Core::new(t.path(), "0.2.0");
    let st = v2.open();
    assert_eq!(st["state"], "ready", "{st}");
    assert_eq!(st["migrated_from"], 1);
    assert_eq!(st["schema_version"], 2);
    let safety = st["safety_copy"].as_str().unwrap();
    let sc = rusqlite::Connection::open(safety).unwrap();
    assert_eq!(pos_core::db::schema_version(&sc).unwrap(), 1);
    let res = ok(&v2, "item_search", json!({ "text": "Old chair" }));
    assert_eq!(res["total"], 1);
    let id = res["rows"][0]["id"].as_i64().unwrap();
    ok(&v2, "item_save", json!({ "id": id, "category_id": cat, "name": "Old chair", "reorder_level": 3 }));
    let low = ok(&v2, "item_search", json!({ "status": "low" }));
    assert_eq!(low["total"], 1);
}

#[test]
fn e_failed_migration_keeps_data_and_recovers() {
    let t = tempfile::tempdir().unwrap();
    let core = new_shop(t.path());
    let (_, desk) = setup_desks(&core);
    ok(&core, "purchase_post", json!({ "client_token": tok(), "business_date": "2026-01-01", "lines": [{ "item_id": desk, "qty": 2, "unit_price": 5 }] }));
    drop(core);

    let mut bad: Vec<Migration> = MIGRATIONS.to_vec();
    bad.push(Migration { version: 99, name: "broken", sql: "CREATE TABLE half_done(x); INSERT INTO nope VALUES(1);" });
    let broken = Core::with_migrations(t.path(), "9.9.9", bad);
    let st = broken.open();
    assert_eq!(st["state"], "migration_failed", "{st}");
    assert_eq!(st["schema_version"], 2);
    assert!(st["message"].as_str().unwrap().contains("left exactly as it was"));
    assert!(Path::new(st["safety_copy"].as_str().unwrap()).exists());
    assert!(!broken.is_open());
    assert!(err(&broken, "item_search", json!({})).contains("not open"));
    let rec = ok(&broken, "recovery_list", json!({}));
    assert_eq!(rec.as_array().unwrap().len(), 1);
    drop(broken);
    {
        let c = rusqlite::Connection::open(t.path().join("shop.db")).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='half_done'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "half applied migration must roll back");
    }
    let good = Core::new(t.path(), "1.0.1");
    assert_eq!(good.open()["state"], "ready");
    assert_eq!(ok(&good, "item_get", json!({ "id": desk }))["stock"]["qty"], 2);
    let path = rec[0]["path"].as_str().unwrap();
    let r = ok(&good, "recovery_restore", json!({ "path": path }));
    assert_eq!(r["status"]["state"], "ready");
    assert_eq!(ok(&good, "item_get", json!({ "id": desk }))["stock"]["qty"], 2);
}

#[test]
fn e_old_app_refuses_newer_data() {
    let t = tempfile::tempdir().unwrap();
    let core = new_shop(t.path());
    setup_desks(&core);
    drop(core);
    let before = std::fs::read(t.path().join("shop.db")).unwrap();
    let old = Core::with_migrations(t.path(), "0.1.0", v1_only());
    let st = old.open();
    assert_eq!(st["state"], "incompatible", "{st}");
    assert!(!old.is_open());
    drop(old);
    assert_eq!(std::fs::read(t.path().join("shop.db")).unwrap(), before);
}

#[test]
fn photos_reject_non_images() {
    let t = tempfile::tempdir().unwrap();
    let core = new_shop(t.path());
    assert!(err(&core, "photo_store", json!({ "name": "x.exe", "data": b64(b"MZ\x90\x00") })).contains("not a picture"));
}
