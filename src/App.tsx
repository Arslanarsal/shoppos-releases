import { DeveloperCard } from "./components/Developer";
import Icon from "./components/Icon";
import { PhotoHost } from "./components/PhotoViewer";
import { useCallback, useEffect, useState } from "react";
import { call, fileUrl, isTauri, runUpdate, licenseStatus } from "./api";
import { ago, setFormat, Settings } from "./format";
import { AppCtx, go, useApp, useRoute, useToasts } from "./ui";
import Home from "./pages/Home";
import ItemsPage from "./pages/Items";
import ItemEdit from "./pages/ItemEdit";
import ItemView from "./pages/ItemView";
import TradePage from "./pages/Trade";
import HistoryPage from "./pages/History";
import TxnPage from "./pages/Txn";
import ReportsPage from "./pages/Reports";
import CategoriesPage from "./pages/Categories";
import SettingsPage from "./pages/Settings";
import { Activate, Welcome, Problem } from "./pages/Startup";

type Boot = { phase: "update" | "opening" | "done" | "locked"; state?: any; update?: string; code?: string };

export function applyLook(s: Partial<Settings>) {
  const root = document.documentElement;
  root.dataset.theme = s.theme === "dark" ? "dark" : "light";
  if (s.accent) root.style.setProperty("--accent", s.accent);
  const w = window.screen?.width || window.innerWidth;
  const screenScale = w >= 3000 ? 1.25 : w >= 2400 ? 1.15 : w >= 1800 ? 1.05 : 1;
  root.style.fontSize = `${Math.round(16 * Number(s.font_scale ?? 1) * screenScale)}px`;
  document.title = s.shop_name ? `${s.shop_name} - ShopPOS` : "ShopPOS";
}

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "update" });
  const startup = useCallback(async () => {
    setBoot({ phase: "update", update: "Checking for a newer version..." });
    const u = await runUpdate((p) => {
      if (p.phase === "download") {
        const pct = p.total ? ` ${Math.round((100 * p.received) / p.total)}%` : "";
        setBoot({ phase: "update", update: `Downloading the new version${pct}. Please wait.` });
      } else if (p.phase === "restart") {
        setBoot({ phase: "update", update: "Installing the new version. The app will open again by itself." });
      }
    });
    const lic = await licenseStatus().catch(() => ({ ok: false, computer_code: "" }));
    if (!lic.ok) {
      setBoot({ phase: "locked", code: lic.computer_code });
      return;
    }
    setBoot({ phase: "opening", update: u.status === "failed" ? `An update was found but not installed (${u.message}). You are using the current version.` : "" });
    const st = await call("open");
    setBoot({ phase: "done", state: st, update: u.status === "failed" ? `An update was found but could not be installed safely, so the current version was kept. (${u.message})` : "" });
  }, []);

  useEffect(() => {
    startup();
  }, [startup]);

  if (boot.phase === "locked") return <Activate code={boot.code ?? ""} onDone={startup} />;
  if (boot.phase !== "done") {
    return (
      <div className="boot">
        <div className="boot-card">
          <div className="spinner" />
          <h1>ShopPOS</h1>
          <p>{boot.phase === "update" ? boot.update : "Opening your shop..."}</p>
        </div>
      </div>
    );
  }
  const st = boot.state;
  if (st.state === "new") return <Welcome onDone={startup} />;
  if (st.state !== "ready") return <Problem state={st} onRetry={startup} />;
  return <Main updateNote={boot.update ?? ""} migratedFrom={st.migrated_from} />;
}

function Main(props: { updateNote: string; migratedFrom: number | null }) {
  const { toast, view } = useToasts();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [backup, setBackup] = useState<any>(null);
  const [appInfo, setAppInfo] = useState<any>(null);
  const route = useRoute();

  const reloadSettings = useCallback(async () => {
    const s = await call<Settings>("settings_get");
    setFormat(s);
    applyLook(s);
    setSettings(s);
  }, []);
  const reloadBackup = useCallback(async () => {
    try {
      setBackup(await call("backup_status"));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    reloadSettings();
    call("app_info").then(setAppInfo);
    call("backup_if_due").finally(reloadBackup);
    const t = setInterval(reloadBackup, 60_000);
    return () => clearInterval(t);
  }, [reloadSettings, reloadBackup]);

  useEffect(() => {
    if (props.updateNote) toast(props.updateNote, "info");
    if (props.migratedFrom) toast("The app was updated. Your data was checked and kept safe.", "ok");
  }, [props.updateNote, props.migratedFrom, toast]);

  if (!settings) return <div className="boot"><div className="spinner" /></div>;

  const seg = route.path.split("/").filter(Boolean);
  let page;
  switch (seg[0] ?? "") {
    case "":
      page = <Home />;
      break;
    case "sale":
      page = <TradePage key={`sale-${route.query.get("item") ?? ""}`} mode="sale" preset={route.query.get("item")} />;
      break;
    case "purchase":
      page = <TradePage key={`purchase-${route.query.get("item") ?? ""}`} mode="purchase" preset={route.query.get("item")} />;
      break;
    case "items":
      page = <ItemsPage query={route.query} />;
      break;
    case "item":
      if (seg[1] === "new") page = <ItemEdit key="new" categoryId={route.query.get("category")} />;
      else if (seg[2] === "edit") page = <ItemEdit key={`e${seg[1]}`} id={Number(seg[1])} />;
      else page = <ItemView key={seg[1]} id={Number(seg[1])} />;
      break;
    case "history":
      page = <HistoryPage key={route.query.toString()} query={route.query} />;
      break;
    case "txn":
      page = <TxnPage key={seg[1]} id={Number(seg[1])} />;
      break;
    case "reports":
      page = <ReportsPage />;
      break;
    case "categories":
      page = <CategoriesPage selected={route.query.get("id")} />;
      break;
    case "settings":
      page = <SettingsPage tab={route.query.get("tab") ?? "shop"} />;
      break;
    default:
      page = <Home />;
  }

  const nav = [
    { to: "/", label: "Home", icon: "home" },
    { to: "/sale", label: "Make sale", icon: "sale", primary: true },
    { to: "/purchase", label: "Record purchase", icon: "purchase" },
    { to: "/items", label: "Items & stock", icon: "items" },
    { to: "/item/new", label: "Add item", icon: "add" },
    { to: "/history", label: "History", icon: "history" },
    { to: "/reports", label: "Reports", icon: "reports" },
    { to: "/categories", label: "Categories & fields", icon: "categories" },
    { to: "/settings", label: "Settings", icon: "settings" },
  ];
  const active = (to: string) => (to === "/" ? route.path === "/" : route.path === to || (to === "/items" && route.path.startsWith("/item/") && !route.path.startsWith("/item/new")));

  return (
    <AppCtx.Provider value={{ settings, reloadSettings, toast, backup, reloadBackup, appInfo }}>
      <div className="shell">
        <aside className="side no-print">
          <div className="brand" onClick={() => go("/")}>
            {settings.shop_logo ? <img src={fileUrl(settings.shop_logo)} alt="" /> : <div className="brand-mark">{settings.shop_name.slice(0, 1)}</div>}
            <span>{settings.shop_name}</span>
          </div>
          <nav>
            {nav.map((n) => (
              <a key={n.to} href={`#${n.to}`} className={`nav ${active(n.to) ? "nav-on" : ""} ${n.primary ? "nav-primary" : ""}`}>
                <span className="nav-icon" aria-hidden>
                  <Icon name={n.icon} />
                </span>
                {n.label}
              </a>
            ))}
          </nav>
          <BackupBadge />
          <DeveloperCard compact />
          {!isTauri && <div className="dev-note">Browser test mode</div>}
        </aside>
        <main className="content">
          <BackupBanner />
          {page}
        </main>
      </div>
      {view}
      <PhotoHost />
    </AppCtx.Provider>
  );
}

function BackupBadge() {
  const { backup } = useApp();
  if (!backup) return null;
  const ok = backup.last_success_at && !backup.last_error && backup.dest_chosen;
  return (
    <a href="#/settings?tab=backup" className={`backup-badge ${ok ? "ok" : "warn"}`}>
      <strong>Backup</strong>
      <span>{backup.last_success_at ? `Last saved ${ago(backup.last_success_at)}` : "Not backed up yet"}</span>
    </a>
  );
}

function BackupBanner() {
  const { backup } = useApp();
  if (!backup) return null;
  let text = "";
  if (backup.last_error && backup.dest_chosen && !backup.dest_available) text = backup.last_error;
  else if (backup.last_error) text = `The last backup did not finish: ${backup.last_error}`;
  else if (backup.minutes_since_success !== null && backup.minutes_since_success > 60 * 48) text = `The last backup was ${ago(backup.last_success_at)}.`;
  if (!text) return null;
  return (
    <div className="alert alert-warn banner no-print">
      <span>{text}</span>
      <a className="btn btn-small" href="#/settings?tab=backup">
        Backup settings
      </a>
    </div>
  );
}
