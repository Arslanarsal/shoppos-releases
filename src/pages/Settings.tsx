import { useEffect, useRef, useState } from "react";
import { applyLook } from "../App";
import { call, fileUrl, isTauri, pickFolder, uploadImage } from "../api";
import { Receipt } from "../components/Pickers";
import { DeveloperCard } from "../components/Developer";
import RestoreWizard from "../components/RestoreWizard";
import { ago, dateTime, Settings, todayIso } from "../format";
import { ErrorBox, Label, Modal, Tabs, go, useApp } from "../ui";

export default function SettingsPage(props: { tab: string }) {
  const { settings, reloadSettings, toast, backup, reloadBackup, appInfo } = useApp();
  const [s, setS] = useState<Settings>(settings);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [restore, setRestore] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  useEffect(() => setS(settings), [settings]);
  const set = (p: Partial<Settings>) => setS((x) => ({ ...x, ...p }));

  const save = async (patch?: Partial<Settings>) => {
    setError("");
    try {
      await call("settings_set", patch ?? s);
      await reloadSettings();
      await reloadBackup();
      toast("Settings saved");
    } catch (e: any) {
      setError(e.message);
    }
  };

  const logo = async (files: FileList | null) => {
    if (!files?.[0]) return;
    try {
      await uploadImage("logo_store", files[0]);
      await reloadSettings();
      toast("Logo saved");
    } catch (e: any) {
      setError(e.message);
    }
  };

  const backupNow = async (deep: boolean) => {
    setError("");
    setBusy(deep ? "Making a backup and checking every file..." : "Making a backup...");
    try {
      const r = await call("backup_now", { deep });
      toast(`Backup finished and checked (${r.files} photos and logos)`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
      reloadBackup();
    }
  };

  const [exportPath, setExportPath] = useState("");
  const exportCopy = async (path: string) => {
    setError("");
    setBusy("Copying all records, photos and settings, then checking the copy...");
    try {
      const r = await call("export_full", { path });
      toast(`Full copy saved and checked in ${r.path}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };
  const chooseExport = async () => {
    const p = await pickFolder("Choose where to save a full copy");
    if (p) exportCopy(p);
  };

  const chooseDrive = async () => {
    const p = await pickFolder("Choose your backup drive or folder");
    if (p) {
      set({ backup_dest: p });
      await save({ ...s, backup_dest: p });
      backupNow(true);
    }
  };

  const sample = {
    kind: "sale",
    number: "S-000123",
    business_date: todayIso(),
    party: "Sample customer",
    subtotal: 3600000,
    discount: 0,
    total: 3600000,
    snapshot: { ...s },
    lines: [{ id: 1, description: "Office desk", details: [{ name: "Drawers", value: "4" }], qty: 3, unit_price: 1200000, line_discount: 0, net: 3600000 }],
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <Tabs
        tabs={[
          { key: "shop", label: "Shop" },
          { key: "receipt", label: "Receipt" },
          { key: "look", label: "Look" },
          { key: "backup", label: "Backups" },
          { key: "about", label: "About" },
        ]}
        value={props.tab}
        onChange={(t) => go("/settings", { tab: t })}
      />
      <ErrorBox text={error} />
      {props.tab === "shop" && (
        <div className="card stack">
          <div className="row">
            {settings.shop_logo ? <img className="logo-preview" src={fileUrl(settings.shop_logo)} alt="Logo" data-testid="logo-preview" /> : <div className="logo-preview empty">No logo</div>}
            <button className="btn" onClick={() => logoInput.current?.click()}>
              {settings.shop_logo ? "Change logo" : "Add logo"}
            </button>
            <input ref={logoInput} type="file" accept="image/*" hidden onChange={(e) => logo(e.target.files)} data-testid="logo-input" />
          </div>
          <Label text="Shop name" required>
            <input value={s.shop_name} onChange={(e) => set({ shop_name: e.target.value })} data-testid="set-shop-name" />
          </Label>
          <Label text="Address">
            <textarea rows={2} value={s.shop_address} onChange={(e) => set({ shop_address: e.target.value })} />
          </Label>
          <div className="row">
            <Label text="Phone">
              <input value={s.shop_phone} onChange={(e) => set({ shop_phone: e.target.value })} />
            </Label>
            <Label text="Email">
              <input value={s.shop_email} onChange={(e) => set({ shop_email: e.target.value })} />
            </Label>
          </div>
          <div className="row">
            <Label text="Money sign">
              <input value={s.currency_symbol} onChange={(e) => set({ currency_symbol: e.target.value })} style={{ width: 100 }} />
            </Label>
            <Label text="Currency code">
              <input value={s.currency_code} onChange={(e) => set({ currency_code: e.target.value })} style={{ width: 100 }} />
            </Label>
            <Label text="Show paisa / cents">
              <select value={s.money_decimals} onChange={(e) => set({ money_decimals: Number(e.target.value) })}>
                <option value={0}>No</option>
                <option value={2}>Yes</option>
              </select>
            </Label>
            <Label text="Date style">
              <select value={s.date_format} onChange={(e) => set({ date_format: e.target.value })}>
                <option value="DD/MM/YYYY">31/12/2026</option>
                <option value="MM/DD/YYYY">12/31/2026</option>
                <option value="DD MMM YYYY">31 Dec 2026</option>
                <option value="YYYY-MM-DD">2026-12-31</option>
              </select>
            </Label>
          </div>
          <div>
            <button className="btn btn-primary" onClick={() => save()} data-testid="settings-save">
              Save
            </button>
          </div>
        </div>
      )}
      {props.tab === "receipt" && (
        <div className="split">
          <div className="card stack grow">
            <Label text="Text at the top of receipts">
              <textarea rows={2} value={s.receipt_header} onChange={(e) => set({ receipt_header: e.target.value })} />
            </Label>
            <Label text="Text at the bottom of receipts">
              <textarea rows={2} value={s.receipt_footer} onChange={(e) => set({ receipt_footer: e.target.value })} />
            </Label>
            <label className="check">
              <input type="checkbox" checked={s.receipt_show_logo} onChange={(e) => set({ receipt_show_logo: e.target.checked })} /> Print the logo
            </label>
            <label className="check">
              <input type="checkbox" checked={s.receipt_watermark !== false} onChange={(e) => set({ receipt_watermark: e.target.checked })} data-testid="set-watermark" /> Light tractor picture behind the receipt
            </label>
            <p className="muted">To choose which item details are printed, open Categories & fields, press Change on a field and tick Print on receipts.</p>
            <div>
              <button className="btn btn-primary" onClick={() => save()}>
                Save
              </button>
            </div>
          </div>
          <div className="receipt-wrap">
            <Receipt txn={sample} />
          </div>
        </div>
      )}
      {props.tab === "look" && (
        <div className="card stack">
          <div className="row">
            <Label text="Colours">
              <select
                value={s.theme}
                onChange={(e) => {
                  set({ theme: e.target.value as Settings["theme"] });
                  applyLook({ ...s, theme: e.target.value as Settings["theme"] });
                }}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </Label>
            <Label text="Main colour">
              <input
                type="color"
                value={s.accent}
                onChange={(e) => {
                  set({ accent: e.target.value });
                  applyLook({ ...s, accent: e.target.value });
                }}
              />
            </Label>
            <Label text="Text size">
              <select
                value={String(s.font_scale)}
                onChange={(e) => {
                  set({ font_scale: Number(e.target.value) });
                  applyLook({ ...s, font_scale: Number(e.target.value) });
                }}
              >
                <option value="1">Normal</option>
                <option value="1.15">Large</option>
                <option value="1.3">Extra large</option>
              </select>
            </Label>
          </div>
          <div>
            <button className="btn btn-primary" onClick={() => save()}>
              Save
            </button>
          </div>
        </div>
      )}
      {props.tab === "backup" && (
        <div className="card stack">
          <div className={`alert ${backup?.last_error ? "alert-warn" : backup?.last_success_at ? "alert-ok" : "alert-info"}`} data-testid="backup-state">
            {backup?.last_success_at ? (
              <>
                Last backup finished and checked: <strong>{dateTime(backup.last_success_at)}</strong> ({ago(backup.last_success_at)}).
              </>
            ) : (
              <>No backup has finished yet.</>
            )}
            {backup?.last_error && (
              <div>
                <strong>Problem:</strong> {backup.last_error}
              </div>
            )}
          </div>
          <p>
            Backups copy all your records, photos, logo and settings to a second drive. The app makes one by itself every {s.backup_interval_minutes} minutes while it is open, checks it, and keeps
            older copies too. Keep the backup drive plugged in, or plug it in once a day.
          </p>
          <div className="row">
            <Label text="Backup drive or folder" hint={backup?.dest_chosen ? "" : "Not chosen yet. Backups are only kept on this computer."}>
              <input value={s.backup_dest} onChange={(e) => set({ backup_dest: e.target.value })} placeholder={isTauri ? "E:\\" : "/media/usb"} style={{ minWidth: 320 }} data-testid="backup-dest" />
            </Label>
            {isTauri && (
              <button className="btn" onClick={chooseDrive}>
                Choose drive...
              </button>
            )}
            <button className="btn" onClick={() => save()} data-testid="backup-dest-save">
              Save
            </button>
          </div>
          <Label text="Make a backup every">
            <select value={s.backup_interval_minutes} onChange={(e) => save({ ...s, backup_interval_minutes: Number(e.target.value) })}>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={180}>3 hours</option>
              <option value={720}>12 hours</option>
            </select>
          </Label>
          {busy && <div className="alert alert-info">{busy}</div>}
          <div className="row">
            <button className="btn btn-primary" onClick={() => backupNow(false)} disabled={!!busy} data-testid="backup-now">
              Back up now
            </button>
            <button className="btn" onClick={() => backupNow(true)} disabled={!!busy}>
              Back up and check every photo
            </button>
            <button className="btn" onClick={() => setRestore(true)}>
              Restore from a backup...
            </button>
          </div>
          <h3>Export or move your data</h3>
          <p>
            Your shop data always stays on this computer. If you want a copy somewhere else (another drive, a new computer), save a full copy. Open ShopPOS on the other computer and choose
            Restore from backup to use it there. Nothing is moved or removed from this computer.
          </p>
          <div className="row">
            {isTauri ? (
              <button className="btn" onClick={chooseExport} disabled={!!busy} data-testid="export-full">
                Export a full copy...
              </button>
            ) : (
              <>
                <Label text="Folder for the copy">
                  <input value={exportPath} onChange={(e) => setExportPath(e.target.value)} data-testid="export-path" />
                </Label>
                <button className="btn" onClick={() => exportCopy(exportPath)} disabled={!!busy || !exportPath} data-testid="export-full">
                  Export a full copy
                </button>
              </>
            )}
          </div>
          <p className="muted small">Shop data on this computer: {appInfo?.data_dir}</p>
        </div>
      )}
      {props.tab === "about" && (
        <div className="card stack">
          <p>
            ShopPOS version <strong>{appInfo?.app_version}</strong> (data version {appInfo?.latest_schema})
          </p>
          <p>The app checks for a new version every time it opens. To update: close the app and open it again.</p>
          <p className="muted small">Shop data folder: {appInfo?.data_dir}</p>
          <IntegrityCheck />
          <DeveloperCard />
        </div>
      )}
      {restore && (
        <Modal title="Restore from a backup" onClose={() => setRestore(false)} wide>
          <RestoreWizard onDone={() => window.location.reload()} warnReplace />
        </Modal>
      )}
    </div>
  );
}

function IntegrityCheck() {
  const [r, setR] = useState<any>(null);
  return (
    <div className="row">
      <button className="btn" onClick={() => call("integrity_check").then(setR)}>
        Check shop data
      </button>
      {r && <span>{r.ok ? `All good. ${r.counts.items} items, ${r.counts.txns} transactions.` : "Problem found. Restore from your backup drive."}</span>}
    </div>
  );
}
