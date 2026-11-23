import { useState } from "react";
import { call, isTauri, pickFolder } from "../api";
import { dateTime } from "../format";
import { ErrorBox, Label } from "../ui";

export default function RestoreWizard(props: { onDone: () => void; warnReplace?: boolean }) {
  const [path, setPath] = useState("");
  const [snaps, setSnaps] = useState<any[] | null>(null);
  const [chosen, setChosen] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<any>(null);

  const find = async (p = path) => {
    setError("");
    setSnaps(null);
    setChosen(null);
    setBusy("Looking for backups...");
    try {
      const s = await call<any[]>("restore_find", { path: p });
      setSnaps(s);
      setChosen(s[0]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const browse = async () => {
    const p = await pickFolder("Choose your backup drive or the ShopPOS Backups folder");
    if (p) {
      setPath(p);
      find(p);
    }
  };

  const restore = async () => {
    if (!chosen) return;
    setError("");
    try {
      setBusy("Checking every file in the backup...");
      await call("restore_verify", { path: chosen.path });
      setBusy("Restoring your shop. Please do not turn off the computer...");
      const r = await call("restore_apply", { path: chosen.path });
      setDone(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  if (done) {
    return (
      <div className="stack">
        <div className="alert alert-ok">
          Your shop was restored from the backup made on {dateTime(done.restore.created_at)}. {done.restore.counts.items} items and {done.restore.counts.txns} transactions are back.
          {done.restore.previous_data_moved_to && <> Anything that was on this computer before was kept in {done.restore.previous_data_moved_to}.</>}
        </div>
        <button className="btn btn-primary btn-big" onClick={props.onDone}>
          Open my shop
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      <ol className="steps">
        <li>Plug in your backup drive.</li>
        <li>{isTauri ? "Press Choose backup drive and pick the drive (or the ShopPOS Backups folder on it)." : "Type the folder of your backup drive."}</li>
        <li>Pick the newest backup and press Restore.</li>
      </ol>
      <div className="row">
        {isTauri && (
          <button className="btn btn-primary" onClick={browse} disabled={!!busy}>
            Choose backup drive
          </button>
        )}
        <Label text="Backup folder">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder={isTauri ? "E:\\" : "/media/usb"} data-testid="restore-path" />
        </Label>
        <button className="btn" onClick={() => find()} disabled={!path || !!busy}>
          Find backups
        </button>
      </div>
      {busy && <div className="alert alert-info">{busy}</div>}
      <ErrorBox text={error} />
      {snaps && (
        <>
          <table className="table">
            <thead>
              <tr>
                <th></th>
                <th>Made on</th>
                <th>Shop</th>
                <th>Items</th>
                <th>Transactions</th>
                <th>Photos and logos</th>
              </tr>
            </thead>
            <tbody>
              {snaps.map((s) => (
                <tr key={s.path} className={chosen?.path === s.path ? "row-on" : ""} onClick={() => setChosen(s)}>
                  <td>
                    <input type="radio" checked={chosen?.path === s.path} onChange={() => setChosen(s)} />
                  </td>
                  <td>{dateTime(s.created_at)}</td>
                  <td>{s.shop_name}</td>
                  <td>{s.counts.items}</td>
                  <td>{s.counts.txns}</td>
                  <td>{s.files}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {props.warnReplace && <div className="alert alert-warn">The shop data now on this computer will be moved to a safe folder (not deleted) and replaced by the backup.</div>}
          <button className="btn btn-primary btn-big" onClick={restore} disabled={!chosen || !!busy} data-testid="restore-go">
            Restore this backup
          </button>
        </>
      )}
    </div>
  );
}
