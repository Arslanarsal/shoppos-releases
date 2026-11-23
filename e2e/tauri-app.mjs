import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activationFor } from "./license.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.APP_BIN ?? path.join(root, "target", "debug", "shoppos");
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
    throw new Error(`timed out waiting for ${what}. Screen: ${(await text().catch(() => "?")).slice(0, 300)}`);
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
  const base = { SHOPPOS_DATA_DIR: data };

  {
    const a = await startApp(base);
    try {
      await a.until(async () => (await a.text()).includes("not activated"), "activation screen");
      const code = await a.js("return document.querySelector('[data-testid=computer-code]').textContent.trim()");
      check(!fs.existsSync(path.join(data, "shop.db")), "lock: on a computer without activation the shop does not open");
      const other = activationFor("some-other-computer").activation;
      await a.set('[data-testid="activation-input"]', other);
      await a.click('[data-testid="activation-save"]');
      await a.until(async () => (await a.text()).includes("not for this computer"), "wrong code message");
      check(true, "lock: an activation code made for another computer is refused");
      const { code: mine, activation } = activationFor(fs.readFileSync("/etc/machine-id", "utf8"));
      check(code === mine, `lock: the screen shows this computer's code ${code}`);
      await a.set('[data-testid="activation-input"]', activation);
      await a.click('[data-testid="activation-save"]');
      await a.until(async () => (await a.text()).includes("Welcome to ShopPOS"), "welcome after activation");
      check(fs.existsSync(path.join(work, "ShopPOS License", "license.txt")), "lock: the right code opens the shop and is remembered");
    } finally {
      await a.close();
    }
  }

  {
    const a = await startApp({ ...base, SHOPPOS_UPDATE_URL: "http://127.0.0.1:9/latest.json" });
    try {
      await a.until(async () => (await a.text()).includes("Welcome to ShopPOS"), "welcome screen");
      const secs = (Date.now() - a.t0) / 1000;
      check(secs < 20, `offline: app opened in ${secs.toFixed(1)} s with the update server unreachable`);
      await a.click('[data-testid="start-new"]');
      await a.until(() => a.js("return !!document.querySelector('[data-testid=shop-name]')"), "name box");
      await a.set('[data-testid="shop-name"]', "Offline Shop");
      await a.click('[data-testid="create-shop"]');
      await a.until(async () => (await a.text()).includes("Offline Shop"), "home");
      const cat = await a.call("category_create", { name: "Chairs" });
      const it = await a.call("item_save", { category_id: cat.data.id, name: "Plastic chair", sale_price: 150000 });
      await a.call("purchase_post", { client_token: "p1", business_date: "2026-01-10", lines: [{ item_id: it.data.item.id, qty: 20, unit_price: 90000 }] });
      await a.js("window.location.hash = '#/sale'; return true");
      await a.until(() => a.js("return !!document.querySelector('[data-testid=item-picker]')"), "sale screen");
      await a.set('[data-testid="item-picker"]', "Plastic");
      await a.until(() => a.js("return !!document.querySelector('.picker-row')"), "picker results");
      await a.click(".picker-row");
      await a.set('[data-testid="qty-0"]', "2");
      await a.click('[data-testid="trade-review"]');
      await a.until(() => a.js("return !!document.querySelector('[data-testid=trade-confirm]')"), "confirm");
      await a.click('[data-testid="trade-confirm"]');
      await a.until(() => a.js("return !!document.querySelector('[data-testid=receipt]')"), "receipt");
      const r = await a.text();
      check(r.includes("Rs 3,000") && r.includes("S-000001"), "offline: sale completed and receipt shown in the real app");
      const log = fs.readFileSync(path.join(data, "logs", "updates.log"), "utf8");
      check(log.includes("update check failed"), "offline: update failure logged, app kept working");
    } catch (e) {
      check(false, `offline scenario: ${e.message}`);
    } finally {
      await a.close();
    }
  }

  {
    const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
    const wrongSig = fs.readFileSync(process.env.WRONG_SIG_FILE, "utf8").trim();
    const feed = {
      version: "99.0.0",
      notes: "test",
      pub_date: new Date().toISOString(),
      platforms: Object.fromEntries(["linux-x86_64", "windows-x86_64", "linux-x86_64-appimage"].map((k) => [k, { signature: wrongSig, url: "http://127.0.0.1:9466/fake-update" }])),
    };
    const srv = await feedServer(9466, feed);
    const a = await startApp({ ...base, SHOPPOS_UPDATE_URL: "http://127.0.0.1:9466/latest.json", APPIMAGE: "" });
    try {
      await a.until(async () => (await a.text()).includes("Offline Shop"), "shop opened after refused update", 60000);
      const t = await a.text();
      check(t.includes("could not be installed safely") || t.includes("Offline Shop"), "bad signature: app opened on the current version");
      const log = fs.readFileSync(path.join(data, "logs", "updates.log"), "utf8");
      const line = log.trim().split("\n").filter((l) => l.includes("99.0.0")).pop() ?? "";
      check(line.includes("rejected or failed"), `bad signature: update refused (${line.replace(/^.*rejected or failed: /, "")})`);
      check(!log.includes("installed 99.0.0"), "bad signature: nothing installed");
      const st = await a.call("item_search", { text: "Plastic" });
      check(st.data.rows[0].stock === 18, "bad signature: data untouched (18 chairs)");
    } catch (e) {
      check(false, `bad signature scenario: ${e.message}`);
    } finally {
      await a.close();
      srv.close();
    }
  }

  {
    const before = fs.readFileSync(path.join(data, "shop.db"));
    const a = await startApp({ ...base, SHOPPOS_NO_UPDATE: "1", SHOPPOS_TEST_BAD_MIGRATION: "1" });
    try {
      await a.until(async () => (await a.text()).includes("The update could not prepare your data"), "recovery screen");
      const t = await a.text();
      check(t.includes("left exactly as it was"), "failed migration: recovery screen explains data is unchanged");
    } catch (e) {
      check(false, `failed migration scenario: ${e.message}`);
    } finally {
      await a.close();
    }
    check(fs.existsSync(path.join(data, "backups", "before-update")), "failed migration: safety copy made before trying");
    const b = await startApp({ ...base, SHOPPOS_NO_UPDATE: "1" });
    try {
      await b.until(async () => (await b.text()).includes("Offline Shop"), "normal start");
      const st = await b.call("item_search", { text: "Plastic" });
      check(st.data.rows[0].stock === 18, "failed migration: previous version opens the same data (18 chairs)");
    } catch (e) {
      check(false, `after failed migration: ${e.message}`);
    } finally {
      await b.close();
    }
    void before;
  }

  console.log(results.join("\n"));
  console.log(failed ? "\nREAL APP TESTS FAILED" : `\nREAL APP TESTS PASSED (${results.length} checks)`);
  process.exitCode = failed ? 1 : 0;
}

main();
