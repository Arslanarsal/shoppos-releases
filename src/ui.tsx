import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import type { Settings } from "./format";

export type FieldDef = {
  id: number;
  category_id: number | null;
  item_id: number | null;
  name: string;
  kind: string;
  unit: string;
  options: string[];
  required: boolean;
  group_name: string;
  sort_order: number;
  show_in_list: boolean;
  show_on_receipt: boolean;
  archived: boolean;
};

export type Category = { id: number; name: string; archived: boolean; item_count: number; field_count: number };

export function parseHash(): { path: string; query: URLSearchParams } {
  const h = window.location.hash.replace(/^#/, "") || "/";
  const [path, q] = h.split("?");
  return { path: path || "/", query: new URLSearchParams(q ?? "") };
}

export function go(path: string, query?: Record<string, unknown>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = q.toString();
  window.location.hash = `${path}${s ? "?" + s : ""}`;
}

export function useRoute() {
  const [r, setR] = useState(parseHash());
  useEffect(() => {
    const on = () => setR(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

type Toast = { id: number; text: string; kind: "ok" | "error" | "info" };

type Ctx = {
  settings: Settings;
  reloadSettings: () => Promise<void>;
  toast: (text: string, kind?: Toast["kind"]) => void;
  backup: any;
  reloadBackup: () => Promise<void>;
  appInfo: any;
};

export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 4000);
  }, []);
  const view = (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
          {t.text}
        </div>
      ))}
    </div>
  );
  return { toast, view };
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [props]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? "modal-wide" : ""}`} role="dialog" aria-label={props.title}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="btn btn-ghost" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function Label(props: { text: string; hint?: string; children: ReactNode; required?: boolean }) {
  return (
    <label className="lbl">
      <span className="lbl-text">
        {props.text}
        {props.required && <span className="req"> *</span>}
      </span>
      {props.children}
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

export function Tabs(props: { tabs: { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {props.tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={props.value === t.key} className={`tab ${props.value === t.key ? "tab-on" : ""}`} onClick={() => props.onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Empty(props: { children: ReactNode }) {
  return <div className="empty">{props.children}</div>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn()
      .then((d) => live && (setData(d), setError("")))
      .catch((e) => live && setError(String(e?.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

export function ErrorBox(props: { text: string }) {
  if (!props.text) return null;
  return <div className="alert alert-error">{props.text}</div>;
}
