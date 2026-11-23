import { TractorDrawing } from "../components/TractorArt";
import { useEffect, useState } from "react";
import { call, isTauri, licenseActivate } from "../api";
import RestoreWizard from "../components/RestoreWizard";
import { ErrorBox, Label } from "../ui";

export function Welcome(props: { onDone: () => void }) {
  const [mode, setMode] = useState<"choose" | "new" | "restore">("choose");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("Rs");
  const [decimals, setDecimals] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) return setError("Please type your shop name");
    setBusy(true);
    try {
      await call("shop_create", { shop_name: name.trim(), currency_symbol: symbol, money_decimals: decimals });
      props.onDone();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="boot">
      <TractorDrawing variant={1} className="app-watermark" />
      <div className="boot-card wide">
        <h1>Welcome to ShopPOS</h1>
        {mode === "choose" && (
          <div className="stack">
            <p>Is this a new shop, or are you moving your shop to this computer?</p>
            <div className="choice-grid">
              <button className="choice" onClick={() => setMode("new")} data-testid="start-new">
                <strong>Start a new shop</strong>
                <span>First time using ShopPOS</span>
              </button>
              <button className="choice" onClick={() => setMode("restore")} data-testid="start-restore">
                <strong>Restore from backup</strong>
                <span>New or repaired computer. Bring back all your records from your backup drive.</span>
              </button>
            </div>
          </div>
        )}
        {mode === "new" && (
          <div className="stack">
            <Label text="Shop name" required>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="shop-name" />
            </Label>
            <div className="row">
              <Label text="Money sign" hint="Shown before prices, like Rs or $">
                <input value={symbol} onChange={(e) => setSymbol(e.target.value)} style={{ width: 120 }} />
              </Label>
              <Label text="Show paisa / cents">
                <select value={decimals} onChange={(e) => setDecimals(Number(e.target.value))}>
                  <option value={0}>No (12,000)</option>
                  <option value={2}>Yes (12,000.00)</option>
                </select>
              </Label>
            </div>
            <p className="muted">You can change the logo, address, receipt text and colours later in Settings.</p>
            <ErrorBox text={error} />
            <div className="row">
              <button className="btn" onClick={() => setMode("choose")}>
                Back
              </button>
              <button className="btn btn-primary btn-big" onClick={create} disabled={busy} data-testid="create-shop">
                Create my shop
              </button>
            </div>
          </div>
        )}
        {mode === "restore" && (
          <div className="stack">
            <RestoreWizard onDone={props.onDone} />
            <button className="btn" onClick={() => setMode("choose")}>
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Problem(props: { state: any; onRetry: () => void }) {
  const st = props.state;
  const [restore, setRestore] = useState(false);
  const [safety, setSafety] = useState<any[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (st.state === "migration_failed") call<any[]>("recovery_list").then(setSafety).catch(() => {});
  }, [st.state]);

  const restart = async () => {
    if (isTauri) {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } else {
      props.onRetry();
    }
  };

  const useSafety = async (path: string) => {
    try {
      await call("recovery_restore", { path });
      props.onRetry();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const title =
    st.state === "missing_data"
      ? "Your shop data was not found"
      : st.state === "incompatible"
        ? "Please update the app"
        : st.state === "migration_failed"
          ? "The update could not prepare your data"
          : "The shop could not be opened";

  return (
    <div className="boot">
      <TractorDrawing variant={1} className="app-watermark" />
      <div className="boot-card wide">
        <h1>{title}</h1>
        <div className="alert alert-warn">{st.message}</div>
        <p className="muted">Data folder: {st.data_dir}</p>
        <ErrorBox text={error} />
        <div className="row">
          <button className="btn btn-primary" onClick={restart}>
            {st.state === "incompatible" ? "Close and check for updates again" : "Try again"}
          </button>
          {st.state !== "incompatible" && (
            <button className="btn" onClick={() => setRestore(true)}>
              Restore from backup drive
            </button>
          )}
        </div>
        {st.state === "migration_failed" && (
          <div className="stack">
            <p>
              Your records were not changed. You can keep working with the previous version of the app: ask the person who set up ShopPOS for the previous installer, or wait for a fixed update and press Try
              again.
            </p>
            {safety.length > 0 && (
              <details>
                <summary>Advanced: use a safety copy made just before the update</summary>
                {safety.map((s) => (
                  <div key={s.path} className="row">
                    <span>{s.name}</span>
                    <button className="btn btn-small" onClick={() => useSafety(s.path)}>
                      Use this copy
                    </button>
                  </div>
                ))}
              </details>
            )}
          </div>
        )}
        {restore && <RestoreWizard onDone={props.onRetry} warnReplace />}
      </div>
    </div>
  );
}

export function Activate(props: { code: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setError("");
    setBusy(true);
    try {
      await licenseActivate(text.trim());
      props.onDone();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="boot">
      <TractorDrawing variant={1} className="app-watermark" />
      <div className="boot-card wide" data-testid="activate">
        <h1>This copy of ShopPOS is not activated</h1>
        <p>ShopPOS only works on activated computers. To use it on this computer, send this computer code to the person who set up ShopPOS for you:</p>
        <div className="computer-code" data-testid="computer-code">
          {props.code}
        </div>
        <Label text="Activation code">
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} data-testid="activation-input" />
        </Label>
        <ErrorBox text={error} />
        <div>
          <button className="btn btn-primary" onClick={go} disabled={busy || !text.trim()} data-testid="activation-save">
            Activate
          </button>
        </div>
      </div>
    </div>
  );
}
