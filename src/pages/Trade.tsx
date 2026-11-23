import { useEffect, useRef, useState } from "react";
import { call, fileUrl, newToken, uploadImage } from "../api";
import { displayValue } from "../components/Fields";
import { ItemPicker, PickedItem, Receipt } from "../components/Pickers";
import { date, money, moneyInput, parseMoney, parseQty, todayIso } from "../format";
import { ErrorBox, Label, Modal, go, useApp } from "../ui";
import ItemEdit from "./ItemEdit";

type Line = { key: number; item: PickedItem; qty: string; price: string; disc: string };

export default function TradePage(props: { mode: "sale" | "purchase"; preset?: string | null }) {
  const { toast } = useApp();
  const sale = props.mode === "sale";
  const [day, setDay] = useState(todayIso());
  const [party, setParty] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [discount, setDiscount] = useState("");
  const [token, setToken] = useState(newToken());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<any>(null);
  const [newItem, setNewItem] = useState(false);
  const submitting = useRef(false);
  const [photos, setPhotos] = useState<any[]>([]);
  const [uploading, setUploading] = useState(0);
  const photoInput = useRef<HTMLInputElement>(null);
  const addPhotos = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (photoInput.current) photoInput.current.value = "";
    setUploading((n) => n + list.length);
    for (const f of list) {
      try {
        const p = await uploadImage("photo_store", f);
        setPhotos((x) => [...x, p]);
      } catch (e: any) {
        toast(`${f.name}: ${e.message}`, "error");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  useEffect(() => {
    if (!props.preset) return;
    call("item_get", { id: Number(props.preset) }).then((r) =>
      add({ id: r.item.id, name: r.item.name, identifier: r.item.identifier, tracking: r.item.tracking, category_name: r.item.category_name, stock: r.stock.qty, sale_price: r.item.sale_price, photo: r.photos[0]?.file ?? null }),
    );
  }, [props.preset]);

  const add = (it: PickedItem) => {
    setLines((ls) => {
      const same = ls.find((l) => l.item.id === it.id);
      if (same && it.tracking === "quantity") return ls.map((l) => (l === same ? { ...l, qty: String((parseQty(l.qty) || 0) + 1) } : l));
      if (same) return ls;
      return [...ls, { key: Date.now() + Math.random(), item: it, qty: "1", price: sale && it.sale_price !== null ? moneyInput(it.sale_price) : "", disc: "" }];
    });
  };
  const [info, setInfo] = useState<Record<number, any>>({});
  const [costs, setCosts] = useState<Record<string, any>>({});
  useEffect(() => {
    for (const l of lines) {
      if (info[l.item.id] === undefined) {
        setInfo((x) => ({ ...x, [l.item.id]: null }));
        call("item_get", { id: l.item.id }).then((r) => setInfo((x) => ({ ...x, [l.item.id]: r }))).catch(() => {});
      }
    }
  }, [lines]);
  useEffect(() => {
    if (!sale) return;
    for (const l of lines) {
      const q = parseQty(l.qty);
      if (!q || Number.isNaN(q)) continue;
      const k = `${l.item.id}:${q}:${day}`;
      if (costs[k] !== undefined) continue;
      setCosts((x) => ({ ...x, [k]: null }));
      call("sale_cost_preview", { item_id: l.item.id, qty: q, date: day }).then((r) => setCosts((x) => ({ ...x, [k]: r }))).catch(() => {});
    }
  }, [lines, day]);
  const upd = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const calc = lines.map((l) => {
    const q = parseQty(l.qty);
    const p = parseMoney(l.price);
    const d = parseMoney(l.disc) ?? 0;
    const ok = q !== null && !Number.isNaN(q) && q > 0 && p !== null && !Number.isNaN(p) && !Number.isNaN(d);
    return { ok, q: q ?? 0, p: p ?? 0, d, amount: ok ? q! * p! - d : 0 };
  });
  const subtotal = calc.reduce((s, c) => s + c.amount, 0);
  const disc = parseMoney(discount) ?? 0;
  const total = subtotal - (Number.isNaN(disc) ? 0 : disc);

  const check = (): string => {
    if (lines.length === 0) return "Add at least one item";
    for (let i = 0; i < lines.length; i++) {
      const c = calc[i];
      const l = lines[i];
      if (!c.ok) return `Check the quantity and price for "${l.item.name}"`;
      if (c.amount < 0) return `The discount on "${l.item.name}" is bigger than its amount`;
      if (sale && c.q > l.item.stock) return `Only ${l.item.stock} of "${l.item.name}" in stock`;
      if (l.item.tracking === "unique" && c.q !== 1) return `"${l.item.name}" is one of a kind. Quantity must be 1.`;
    }
    if (Number.isNaN(disc) || disc > subtotal) return "Check the discount";
    if (!day) return "Choose the date";
    return "";
  };

  const askConfirm = () => {
    const e = check();
    setError(e);
    if (!e) setConfirm(true);
  };

  const post = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await call(sale ? "sale_post" : "purchase_post", {
        client_token: token,
        business_date: day,
        party,
        notes,
        discount: disc || 0,
        lines: lines.map((l, i) => ({ item_id: l.item.id, qty: calc[i].q, unit_price: calc[i].p, line_discount: calc[i].d })),
        photos,
      });
      setConfirm(false);
      setDone(r);
      toast(sale ? `Sale ${r.number} saved` : `Purchase ${r.number} saved`);
    } catch (e: any) {
      setConfirm(false);
      setError(e.message);
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  };

  const reset = () => {
    setLines([]);
    setParty("");
    setNotes("");
    setDiscount("");
    setPhotos([]);
    setDone(null);
    setToken(newToken());
    if (props.preset) go(sale ? "/sale" : "/purchase");
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{sale ? "Make sale" : "Record purchase"}</h1>
      </div>
      <div className="card stack">
        <div className="row">
          <Label text="Date">
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} data-testid="trade-date" />
          </Label>
          <Label text={sale ? "Customer (optional)" : "Supplier (optional)"}>
            <input value={party} onChange={(e) => setParty(e.target.value)} data-testid="trade-party" />
          </Label>
          <div className="lbl">
            <span className="lbl-text">Photos (optional)</span>
            <div className="row trade-photos">
              {photos.map((p, i) => (
                <div key={p.file + i} className="trade-photo">
                  <img src={fileUrl(p.file)} alt={p.original_name} />
                  <button type="button" className="trade-photo-x" onClick={() => setPhotos((x) => x.filter((_, j) => j !== i))} aria-label="Take off this photo">
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" className="btn" onClick={() => photoInput.current?.click()} disabled={uploading > 0} data-testid="trade-photo-add">
                {uploading > 0 ? "Adding..." : photos.length ? "+ More photos" : "+ Add photos"}
              </button>
              <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => addPhotos(e.target.files)} data-testid="trade-photo-input" />
            </div>
          </div>
        </div>
        <div className="row nowrap">
          <div className="grow">
            <ItemPicker onPick={add} forSale={sale} autoFocus />
          </div>
          {!sale && (
            <button className="btn" onClick={() => setNewItem(true)}>
              + New item
            </button>
          )}
        </div>
        <table className="table lines">
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ width: 110 }}>Quantity</th>
              <th style={{ width: 160 }}>{sale ? "Price each" : "Cost each"}</th>
              <th style={{ width: 140 }}>Discount</th>
              <th className="num" style={{ width: 150 }}>
                Amount
              </th>
              <th style={{ width: 50 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={6} className="muted center">
                  Search above to add items
                </td>
              </tr>
            )}
            {lines.map((l, i) => [
              <tr key={l.key}>
                <td>
                  <strong>{l.item.name}</strong>
                  {l.item.identifier && <span className="muted"> #{l.item.identifier}</span>}
                  <div className="muted small">
                    {l.item.category_name} · {l.item.stock} in stock
                  </div>
                </td>
                <td>
                  <input inputMode="numeric" value={l.qty} disabled={l.item.tracking === "unique"} onChange={(e) => upd(l.key, { qty: e.target.value })} aria-label="Quantity" data-testid={`qty-${i}`} />
                </td>
                <td>
                  <input inputMode="decimal" value={l.price} onChange={(e) => upd(l.key, { price: e.target.value })} aria-label="Price" data-testid={`price-${i}`} />
                </td>
                <td>
                  <input inputMode="decimal" value={l.disc} onChange={(e) => upd(l.key, { disc: e.target.value })} aria-label="Discount" />
                </td>
                <td className="num">{calc[i].ok ? money(calc[i].amount) : "-"}</td>
                <td>
                  <button className="btn btn-ghost" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    ✕
                  </button>
                </td>
              </tr>,
              <tr key={`${l.key}-info`} className="line-info-row no-print">
                <td colSpan={6}>
                  <LineInfo info={info[l.item.id]} cost={sale ? costs[`${l.item.id}:${calc[i].q}:${day}`] : undefined} amount={calc[i].ok ? calc[i].amount : null} qty={calc[i].q} sale={sale} />
                </td>
              </tr>,
            ])}
          </tbody>
        </table>
        <div className="totals-row">
          <Label text="Notes (optional)">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Label>
          <div className="totals">
            <div>
              <span>Subtotal</span>
              <strong>{money(subtotal)}</strong>
            </div>
            <div>
              <span>Discount on total</span>
              <input inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} style={{ width: 140 }} aria-label="Discount on total" />
            </div>
            <div className="grand">
              <span>Total</span>
              <strong data-testid="trade-total">{money(total)}</strong>
            </div>
          </div>
        </div>
        <ErrorBox text={error} />
        <div className="row end">
          <button className="btn btn-primary btn-big" onClick={askConfirm} disabled={busy} data-testid="trade-review">
            {sale ? "Finish sale" : "Save purchase"}
          </button>
        </div>
      </div>

      {confirm && (
        <Modal
          title={sale ? "Confirm sale" : "Confirm purchase"}
          onClose={() => !busy && setConfirm(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(false)} disabled={busy}>
                Go back
              </button>
              <button className="btn btn-primary btn-big" onClick={post} disabled={busy} data-testid="trade-confirm">
                {busy ? "Saving..." : sale ? `Confirm sale of ${money(total)}` : `Save purchase of ${money(total)}`}
              </button>
            </>
          }
        >
          <ul className="confirm-list">
            {lines.map((l, i) => (
              <li key={l.key}>
                {calc[i].q} x {l.item.name} at {money(calc[i].p)}
                {calc[i].d > 0 && ` less ${money(calc[i].d)}`} = <strong>{money(calc[i].amount)}</strong>
              </li>
            ))}
          </ul>
          {disc > 0 && <p>Discount on total: {money(disc)}</p>}
          <p className="big-total">Total: {money(total)}</p>
        </Modal>
      )}

      {done && (
        <Modal
          title={sale ? `Sale ${done.number} saved` : `Purchase ${done.number} saved`}
          onClose={reset}
          wide
          footer={
            <>
              <button className="btn" onClick={() => go(`/txn/${done.id}`)}>
                Open record
              </button>
              <button className="btn" onClick={() => window.print()} data-testid="print-receipt">
                Print
              </button>
              <button className="btn btn-primary" onClick={reset} data-testid="trade-new">
                {sale ? "New sale" : "New purchase"}
              </button>
            </>
          }
        >
          <div className="receipt-wrap">
            <Receipt txn={done} />
          </div>
        </Modal>
      )}

      {newItem && (
        <Modal title="New item" onClose={() => setNewItem(false)} wide>
          <ItemEdit
            onCancel={() => setNewItem(false)}
            onSaved={(r) => {
              setNewItem(false);
              add({ id: r.item.id, name: r.item.name, identifier: r.item.identifier, tracking: r.item.tracking, category_name: r.item.category_name, stock: r.stock.qty, sale_price: r.item.sale_price, photo: r.photos[0]?.file ?? null });
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function LineInfo(props: { info: any; cost: any; amount: number | null; qty: number; sale: boolean }) {
  const r = props.info;
  if (!r) return <div className="line-info muted small">Loading details...</div>;
  const filled = (r.fields as any[]).filter((f) => !f.archived && r.values[String(f.id)] !== undefined && r.values[String(f.id)] !== null && r.values[String(f.id)] !== "");
  const cost = props.cost?.cost;
  const profit = props.sale && cost !== null && cost !== undefined && props.amount !== null ? props.amount - cost : null;
  const lots: any[] = props.cost?.lots ?? [];
  return (
    <div className="line-info" data-testid="line-info">
      {r.photos[0] && <img src={fileUrl(r.photos[0].file)} alt="" />}
      <div className="line-info-body">
        <div className="chips">
          {r.item.identifier && (
            <span className="chip">
              <b>{r.item.tracking === "unique" ? "Chassis / serial" : "Code"}:</b> {r.item.identifier}
            </span>
          )}
          {filled.map((f) => (
            <span key={f.id} className="chip">
              <b>{f.name}:</b> {displayValue(f, r.values[String(f.id)])}
            </span>
          ))}
          {r.item.notes && (
            <span className="chip">
              <b>Notes:</b> {r.item.notes}
            </span>
          )}
        </div>
        {props.sale && (
          <div className="line-money">
            {cost === null || cost === undefined ? (
              <span className="muted">Not enough stock to work out the cost.</span>
            ) : (
              <>
                <span>
                  Bought for <b>{money(Math.round(cost / Math.max(props.qty, 1)))}</b> each
                  {lots.length > 0 && <span className="muted"> ({lots.map((l) => `${l.qty} on ${date(l.date)}`).join(", ")})</span>}
                </span>
                {profit !== null && (
                  <span className={profit > 0 ? "profit" : profit < 0 ? "loss" : ""} data-testid="line-profit">
                    <b>{profit < 0 ? `Loss ${money(-profit)}` : `Profit ${money(profit)}`}</b>
                  </span>
                )}
                <span className="muted small">Only you see this. It is not printed on the slip.</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
