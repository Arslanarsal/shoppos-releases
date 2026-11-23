import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { licenseThisComputer } from "./license.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let app = path.join(root, "target", "debug", "shoppos");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "shoppos-app-"));
const results = [];
let failed = false;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, url, body) {
  const r = await fetch(`http://127.0.0.1:4444${url}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${j.value.error}: ${j.value.message}`);
  return j.value;
}

async function startApp(env) {
  const drv = spawn("tauri-driver", ["--port", "4444"], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"] });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch("http://127.0.0.1:4444/status");
      break;
    } catch {
      await wait(200);
    }
  }
  const t0 = Date.now();
  const s = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } });
  const sid = s.sessionId;
  const js = (script, ...args) => wd("POST", `/session/${sid}/execute/sync`, { script, args });
  const until = async (fn, what, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {
        /* retry */
      }
      await wait(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const text = () => js("return document.body.innerText");
  const call = (cmd, args = {}) => js("return window.__TAURI_INTERNALS__.invoke('call', {cmd: arguments[0], args: arguments[1]})", cmd, args);
  const set = (sel, val) =>
    js(
      `const el=document.querySelector(arguments[0]); if(!el) throw new Error('no '+arguments[0]);
       const p = el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
       Object.getOwnPropertyDescriptor(p,'value').set.call(el, arguments[1]);
       el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true;`,
      sel,
      val,
    );
  const click = (sel) => js(`const el=document.querySelector(arguments[0]); if(!el) throw new Error('no '+arguments[0]); el.click(); return true;`, sel);
  const close = async () => {
    try {
      await wd("DELETE", `/session/${sid}`);
    } catch {
      /* ignore */
    }
    drv.kill();
    await wait(800);
  };
  return { js, until, text, call, set, click, close, t0 };
}

function check(cond, msg) {
  results.push(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failed = true;
}

function feedServer(port, feed) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/latest.json")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(feed));
    } else if (req.url.startsWith("/fake-update")) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.alloc(200000, 7));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

async function main() {
  const data = path.join(work, "data");
  const env = { SHOPPOS_DATA_DIR: data, SHOPPOS_NO_UPDATE: "1" };
  licenseThisComputer(path.join(work, "ShopPOS License"));
  app = process.env.OLD_BIN;
  const a = await startApp(env);
  let receiptBefore;
  try {
    await a.until(async () => (await a.text()).includes("Welcome to ShopPOS"), "welcome");
    await a.click('[data-testid="start-new"]');
    await a.until(() => a.js("return !!document.querySelector('[data-testid=shop-name]')"), "name box");
    await a.set('[data-testid="shop-name"]', "Upgrade Shop");
    await a.click('[data-testid="create-shop"]');
    await a.until(async () => (await a.text()).includes("Upgrade Shop"), "home");
    const cat = await a.call("category_create", { name: "Wardrobes" });
    const f = await a.call("field_create", { category_id: cat.data.id, name: "Drawers", kind: "int" });
    const it = await a.call("item_save", { category_id: cat.data.id, name: "Oak wardrobe", values: { [f.data.id]: 3 } });
    await a.call("purchase_post", { client_token: "u1", business_date: "2026-02-01", lines: [{ item_id: it.data.item.id, qty: 4, unit_price: 2000000 }] });
    const s = await a.call("sale_post", { client_token: "u2", business_date: "2026-02-10", lines: [{ item_id: it.data.item.id, qty: 1, unit_price: 2600000 }] });
    receiptBefore = (await a.call("txn_get", { id: s.data.id })).data;
    const info = await a.call("app_info");
    check(info.data.latest_schema === 2, "old version (data version 2) created a shop with data");
  } catch (e) {
    check(false, `old version: ${e.message}`);
  } finally {
    await a.close();
  }
  app = path.join(root, "target", "debug", "shoppos");
  const b = await startApp(env);
  try {
    await b.until(async () => (await b.text()).includes("Upgrade Shop"), "new version opened", 60000);
    const info = await b.call("app_info");
    check(info.data.latest_schema === 3, "new version upgraded the data to version 3");
    const r = (await b.call("txn_get", { id: receiptBefore.id })).data;
    check(JSON.stringify(r) === JSON.stringify(receiptBefore), "receipt identical after upgrade");
    const items = await b.call("item_search", { text: "Oak" });
    const row = items.data.rows[0];
    check(row.stock === 3 && row.status === "in_stock", "stock kept and new status works on old data");
    check(row.money.profit === 600000, "profit of old sale shown (Rs 6,000)");
    const g = await b.call("item_get", { id: row.id });
    check(Object.values(g.data.values).includes(3), "custom field kept");
    const safety = fs.readdirSync(path.join(data, "backups", "before-update"));
    check(safety.some((d) => d.includes("v2-to-v3")), `checked safety copy made before upgrading (${safety[0]})`);
  } catch (e) {
    check(false, `new version: ${e.message}`);
  } finally {
    await b.close();
  }
  console.log(results.join("\n"));
  console.log(failed ? "\nUPGRADE TEST FAILED" : `\nUPGRADE TEST PASSED (${results.length} checks)`);
  process.exitCode = failed ? 1 : 0;
}

main();
