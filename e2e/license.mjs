import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const py = process.env.PY ?? "python3";

export function activationFor(machineId) {
  const out = execFileSync(py, [path.join(root, "scripts", "make-activation.py"), "--machine-id", machineId], { encoding: "utf8" }).trim().split("\n");
  return { code: out[0].trim(), activation: out[1].trim() };
}

export function licenseThisComputer(licenseDir) {
  const { activation } = activationFor(fs.readFileSync("/etc/machine-id", "utf8"));
  fs.mkdirSync(licenseDir, { recursive: true });
  fs.writeFileSync(path.join(licenseDir, "license.txt"), activation);
  return activation;
}
