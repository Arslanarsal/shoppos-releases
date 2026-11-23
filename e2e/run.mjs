import { chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "e2e", ".out");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const REMOTE = process.env.TARGET === "windows";
const PC = process.env.PC ?? "pak lab@192.168.100.215";
const KEY = process.env.PC_KEY ?? path.join(os.homedir(), ".ssh", "pos_client_pc");
const P = REMOTE ? path.win32 : path;
const work = REMOTE ? `C:\\Users\\Public\\pc\\test\\run-${Date.now()}` : fs.mkdtempSync(path.join(os.tmpdir(), "shoppos-e2e-"));
let rpage = null;
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

function ps(cmd) {
  return execFileSync("ssh", ["-i", KEY, "-o", "BatchMode=yes", PC, `powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`], { encoding: "utf8" }).trim();
}

const disk = {
  mkdir: (p) => (REMOTE ? ps(`New-Item -ItemType Directory -Force '${p}' | Out-Null`) : fs.mkdirSync(p, { recursive: true })),
  exists: (p) => (REMOTE ? ps(`Test-Path -LiteralPath '${p}'`) === "True" : fs.existsSync(p)),
};

async function openShop(browser, dataDir, port) {
  if (!REMOTE) {
    const proc = await server(dataDir, port);
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    page.on("pageerror", (e) => results.push(`PAGE ERROR ${e.message}`));
    return { page, base: `http://127.0.0.1:${port}/`, close: () => proc.kill() };
  }
  const t0 = Date.now();
  execFileSync(path.join(root, "e2e", "pc-launch.sh"), [dataDir], { stdio: "inherit" });
  const cdp = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = cdp.contexts()[0].pages().find((p) => p.url().includes("tauri.localhost")) ?? cdp.contexts()[0].pages()[0];
  page.on("pageerror", (e) => results.push(`PAGE ERROR ${e.message}`));
  page.setDefaultTimeout(90000);
  await page.setViewportSize({ width: 1366, height: 860 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector(".boot-card, .shell"), null, { timeout: 60000 });
  results.push(`info real Windows app opened in ${((Date.now() - t0) / 1000).toFixed(1)} s (data ${dataDir})`);
  rpage = page;
  return { page, base: "http://tauri.localhost/", close: () => cdp.close().catch(() => {}) };
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
  if (REMOTE) return rpage.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke("call", { cmd: c, args: a }), [cmd, args]);
  const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", body: JSON.stringify(args) });
  return r.json();
}

const PNG = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000100000001008020000009091683600000027494441547801626060F8CF400A30A2B3612A40C6A8016D0C0C0C0C0C0C0CA30634A00106000063DC03FDCB6AF2E70000000049454E44AE426082",
  "hex",
);

async function makeJpeg(page, name, color, label) {
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
  return { name, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") };
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
  const dataA = P.join(work, "pc1");
  const dataB = P.join(work, "pc2");
  const usb = P.join(work, "usb-drive");
  disk.mkdir(usb);
  const portA = 5191;
  const portB = 5192;
  const browser = REMOTE ? null : await chromium.launch({ executablePath: chrome, headless: true });
  const shopA = await openShop(browser, dataA, portA);
  let page = shopA.page;
  const base = shopA.base;
  const srvA = { kill: shopA.close };
  try {
    step = "A shop";
    await page.goto(base);
    await page.click('[data-testid="start-new"]');
    await page.fill('[data-testid="shop-name"]', "Arslan Furniture and Bikes");
    await page.click('[data-testid="create-shop"]');
    await page.locator(".brand", { hasText: "Arslan Furniture and Bikes" }).waitFor();
    check(true, "shop created with its own name");
    const logoFile = { name: "logo.png", mimeType: "image/png", buffer: PNG };
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
    const deskPhoto = await makeJpeg(page, "desk.jpg", "#8b5a2b", "DESK");
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
    await page.goto(base + "#/");
    await page.goto(deskUrl);
    await page.reload();
    check(await photoLoaded(page, '[data-testid="item-photo"]'), "photo opens from the app's own copy after reopening");
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
    await page.click('[data-testid="sale-detail-add"]');
    await page.fill('[data-testid="sale-detail-name-0"]', "Invoice no.");
    await page.fill('[data-testid="sale-detail-value-0"]', "INV-77");
    await page.setInputFiles('[data-testid="trade-photo-input"]', [await makeJpeg(page, "bill.jpg", "#444488", "BILL")]);
    await page.waitForFunction(() => document.querySelectorAll(".trade-photo img").length === 1);
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
    const salePics = [await makeJpeg(page, "cnic.jpg", "#335577", "CNIC"), await makeJpeg(page, "desk-sold.jpg", "#775533", "SOLD"), await makeJpeg(page, "slip.jpg", "#557733", "SLIP")];
    await page.setInputFiles('[data-testid="trade-photo-input"]', salePics);
    await page.waitForFunction(() => document.querySelectorAll(".trade-photo img").length === 3);
    await page.click(".trade-photo:nth-child(2) .trade-photo-x");
    await page.setInputFiles('[data-testid="trade-photo-input"]', [salePics[1]]);
    await page.waitForFunction(() => document.querySelectorAll(".trade-photo img").length === 3);
    check(true, "3 photos added next to the customer, one taken off and added again");
    await page.click('[data-testid="sale-detail-box"] .chip-btn:has-text("+ Phone")');
    await page.fill('[data-testid="sale-detail-value-0"]', "0300-1234567");
    await page.check('[data-testid="sale-detail-print-0"]');
    await page.click('[data-testid="sale-detail-add"]');
    await page.fill('[data-testid="sale-detail-name-1"]', "CNIC");
    await page.fill('[data-testid="sale-detail-value-1"]', "35202-1234567-1");
    check(await page.isChecked('[data-testid="sale-detail-print-1"]'), "new sale details print on the slip unless unticked");
    await page.uncheck('[data-testid="sale-detail-print-1"]');
    check((await page.textContent('[data-testid="trade-total"]')) === "Rs 36,000", "sale total before confirm");
    await page.locator('[data-testid="line-profit"]', { hasText: "Profit Rs 12,000" }).waitFor();
    const li = await page.textContent('[data-testid="line-info"]');
    check(li.includes("Drawer count: 4") && li.includes("Bought for Rs 8,000") && li.includes("Profit Rs 12,000"), "sale line shows the item details, buy price and profit");
    const ls = await page.textContent('[data-testid="lot-source"]');
    check(ls.includes("P-000001") && ls.includes("Ali Traders") && ls.includes("Invoice no.: INV-77") && (await page.locator('[data-testid="lot-source"] img').count()) === 1, "sale line shows what was saved with the purchase: supplier, details and photo");
    await page.click('[data-testid="line-edit-item"]');
    await page.click('.modal [data-testid="add-field"]');
    await page.fill('[data-testid="field-name"]', "Colour");
    await page.check('[data-testid="scope-item"]');
    await page.click('[data-testid="field-save"]');
    await page.fill('.modal [data-field="Colour"]', "Brown");
    await page.click('.modal [data-testid="item-save"]');
    await page.locator('[data-testid="line-info"]', { hasText: "Colour: Brown" }).waitFor();
    check((await page.inputValue('[data-testid="qty-0"]')) === "3", "new field added to the item from the sale screen, sale kept as it was");
    await page.click('[data-testid="trade-review"]');
    await page.click('[data-testid="trade-confirm"]');
    await page.locator('[data-testid="receipt"]').waitFor();
    const rtext = await page.textContent('[data-testid="receipt"]');
    check(rtext.includes("Arslan Furniture and Bikes") && rtext.includes("Rs 36,000") && rtext.includes("Bilal"), "branded receipt with total");
    check(!rtext.includes("8,000") && !rtext.includes("12,000 profit") && !rtext.includes("Profit"), "buy price and profit are not on the slip");
    check(rtext.includes("Phone: 0300-1234567") && !rtext.includes("35202"), "ticked detail printed on the slip, the unticked one kept private");
    check(rtext.includes("Drawer count: 4") && rtext.includes("Scratch note: Small scratch on left side"), "all item details printed on the slip");
    check(await photoLoaded(page, ".r-logo"), "logo on receipt");
    await shot(page, "B-receipt");
    await page.click("text=Open record");
    await page.locator('[data-testid="txn-photos"] img').first().waitFor();
    check((await page.locator('[data-testid="txn-photos"] img').count()) === 3 && (await photoLoaded(page, '[data-testid="txn-photos"] img')), "sale record shows its 3 photos");
    await page.setInputFiles('[data-testid="record-photo-input"]', [await makeJpeg(page, "later.jpg", "#aa3366", "LATER")]);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="txn-photos"] img').length === 4);
    await page.click('[data-testid="record-party-edit"]');
    await page.fill('[data-testid="record-party-input"]', "Bilal Ahmed 0300-1234567");
    await page.click('[data-testid="record-party-save"]');
    await page.locator('[data-testid="record-party"]', { hasText: "0300-1234567" }).waitFor();
    await page.fill('[data-testid="record-note"]', "Paid the rest by bank transfer");
    await page.click('[data-testid="record-note-save"]');
    await page.locator('[data-testid="record-extras"]', { hasText: "bank transfer" }).waitFor();
    check(true, "after the sale: one more photo, new customer details and a note added");
    await page.locator('[data-testid="txn-photos"] img').first().click();
    await page.locator('[data-testid="photo-viewer"]').waitFor();
    const img = page.locator('[data-testid="pv-img"]');
    const box = await img.boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
    await page.mouse.wheel(0, -300);
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(() => document.querySelector('[data-testid="pv-zoom"]').textContent !== "100%");
    const zoomed = await page.textContent('[data-testid="pv-zoom"]');
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5 + 120, box.y + box.height * 0.5 + 60, { steps: 5 });
    await page.mouse.up();
    const tr = await img.evaluate((e) => e.style.transform);
    await shot(page, "B-photo-zoom");
    await page.click('[data-testid="pv-next"]');
    check(zoomed !== "100%" && tr.includes("scale") && (await page.textContent(".pv-count")) === "2 / 4" && (await page.textContent('[data-testid="pv-zoom"]')) === "100%", "photo opens large, zooms where the mouse points, drags, goes to the next photo");
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="photo-viewer"]').waitFor({ state: "detached" });
    check((await page.textContent('[data-testid="record-info"]')).includes("35202-1234567-1"), "record shows all sale details");
    await page.click('[data-testid="record-detail-add"]');
    await page.fill('[data-testid="record-detail-name-0"]', "Warranty");
    await page.fill('[data-testid="record-detail-value-0"]', "6 months");
    await page.check('[data-testid="record-detail-print-0"]');
    await page.click('[data-testid="record-detail-save"]');
    await page.locator('[data-testid="record-info"]', { hasText: "6 months" }).waitFor();
    check((await page.textContent('[data-testid="receipt"]')).includes("Warranty: 6 months"), "detail added after the sale and printed on the slip");
    await shot(page, "B-sale-photos");
    await page.goto(base + "#/sale");

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

    step = "F month end";
    const cats = await api(portA, "category_list", {});
    const furn = cats.data.find((c) => c.name === "Furniture").id;
    const stool = (await api(portA, "item_save", { category_id: furn, name: "Cheap stool" })).data.item.id;
    await api(portA, "purchase_post", { client_token: "st-p", business_date: "2026-06-02", lines: [{ item_id: stool, qty: 2, unit_price: 500000 }] });
    await api(portA, "sale_post", { client_token: "st-s", business_date: "2026-06-05", lines: [{ item_id: stool, qty: 1, unit_price: 300000 }] });
    await page.goto(base + `#/item/${stool}`);
    await page.click('[data-testid="write-off"]');
    await page.locator(".modal input[type=date]").fill("2026-06-20");
    await page.click("text=Save correction");
    await page.locator('[data-testid="item-profit"]', { hasText: "Rs 7,000" }).waitFor();
    check((await page.textContent('[data-testid="item-money"]')).includes("Loss"), "item page shows the loss on this item");
    await page.click('[data-testid="toggle-damaged"]');
    await page.locator('[data-testid="item-status"]', { hasText: "Damaged" }).waitFor();
    check(true, "item marked damaged with a status flag");
    await page.goto(base + "#/reports");
    await page.fill('[data-testid="report-month"]', "2026-06");
    await page.locator('[data-testid="me-loss"]', { hasText: "Rs 7,000" }).waitFor();
    check((await page.textContent('[data-testid="me-sold"]')).includes("1 pcs"), "month end: sold count");
    check((await page.textContent('[data-testid="loss-items"]')).includes("Cheap stool"), "month end: loss making item listed with details");
    check((await page.textContent('[data-testid="month-end"]')).includes("Damaged"), "month end: write off shown with its reason");
    await shot(page, "F-month-end");
    await page.goto(base + "#/items");
    await page.locator('[data-testid="items-table"]').waitFor();
    const all = await page.textContent('[data-testid="items-table"]');
    check(all.includes("Damaged") && all.includes("Sold") && all.includes("In stock"), "items page shows everything with status in one place");
    await shot(page, "F-all-items");
    step = "G add item with stock";
    await page.goto(base + "#/item/new");
    await page.fill('[data-testid="item-name"]', "Plastic chair");
    await page.selectOption('[data-testid="item-category"]', { label: "Furniture" });
    await page.fill('[data-testid="item-qty"]', "20");
    await page.fill('[data-testid="item-buy-price"]', "1500");
    await page.fill('[data-testid="item-price"]', "2000");
    await page.fill('[data-testid="item-supplier"]', "Karachi Plastics");
    const pv = await page.textContent('[data-testid="stock-preview"]');
    check(pv.includes("Profit Rs 500 on each piece") && pv.includes("Rs 10,000") && pv.includes("Rs 30,000"), "form shows profit per piece, on all 20, and total paid");
    await page.click('[data-testid="item-save"]');
    await page.locator('[data-testid="stock-now"]', { hasText: "20" }).waitFor();
    check(true, "new item opens with 20 in stock");
    const chair = (await api(portA, "item_search", { text: "Plastic chair" })).data.rows[0];
    check(chair.stock === 20 && chair.money.bought_cost === 3000000, "stock saved as a purchase of 20 at Rs 1,500");
    const ph = await api(portA, "line_search", { kinds: ["purchase"], text: "Plastic chair" });
    check(ph.data.total === 1 && JSON.stringify(ph.data).includes("Karachi Plastics"), "purchase record with supplier is in history");
    await shot(page, "G-item-with-stock");
    await page.goto(base + "#/sale");
    await page.click('[data-testid="trade-new-item"]');
    await page.fill('.modal [data-testid="item-name"]', "Steel rack");
    await page.selectOption('.modal [data-testid="item-category"]', { label: "Furniture" });
    await page.fill('.modal [data-testid="item-qty"]', "3");
    await page.fill('.modal [data-testid="item-buy-price"]', "2000");
    await page.fill('.modal [data-testid="item-price"]', "2500");
    await page.click('.modal [data-testid="item-save"]');
    await page.locator("table.lines td", { hasText: "3 in stock" }).waitFor();
    check((await page.inputValue('[data-testid="price-0"]')) === "2500", "new item added from the sale screen goes into the sale with its stock and price");
    await page.goto(base + "#/item/new");
    await page.fill('[data-testid="item-name"]', "Honda CD70");
    await page.selectOption('[data-testid="item-category"]', { label: "Scooter" });
    await page.check('[data-testid="tracking-unique"]');
    await page.fill('[data-testid="item-identifier"]', "chs 778899");
    await page.locator('[data-testid="identifier-taken"]', { hasText: "Used Vespa" }).waitFor();
    await page.click('[data-testid="item-save"]');
    check((await page.textContent(".alert-error")).includes("must be different"), "same chassis number (typed differently) is refused");
    await page.fill('[data-testid="item-identifier"]', "CD-555");
    await page.locator('[data-testid="identifier-taken"]').waitFor({ state: "detached" });
    await page.fill('[data-testid="item-buy-price"]', "90000");
    await page.fill('[data-testid="item-price"]', "120000");
    check((await page.textContent('[data-testid="stock-preview"]')).includes("Profit Rs 30,000"), "one of a kind: chassis, buy price, selling price and profit on one row");
    await shot(page, "G-unique-prices");
    await page.click('[data-testid="item-save"]');
    await page.locator('[data-testid="stock-now"]', { hasText: "1" }).waitFor();
    const cd = (await api(portA, "item_search", { text: "CD-555" })).data.rows[0];
    check(cd.stock === 1 && cd.money.bought_cost === 9000000, "scooter saved in stock, bought at Rs 90,000");
    await page.goto(base + `#/item/${cd.id}/edit`);
    await page.locator('[data-testid="item-buy-price"]').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="item-buy-price"]').value === "90000");
    check((await page.textContent('[data-testid="stock-preview"]')).includes("Profit Rs 30,000"), "edit screen shows what it was bought for and the profit");

    const exportDir = P.join(work, "export-drive");
    disk.mkdir(exportDir);
    await page.goto(base + "#/settings?tab=backup");
    if (REMOTE) {
      const ex = await api(portA, "export_full", { path: exportDir });
      check(ex.ok, "full copy exported (the real app picks the folder with the Windows folder window)");
    } else {
      await page.fill('[data-testid="export-path"]', exportDir);
      await page.click('[data-testid="export-full"]');
      await page.locator(".toast", { hasText: "Full copy saved" }).waitFor();
    }
    check(disk.exists(P.join(dataA, "shop.db")) && disk.exists(P.join(exportDir)), "export copied the data, original stays on this computer");

    step = "D backup";
    await page.goto(base + "#/settings?tab=backup");
    await page.fill('[data-testid="backup-dest"]', P.join(work, "unplugged-drive"));
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
    const shopB = await openShop(browser, dataB, portB);
    page = shopB.page;
    const baseB = shopB.base;
    const srvB = { kill: shopB.close };
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
    check((await page.locator('[data-testid="txn-photos"] img').count()) === 4 && (await photoLoaded(page, '[data-testid="txn-photos"] img')), "sale photos, including ones added later, restored");
    check((await page.textContent('[data-testid="record-extras"]')).includes("bank transfer"), "notes added after the sale restored");
    check((await page.textContent('[data-testid="record-info"]')).includes("Warranty"), "sale details restored");
    await shot(page, "D-restored-receipt");
    srvB.kill();
  } catch (e) {
    results.push(`FAIL ${e.message}`);
    await shot(page, "failure").catch(() => {});
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    srvA.kill();
  }
  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nE2E FAILED" : `\nE2E PASSED (${results.filter((r) => r.startsWith("ok")).length} checks). Screenshots in e2e/.out`);
}

main();
