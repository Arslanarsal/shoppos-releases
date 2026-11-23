import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
  console.error("Usage: npm run version:set -- 1.2.3");
  process.exit(1);
}

const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = v;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const confPath = path.join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
conf.version = v;
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

for (const toml of ["src-tauri/Cargo.toml", "Cargo.toml"]) {
  const p = path.join(root, toml);
  const s = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, s.replace(/^version = "\d+\.\d+\.\d+"/m, `version = "${v}"`));
}
console.log(`Version set to ${v}`);
