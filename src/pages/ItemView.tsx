import { useState } from "react";
import { call, fileUrl, newToken } from "../api";
import { displayValue } from "../components/Fields";
import { date, dateTime, kindLabel, money, parseMoney, STATUS, todayIso } from "../format";
import { Empty, ErrorBox, FieldDef, Label, Modal, Tabs, go, useApp, useAsync } from "../ui";
import { LinesTable } from "./History";

export default function ItemView(props: { id: number }) {
  const { toast } = useApp();
  const { data, error, reload } = useAsync(() => call("item_get", { id: props.id }), [props.id]);
  const hist = useAsync(() => call("item_history", { id: props.id }), [props.id, data]);
  const [tab, setTab] = useState("purchases");
  const [big, setBig] = useState<string | null>(null);
  const [asOf, setAsOf] = useState(todayIso());
  const [asOfQty, setAsOfQty] = useState<any>(null);
  const [adjust, setAdjust] = useState<null | "count" | "damaged">(null);

  if (error) return <div className="page"><ErrorBox text={error} /></div>;
  if (!data) return <div className="page">Loading...</div>;
  const it = data.item;
  const fields: FieldDef[] = data.fields;
  const groups = new Map<string, FieldDef[]>();
  for (const f of fields) {
    const v = data.values[String(f.id)];
    if (v === undefined || v === null || v === "") continue;
    const g = f.item_id ? "Only this item" : f.category_id !== it.category_id ? "From earlier category" : f.group_name || "Details";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  }

  const checkDate = async () => setAsOfQty(await call("item_stock_on", { id: props.id, date: asOf }));
  const archive = async () => {
    await call("item_archive", { id: props.id, archived: !it.archived });
    toast(it.archived ? "Item is active again" : "Item made inactive. Its history is kept and still searchable.");
    reload();
  };
  const setCondition = async (condition: string) => {
    await call("item_set_condition", { id: props.id, condition });
    toast(condition === "damaged" ? "Marked as damaged" : "Marked as good");
    reload();
  };
  const m = data.money;
  const st = STATUS[m.status];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="muted">{it.category_name}</div>
          <h1>
            {it.name}{" "}
            <span className={`status ${st?.cls}`} data-testid="item-status">
              {st?.label}
            </span>
          </h1>
          {it.identifier && <div className="ident">#{it.identifier}</div>}
        </div>
        <div className="row">
          {!it.archived && data.stock.qty > 0 && (
            <button className="btn btn-primary" onClick={() => go("/sale", { item: it.id })}>
              Sell
            </button>
          )}
          {!it.archived && (it.tracking === "quantity" || data.stock.qty === 0) && (
            <button className="btn" onClick={() => go("/purchase", { item: it.id })}>
              Buy {it.tracking === "quantity" ? "more" : "again"}
            </button>
          )}
          <button className="btn" onClick={() => go(`/item/${it.id}/edit`)} data-testid="item-edit">
            Edit
          </button>
          {!it.archived && (
            <button className="btn" onClick={() => setAdjust("count")}>
              Correct stock
            </button>
          )}
          {!it.archived && data.stock.qty > 0 && (
            <button className="btn" onClick={() => setAdjust("damaged")} data-testid="write-off">
              Write off damaged
            </button>
          )}
          <button className="btn" onClick={() => setCondition(it.condition === "damaged" ? "good" : "damaged")} data-testid="toggle-damaged">
            {it.condition === "damaged" ? "Mark as good" : "Mark damaged"}
          </button>
          <button className="btn btn-ghost" onClick={archive}>
            {it.archived ? "Make active" : "Make inactive"}
          </button>
        </div>
      </div>

      <div className="item-top">
        <div className="gallery">
          {data.photos.length === 0 && <div className="photo-none">No photo</div>}
          {data.photos.map((p: any) => (
            <img key={p.id} src={fileUrl(p.file)} alt={p.original_name} onClick={() => setBig(p.file)} data-testid="item-photo" />
          ))}
        </div>
        <div className="card stack">
          <div className="stat-row">
            <div className="stat">
              <span>In stock now</span>
              <strong data-testid="stock-now">{data.stock.qty}</strong>
            </div>
            <div className="stat">
              <span>Stock cost value</span>
              <strong>{money(data.stock.value)}</strong>
            </div>
            {it.sale_price !== null && (
              <div className="stat">
                <span>Usual price</span>
                <strong>{money(it.sale_price)}</strong>
              </div>
            )}
          </div>
          <div className="money-grid" data-testid="item-money">
            <div>
              <span>Bought</span>
              <strong>{m.bought_qty > 0 ? `${m.bought_qty} for ${money(m.bought_cost)}` : "-"}</strong>
              {m.first_bought && <small className="muted">{m.first_bought === m.last_bought ? date(m.first_bought) : `${date(m.first_bought)} to ${date(m.last_bought)}`}</small>}
            </div>
            <div>
              <span>Sold</span>
              <strong>{m.sold_qty > 0 ? `${m.sold_qty} for ${money(m.revenue)}` : "-"}</strong>
              {m.last_sold && (
                <small className="muted">
                  last {date(m.last_sold)} at {money(m.last_sale_price)}
                </small>
              )}
            </div>
            {m.written_off > 0 && (
              <div>
                <span>Written off</span>
                <strong className="loss">
                  {m.written_off_qty} pcs, {money(m.written_off)}
                </strong>
              </div>
            )}
            <div>
              <span>{m.profit < 0 ? "Loss" : "Profit"}</span>
              <strong className={m.profit > 0 ? "profit" : m.profit < 0 ? "loss" : ""} data-testid="item-profit">
                {money(Math.abs(m.profit))}
              </strong>
            </div>
          </div>
          <div className="row">
            <Label text="Stock on a date">
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} data-testid="stock-date" />
            </Label>
            <button className="btn" onClick={checkDate} data-testid="stock-date-check">
              Check
            </button>
            {asOfQty && (
              <span data-testid="stock-date-result">
                On {date(asOf)}: <strong>{asOfQty.qty}</strong> in stock
              </span>
            )}
          </div>
          {[...groups.entries()].map(([g, fs]) => (
            <div key={g}>
              <h3>{g}</h3>
              <dl className="dl">
                {fs.map((f) => (
                  <div key={f.id}>
                    <dt>
                      {f.name}
                      {f.archived && <span className="muted"> (archived field)</span>}
                    </dt>
                    <dd data-field-value={f.name}>{displayValue(f, data.values[String(f.id)])}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          {it.notes && <p className="notes">{it.notes}</p>}
        </div>
      </div>

      <Tabs
        tabs={[
          { key: "purchases", label: "Purchases" },
          { key: "sales", label: "Sales and returns" },
          { key: "moves", label: "Stock movements" },
          { key: "edits", label: "Edit history" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {hist.data && tab === "purchases" && <LinesTable data={hist.data.purchases} />}
      {hist.data && tab === "sales" && <LinesTable data={hist.data.sales} />}
      {hist.data && tab === "moves" && <MovesTable rows={hist.data.moves} />}
      {hist.data && tab === "edits" && <EditsTable rows={hist.data.edits} fields={fields} />}
      {big && (
        <Modal title={it.name} onClose={() => setBig(null)} wide>
          <img className="photo-big" src={fileUrl(big)} alt="" />
        </Modal>
      )}
      {adjust && <AdjustStock item={it} stock={data.stock.qty} damaged={adjust === "damaged"} onClose={() => setAdjust(null)} onDone={reload} />}
    </div>
  );
}

function MovesTable(props: { rows: any[] }) {
  if (props.rows.length === 0) return <Empty>No stock movements yet</Empty>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Number</th>
          <th>What</th>
          <th className="num">In / out</th>
          <th className="num">Stock after</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((m) => (
          <tr key={m.txn_id} className="click" onClick={() => go(`/txn/${m.txn_id}`)}>
            <td>{date(m.business_date)}</td>
            <td>{m.number}</td>
            <td>{kindLabel(m.kind, m.related_kind)}</td>
            <td className="num">{m.qty > 0 ? `+${m.qty}` : m.qty}</td>
            <td className="num">{m.balance}</td>
            <td>{m.reason || m.party}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EditsTable(props: { rows: any[]; fields: FieldDef[] }) {
  if (props.rows.length === 0) return <Empty>No edits</Empty>;
  const describe = (r: any): string => {
    if (r.action === "create") return "Item created";
    if (r.action === "archive") return "Archived";
    if (r.action === "unarchive") return "Brought back from archive";
    const parts: string[] = [];
    for (const [k, v] of Object.entries<any>(r.detail?.item ?? {})) parts.push(`${k.replace("_", " ")}: ${fmt(v.from)} → ${fmt(v.to)}`);
    for (const [k, v] of Object.entries<any>(r.detail?.values ?? {})) parts.push(v.from !== undefined ? `${k}: ${fmt(v.from)} → ${fmt(v.to)}` : k);
    return parts.join("; ");
  };
  return (
    <table className="table">
      <thead>
        <tr>
          <th>When</th>
          <th>Change</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r, i) => (
          <tr key={i}>
            <td className="nowrap">{dateTime(r.at)}</td>
            <td>{describe(r)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

function AdjustStock(props: { item: any; stock: number; damaged?: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [counted, setCounted] = useState(String(props.damaged ? Math.max(props.stock - 1, 0) : props.stock));
  const [cost, setCost] = useState("");
  const [reason, setReason] = useState(props.damaged ? "Damaged" : "");
  const [day, setDay] = useState(todayIso());
  const [error, setError] = useState("");
  const [token] = useState(newToken());
  const [busy, setBusy] = useState(false);
  const delta = Number(counted) - props.stock;
  const save = async () => {
    setError("");
    if (!/^\d+$/.test(counted.trim())) return setError("Type the number of pieces you counted");
    const c = parseMoney(cost);
    if (Number.isNaN(c)) return setError("The cost is not a valid amount");
    setBusy(true);
    try {
      await call("adjust_post", { client_token: token, business_date: day, item_id: props.item.id, delta, unit_cost: c, reason });
      toast("Stock corrected");
      props.onDone();
      props.onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={props.damaged ? `Write off damaged ${props.item.name}` : `Correct stock of ${props.item.name}`}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || delta === 0}>
            Save correction
          </button>
        </>
      }
    >
      <div className="stack">
        <p>
          {props.damaged
            ? "Pieces you can no longer sell are taken out of stock and counted as a loss in the month-end report. The record stays forever."
            : "Use this only when the real count is different (lost, damaged, found). For sales and purchases use the normal screens."}{" "}
          The app thinks you have <strong>{props.stock}</strong>.
        </p>
        <div className="row">
          <Label text={props.damaged ? "Good pieces left after the write off" : "Pieces you really have"}>
            <input value={counted} onChange={(e) => setCounted(e.target.value)} inputMode="numeric" style={{ width: 120 }} />
          </Label>
          <Label text="Date">
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Label>
        </div>
        {delta > 0 && (
          <Label text="Cost of each extra piece (optional)" hint="Leave empty to use the last purchase price">
            <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" />
          </Label>
        )}
        <Label text="Reason" required>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Like: one chair broken in storage" />
        </Label>
        {delta !== 0 && <div className="alert alert-info">This will {delta > 0 ? `add ${delta}` : `remove ${-delta}`} and keep a record with your reason.</div>}
        <ErrorBox text={error} />
      </div>
    </Modal>
  );
}
