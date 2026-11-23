import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "e2e", ".out");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "shoppos-e2e-"));
const exe = path.join(root, "target", "release", process.platform === "win32" ? "pos-dev.exe" : "pos-dev");
const chrome =
  process.env.CHROME ??
  [path.join(os.homedir(), ".cache/ms-playwright/chromium-1208/chrome-linux64/chrome"), "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));

const results = [];
let step = "";
function check(cond, msg) {
  if (!cond) throw new Error(`${step}: ${msg}`);
  results.push(`ok   ${step}: ${msg}`);
}

function server(dataDir, port) {
  const p = spawn(exe, [], { env: { ...process.env, SHOPPOS_DATA_DIR: dataDir, PORT: String(port), DIST: path.join(root, "dist") }, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    p.stdout.on("data", (d) => String(d).includes("dev server") && resolve(p));
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
    setTimeout(() => reject(new Error("server did not start")), 15000);
  });
}

async function api(port, cmd, args = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", body: JSON.stringify(args) });
  return r.json();
}

const PNG = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000100000001008020000009091683600000027494441547801626060F8CF400A30A2B3612A40C6A8016D0C0C0C0C0C0C0CA30634A00106000063DC03FDCB6AF2E70000000049454E44AE426082",
  "hex",
);

async function makeJpeg(page, file, color, label) {
  const b64 = await page.evaluate(
    ([c, l]) => {
      const cv = document.createElement("canvas");
      cv.width = 640;
      cv.height = 480;
      const g = cv.getContext("2d");
      g.fillStyle = c;
      g.fillRect(0, 0, 640, 480);
      g.fillStyle = "#fff";
      g.font = "bold 64px sans-serif";
      g.fillText(l, 40, 260);
      return cv.toDataURL("image/jpeg", 0.9).split(",")[1];
    },
    [color, label],
  );
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
}

async function photoLoaded(page, selector) {
  const el = page.locator(selector).first();
  await el.waitFor();
  await page.waitForFunction((s) => {
    const i = document.querySelector(s);
    return i && i.complete;
  }, selector);
  return el.evaluate((i) => i.naturalWidth > 0);
}

async function pick(page, text) {
  await page.fill('[data-testid="item-picker"]', text);
  const row = page.locator(".picker-row", { hasText: text }).first();
  await row.waitFor();
  await row.click();
}

async function main() {
  const dataA = path.join(work, "pc1");
  const dataB = path.join(work, "pc2");
  const usb = path.join(work, "usb-drive");
  const downloads = path.join(work, "Downloads");
  fs.mkdirSync(usb);
  fs.mkdirSync(downloads);
  const portA = 5191;
  const portB = 5192;
  const srvA = await server(dataA, portA);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
  page.on("pageerror", (e) => results.push(`PAGE ERROR ${e.message}`));
  const base = `http://127.0.0.1:${portA}/`;
  try {
    step = "A shop";
    await page.goto(base);
    await page.click('[data-testid="start-new"]');
    await page.fill('[data-testid="shop-name"]', "Arslan Furniture and Bikes");
    await page.click('[data-testid="create-shop"]');
    await page.locator(".brand", { hasText: "Arslan Furniture and Bikes" }).waitFor();
    check(true, "shop created with its own name");
    const logoFile = path.join(downloads, "logo.png");
    fs.writeFileSync(logoFile, PNG);
    await page.goto(base + "#/settings?tab=shop");
    await page.setInputFiles('[data-testid="logo-input"]', logoFile);
    await page.locator('[data-testid="logo-preview"]').waitFor();
    check(await photoLoaded(page, '[data-testid="logo-preview"]'), "logo uploaded and shown");
    check(await photoLoaded(page, ".brand img"), "logo shown in the app sidebar");

    step = "A categories";
    await page.goto(base + "#/categories");
    for (const c of ["Furniture", "Scooter"]) {
      await page.click('[data-testid="new-category"]');
      await page.fill('[data-testid="category-name"]', c);
      await page.click('[data-testid="category-create"]');
      await page.locator(".list-row", { hasText: c }).waitFor();
    }
    check(true, "Furniture and Scooter categories created in the interface");

    step = "A desk";
    const deskPhoto = path.join(downloads, "desk.jpg");
    await makeJpeg(page, deskPhoto, "#8b5a2b", "DESK");
    await page.goto(base + "#/item/new");
    await page.setInputFiles('[data-testid="photo-input"]', deskPhoto);
    await page.locator(".photo-tile img").waitFor();
    await page.fill('[data-testid="item-name"]', "Office desk");
    await page.selectOption('[data-testid="item-category"]', { label: "Furniture" });
    await page.fill('[data-testid="item-price"]', "12000");
    await page.click('[data-testid="add-field"]');
    await page.fill('[data-testid="field-name"]', "Drawer count");
    await page.selectOption('[data-testid="field-kind"]', "int");
    await page.check('[data-testid="scope-category"]');
    await page.click('[data-testid="field-save"]');
    await page.locator('[data-field="Drawer count"]').waitFor();
    check((await page.inputValue('[data-testid="item-name"]')) === "Office desk", "name kept after adding a field mid entry");
    check((await page.locator(".photo-tile img").count()) === 1, "photo kept after adding a field mid entry");
    await page.fill('[data-field="Drawer count"]', "4");
    await page.click('[data-testid="add-field"]');
    await page.fill('[data-testid="field-name"]', "Scratch note");
    await page.selectOption('[data-testid="field-kind"]', "longtext");
    await page.check('[data-testid="scope-item"]');
    await page.click('[data-testid="field-save"]');
    await page.locator('[data-field="Scratch note"]').waitFor();
    check((await page.inputValue('[data-field="Drawer count"]')) === "4", "drawer value kept after a second new field");
    await page.fill('[data-field="Scratch note"]', "Small scratch on left side");
    await page.click('[data-testid="item-save"]');
    await page.locator('dd[data-field-value="Drawer count"]').waitFor();
    check((await page.textContent('dd[data-field-value="Drawer count"]')) === "4", "drawer count saved as 4");
    check((await page.textContent('dd[data-field-value="Scratch note"]'))?.includes("scratch"), "item only field saved");
    const deskUrl = page.url();
    fs.renameSync(deskPhoto, path.join(work, "moved-away.jpg"));
    fs.rmSync(path.join(work, "moved-away.jpg"));
    await page.goto(base + "#/");
    await page.goto(deskUrl);
    await page.reload();
    check(await photoLoaded(page, '[data-testid="item-photo"]'), "photo still opens after the original file was moved and deleted");
    await shot(page, "A-desk");

    await page.goto(base + "#/item/new");
    await page.fill('[data-testid="item-name"]', "Small desk");
    await page.selectOption('[data-testid="item-category"]', { label: "Furniture" });
    await page.fill('[data-field="Drawer count"]', "2");
    await page.click('[data-testid="item-save"]');
    await page.locator('dd[data-field-value="Drawer count"]').waitFor();

    step = "A filter";
    await page.goto(base + "#/items");
    await page.selectOption('[data-testid="items-category"]', { label: "Furniture" });
    await page.click('[data-testid="more-filters"]');
    await page.click('[data-testid="add-filter"]');
    await page.selectOption('[data-testid="filter-field"]', { label: "Drawer count" });
    await page.fill('[data-testid="filter-value"] input', "4");
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="items-table"] tbody tr').length === 1);
    const rows = await page.locator('[data-testid="items-table"] tbody tr').allTextContents();
    check(rows.length === 1 && rows[0].includes("Office desk"), "filter drawer count = 4 finds only the office desk");
    await shot(page, "A-filter");

    step = "A 1000 fields";
    const big = await api(portA, "category_create", { name: "Warehouse parts" });
    const defs = Array.from({ length: 1000 }, (_, i) => ({ category_id: big.data.id, name: `Spec ${String(i).padStart(4, "0")}`, kind: i % 3 === 0 ? "int" : "text", group_name: `Group ${Math.floor(i / 50)}` }));
    defs[0].required = true;
    check((await api(portA, "field_create_many", { fields: defs })).data.created === 1000, "1000 field definitions created");
    await page.goto(base + "#/item/new");
    await page.fill('[data-testid="item-name"]', "Big part");
    const t0 = Date.now();
    await page.selectOption('[data-testid="item-category"]', { label: "Warehouse parts" });
    await page.locator('[data-testid="field-search"]').waitFor();
    const ms = Date.now() - t0;
    check((await page.locator(".field-group").count()) === 20, `form groups 1000 fields into 20 groups (shown in ${ms} ms)`);
    check((await page.locator("[data-field]").count()) < 40, "groups start folded so the form stays short");
    await page.fill('[data-testid="field-search"]', "Spec 0778");
    await page.locator('[data-field="Spec 0778"]').waitFor();
    await page.fill('[data-field="Spec 0778"]', "blue gasket");
    await page.fill('[data-testid="field-search"]', "");
    await page.fill('[data-field="Spec 0000"]', "12");
    await page.click('[data-testid="item-save"]');
    await page.locator('dd[data-field-value="Spec 0778"]').waitFor();
    check((await page.textContent('dd[data-field-value="Spec 0778"]')) === "blue gasket", "field found by search, filled and saved");

    step = "B purchase";
    await page.goto(base + "#/purchase");
    await page.fill('[data-testid="trade-date"]', "2026-03-15");
    await page.fill('[data-testid="trade-party"]', "Ali Traders");
    await pick(page, "Office desk");
    await page.fill('[data-testid="qty-0"]', "10");
    await page.fill('[data-testid="price-0"]', "8000");
    check((await page.textContent('[data-testid="trade-total"]')) === "Rs 80,000", "total shown before confirmation");
    await page.click('[data-testid="trade-review"]');
    await page.locator('[data-testid="trade-confirm"]').waitFor();
    await page.locator('[data-testid="trade-confirm"]').dblclick();
    await page.locator('[data-testid="receipt"]').waitFor();
    await page.click('[data-testid="trade-new"]');
    const purchases = await api(portA, "line_search", { kinds: ["purchase"] });
    check(purchases.data.total === 1, "double click saved one purchase only");

    step = "B sale";
    await page.goto(base + "#/sale");
    await page.fill('[data-testid="trade-date"]', "2026-04-10");
    await page.fill('[data-testid="trade-party"]', "Bilal");
    await pick(page, "Office desk");
    await page.fill('[data-testid="qty-0"]', "3");
    check((await page.inputValue('[data-testid="price-0"]')) === "12000", "usual price filled in");
    check((await page.textContent('[data-testid="trade-total"]')) === "Rs 36,000", "sale total before confirm");
    await page.click('[data-testid="trade-review"]');
    await page.click('[data-testid="trade-confirm"]');
    await page.locator('[data-testid="receipt"]').waitFor();
    const rtext = await page.textContent('[data-testid="receipt"]');
    check(rtext.includes("Arslan Furniture and Bikes") && rtext.includes("Rs 36,000") && rtext.includes("Bilal"), "branded receipt with total");
    check(await photoLoaded(page, ".r-logo"), "logo on receipt");
    await shot(page, "B-receipt");
    await page.click('[data-testid="trade-new"]');

    step = "B reports";
    await page.goto(base + "#/reports");
    await page.fill('[data-testid="report-month"]', "2026-03");
    await page.locator('[data-testid="fig-purchase-spend"]', { hasText: "Rs 80,000" }).waitFor();
    check(true, "March purchase spend Rs 80,000");
    await page.fill('[data-testid="report-month"]', "2026-04");
    await page.locator('[data-testid="fig-revenue"]', { hasText: "Rs 36,000" }).waitFor();
    check(true, "April sales revenue Rs 36,000");
    check((await page.textContent('[data-testid="fig-profit"]')).includes("Rs 12,000"), "April gross profit Rs 12,000");
    check((await page.textContent('[data-testid="fig-stock"]')).includes("7 pcs"), "7 desks remaining");
    await shot(page, "B-report");
    await page.click('[data-testid="fig-profit"]');
    await page.locator('[data-testid="lines-table"]').waitFor();
    const drill = await page.textContent('[data-testid="lines-table"]');
    check(drill.includes("S-000001") && drill.includes("Rs 36,000") && drill.includes("Rs 24,000"), "profit opens the sale behind it with its cost");
    await page.goto(base + "#/reports");
    await page.fill('[data-testid="report-month"]', "2026-03");
    await page.click('[data-testid="fig-purchase-spend"]');
    await page.locator('[data-testid="lines-table"]').waitFor();
    check((await page.textContent('[data-testid="lines-table"]')).includes("P-000001"), "purchase spend opens the purchase behind it");

    step = "B history";
    await page.goto(base + "#/history?kinds=purchase&from=2026-03-15&to=2026-03-15");
    await page.locator('[data-testid="lines-table"]').waitFor();
    const h = await page.textContent('[data-testid="lines-table"]');
    check(h.includes("+10") && h.includes("Rs 8,000"), "what did I buy on 15 March: 10 at 8,000");

    step = "C scooter";
    await page.goto(base + "#/item/new");
    await page.fill('[data-testid="item-name"]', "Used Vespa");
    await page.selectOption('[data-testid="item-category"]', { label: "Scooter" });
    await page.check('[data-testid="tracking-unique"]');
    await page.fill('[data-testid="item-identifier"]', "CHS-778899");
    await page.click('[data-testid="item-save"]');
    await page.locator('[data-testid="stock-now"]').waitFor();
    await page.goto(base + "#/purchase");
    await page.fill('[data-testid="trade-date"]', "2026-05-01");
    await pick(page, "CHS-778899");
    await page.fill('[data-testid="price-0"]', "150000");
    await page.click('[data-testid="trade-review"]');
    await page.click('[data-testid="trade-confirm"]');
    await page.locator('[data-testid="receipt"]').waitFor();
    await page.click('[data-testid="trade-new"]');
    await page.goto(base + "#/sale");
    await page.fill('[data-testid="trade-date"]', "2026-05-10");
    await pick(page, "CHS-778899");
    await page.fill('[data-testid="price-0"]', "180000");
    await page.click('[data-testid="trade-review"]');
    await page.click('[data-testid="trade-confirm"]');
    await page.locator('[data-testid="receipt"]').waitFor();
    await page.click('[data-testid="trade-new"]');
    await page.fill('[data-testid="item-picker"]', "CHS-778899");
    const srow = page.locator(".picker-row", { hasText: "CHS-778899" }).filter({ hasText: "Out of stock" }).first();
    await srow.waitFor();
    check((await srow.getAttribute("class")).includes("disabled") && (await srow.textContent()).includes("Out of stock"), "sold scooter cannot be picked for a second sale");
    const scooterId = (await api(portA, "item_search", { text: "CHS-778899" })).data.rows[0].id;
    const second = await api(portA, "sale_post", { client_token: "second-try", business_date: "2026-05-11", lines: [{ item_id: scooterId, qty: 1, unit_price: 1 }] });
    check(second.ok === false && second.error.message.includes("not in stock"), "second sale refused by the ledger too");
    await page.goto(base + "#/history?kinds=sale&text=CHS-778899");
    await page.locator('[data-testid="lines-table"] tbody tr').first().click();
    await page.click('[data-testid="reverse-open"]');
    await page.fill('[data-testid="reverse-reason"]', "Customer cancelled and got the money back");
    await page.click('[data-testid="reverse-confirm"]');
    await page.locator("h1", { hasText: "Reversal of sale" }).waitFor();
    await page.goto(base + "#/history?text=CHS-778899");
    await page.locator('[data-testid="lines-table"]').waitFor();
    const ch = await page.textContent('[data-testid="lines-table"]');
    check(ch.includes("Reversed by RV-000001") && ch.includes("Reversal of sale") && ch.includes("Customer cancelled"), "sale and its reversal both visible with reason");
    await shot(page, "C-history");
    const sc = await api(portA, "item_search", { text: "CHS-778899" });
    check(sc.data.rows[0].stock === 1, "scooter back in stock");

    step = "D backup";
    await page.goto(base + "#/settings?tab=backup");
    await page.fill('[data-testid="backup-dest"]', path.join(work, "unplugged-drive"));
    await page.click('[data-testid="backup-dest-save"]');
    await page.click('[data-testid="backup-now"]');
    await page.locator(".alert-error", { hasText: "plug it in" }).waitFor();
    check(true, "unplugged drive explained in plain words");
    await page.fill('[data-testid="backup-dest"]', usb);
    await page.click('[data-testid="backup-dest-save"]');
    await page.click('[data-testid="backup-now"]');
    await page.locator('[data-testid="backup-state"]', { hasText: "Last backup finished and checked" }).waitFor();
    check(true, "backup finished, verified and time shown");
    await shot(page, "D-backup");
    const sale = await api(portA, "txn_get", { id: 2 });
    srvA.kill();

    step = "D restore";
    const srvB = await server(dataB, portB);
    const baseB = `http://127.0.0.1:${portB}/`;
    await page.goto(baseB);
    await page.click('[data-testid="start-restore"]');
    await page.fill('[data-testid="restore-path"]', usb);
    await page.click("text=Find backups");
    await page.click('[data-testid="restore-go"]');
    await page.click("text=Open my shop");
    await page.locator(".brand", { hasText: "Arslan Furniture and Bikes" }).waitFor();
    check(await photoLoaded(page, ".brand img"), "branding restored on the new computer");
    const sale2 = await api(portB, "txn_get", { id: 2 });
    check(JSON.stringify(sale2.data) === JSON.stringify(sale.data), "receipt identical after restore");
    const items = await api(portB, "item_search", { status: "all" });
    const desk = items.data.rows.find((r) => r.name === "Office desk");
    const vespa = items.data.rows.find((r) => r.identifier === "CHS-778899");
    check(desk.stock === 7 && vespa.stock === 1, "quantities match after restore");
    await page.goto(baseB + `#/item/${desk.id}`);
    check((await page.textContent('dd[data-field-value="Drawer count"]')) === "4", "custom field restored");
    check(await photoLoaded(page, '[data-testid="item-photo"]'), "photo restored");
    await page.goto(baseB + `#/txn/2`);
    check(await photoLoaded(page, ".r-logo"), "receipt logo restored");
    await shot(page, "D-restored-receipt");
    srvB.kill();
  } catch (e) {
    results.push(`FAIL ${e.message}`);
    await shot(page, "failure").catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    srvA.kill();
  }
  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nE2E FAILED" : `\nE2E PASSED (${results.filter((r) => r.startsWith("ok")).length} checks). Screenshots in e2e/.out`);
}

main();
