import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string } };

export async function call<T = any>(cmd: string, args: unknown = {}): Promise<T> {
  let res: Envelope;
  if (isTauri) {
    res = await invoke<Envelope>("call", { cmd, args });
  } else {
    const r = await fetch(`/api/${cmd}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args ?? {}) });
    res = await r.json();
  }
  if (!res.ok) {
    throw new ApiError(res.error?.code ?? "error", res.error?.message ?? "Something went wrong");
  }
  return res.data as T;
}

export function fileUrl(rel: string | null | undefined): string {
  if (!rel) return "";
  if (isTauri) return convertFileSrc(rel, "shopfile");
  return `/files/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

export function newToken(): string {
  if (crypto && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export async function uploadImage(cmd: "photo_store" | "logo_store", file: File) {
  const data = await readAsDataUrl(file);
  return call(cmd, { name: file.name, data });
}

export async function pickFolder(title: string): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: false, title });
  return typeof r === "string" ? r : null;
}

export async function exportCsv(fileName: string, kind: string, params: unknown): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: fileName, filters: [{ name: "CSV spreadsheet", extensions: ["csv"] }] });
    if (!path) return null;
    await call("export_csv", { kind, params, path });
    return path;
  }
  const r = await call<{ csv: string }>("export_csv", { kind, params });
  const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return fileName;
}

export type UpdateResult = { status: string; message?: string; version?: string };

export async function runUpdate(onProgress: (p: any) => void): Promise<UpdateResult> {
  if (!isTauri) return { status: "disabled" };
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen("update-progress", (e) => onProgress(e.payload));
  try {
    return await invoke<UpdateResult>("update_run");
  } catch (e) {
    return { status: "error", message: String(e) };
  } finally {
    un();
  }
}

export type LicenseStatus = { ok: boolean; computer_code: string };

export async function licenseStatus(): Promise<LicenseStatus> {
  if (!isTauri) return { ok: true, computer_code: "" };
  return invoke<LicenseStatus>("license_status");
}

export async function licenseActivate(code: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_activate", { code });
}
