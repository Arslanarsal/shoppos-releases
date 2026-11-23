import { useState } from "react";
import { call, newToken } from "../api";
import { Receipt } from "../components/Pickers";
import { date, kindLabel, money, todayIso } from "../format";
import { ErrorBox, Label, Modal, go, useApp, useAsync } from "../ui";

export default function TxnPage(props: { id: number }) {
  const { data: t, error, reload } = useAsync(() => call("txn_get", { id: props.id }), [props.id]);
  const [rev, setRev] = useState(false);
  const [ret, setRet] = useState(false);
  if (error) return <div className="page"><ErrorBox text={error} /></div>;
  if (!t) return <div className="page">Loading...</div>;
  const returnable = t.kind === "sale" && !t.reversed_by && t.lines.some((l: any) => l.qty - (l.returned_qty ?? 0) > 0);
  const hasOpenReturns = t.returns?.length > 0;
  return (
    <div className="page">
      <div className="page-head no-print">
        <div>
          <h1>
            {kindLabel(t.kind, t.related_kind)} {t.number}
          </h1>
          <div className="muted">
            {date(t.business_date)} · recorded {t.created_at.slice(0, 16).replace("T", " ")} UTC
          </div>
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={() => window.print()} data-testid="print">
            Print
          </button>
          {returnable && (
            <button className="btn" onClick={() => setRet(true)} data-testid="return-open">
              Return items
            </button>
          )}
          {t.kind !== "reversal" && !t.reversed_by && (
            <button className="btn btn-danger" onClick={() => setRev(true)} data-testid="reverse-open">
              Reverse
            </button>
          )}
        </div>
      </div>
      <div className="no-print stack">
        {t.reversed_by && (
          <div className="alert alert-warn" data-testid="reversed-note">
            Reversed by{" "}
            <a href={`#/txn/${t.reversed_by.id}`}>{t.reversed_by.number}</a> on {date(t.reversed_by.business_date)}. Reason: {t.reversed_by.reason}
          </div>
        )}
        {t.related && (
          <div className="alert alert-info">
            {t.kind === "return" ? "Return for" : "Reverses"} <a href={`#/txn/${t.related.id}`}>{t.related.number}</a> ({kindLabel(t.related.kind)} of {date(t.related.business_date)})
          </div>
        )}
        {hasOpenReturns && (
          <div className="alert alert-info">
            Returns: {t.returns.map((r: any) => (
              <a key={r.id} href={`#/txn/${r.id}`} style={{ marginRight: 12 }}>
                {r.number} ({money(r.total)})
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="receipt-wrap">
        <Receipt txn={t} />
      </div>
      {rev && <ReverseDialog txn={t} onClose={() => setRev(false)} onDone={(id) => go(`/txn/${id}`)} />}
      {ret && <ReturnDialog txn={t} onClose={() => setRet(false)} onDone={(id) => (reload(), go(`/txn/${id}`))} />}
    </div>
  );
}

function ReverseDialog(props: { txn: any; onClose: () => void; onDone: (id: number) => void }) {
  const { toast } = useApp();
  const [reason, setReason] = useState("");
  const [day, setDay] = useState(todayIso());
  const [token] = useState(newToken());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const go_ = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await call("reverse_post", { client_token: token, txn_id: props.txn.id, business_date: day, reason });
      toast(`${props.txn.number} reversed`);
      props.onDone(r.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Reverse ${props.txn.number}`}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={go_} disabled={busy || !reason.trim()} data-testid="reverse-confirm">
            Reverse it
          </button>
        </>
      }
    >
      <div className="stack">
        <p>
          A reversal cancels this {kindLabel(props.txn.kind).toLowerCase()} with a new record. Nothing is deleted: both stay in the history and the stock goes back to how it was.
        </p>
        <Label text="Why?" required>
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Like: customer cancelled, wrong price typed" data-testid="reverse-reason" />
        </Label>
        <Label text="Date of the reversal">
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Label>
        <ErrorBox text={error} />
      </div>
    </Modal>
  );
}

function ReturnDialog(props: { txn: any; onClose: () => void; onDone: (id: number) => void }) {
  const { toast } = useApp();
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [day, setDay] = useState(todayIso());
  const [token] = useState(newToken());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setError("");
    const lines = Object.entries(qty)
      .map(([id, q]) => ({ line_id: Number(id), qty: Number(q) }))
      .filter((l) => l.qty > 0);
    setBusy(true);
    try {
      const r = await call("return_post", { client_token: token, sale_id: props.txn.id, business_date: day, reason, lines });
      toast(`Return ${r.number} saved. Refund ${money(r.total)}`);
      props.onDone(r.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Return items from ${props.txn.number}`}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            Save return
          </button>
        </>
      }
    >
      <div className="stack">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Sold</th>
              <th className="num">Already returned</th>
              <th>Return now</th>
            </tr>
          </thead>
          <tbody>
            {props.txn.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className="num">{l.qty}</td>
                <td className="num">{l.returned_qty ?? 0}</td>
                <td>
                  <input inputMode="numeric" style={{ width: 90 }} value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value.replace(/\D/g, "") })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row">
          <Label text="Reason" required>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Like: damaged, wrong size" />
          </Label>
          <Label text="Date">
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Label>
        </div>
        <p className="muted">The refund is worked out from the price the customer paid, including any discount.</p>
        <ErrorBox text={error} />
      </div>
    </Modal>
  );
}
