import { TractorDrawing } from "./TractorArt";
import { useEffect, useRef, useState } from "react";
import { call, fileUrl } from "../api";
import { date, kindLabel, money } from "../format";

export type PickedItem = { id: number; name: string; identifier: string; tracking: string; category_name: string; stock: number; sale_price: number | null; photo: string | null };

export function ItemPicker(props: { onPick: (it: PickedItem) => void; forSale?: boolean; placeholder?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PickedItem[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [fresh, setFresh] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      call("item_search", { text: q, status: "active", limit: 25 }).then((r) => live && (setRows(r.rows), setHi(0)));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, fresh]);

  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const pick = (r: PickedItem) => {
    if (props.forSale && r.stock <= 0) return;
    props.onPick(r);
    setQ("");
    setOpen(false);
  };

  return (
    <div className="picker" ref={box}>
      <input
        className="search"
        autoFocus={props.autoFocus}
        placeholder={props.placeholder ?? "Type item name or number to add it..."}
        value={q}
        onFocus={() => {
          setOpen(true);
          setFresh((n) => n + 1);
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setHi((h) => Math.min(h + 1, rows.length - 1));
          if (e.key === "ArrowUp") setHi((h) => Math.max(h - 1, 0));
          if (e.key === "Enter" && rows[hi]) {
            e.preventDefault();
            pick(rows[hi]);
          }
        }}
        data-testid="item-picker"
      />
      {open && (
        <div className="picker-list">
          {rows.length === 0 && <div className="picker-empty">No items found</div>}
          {rows.map((r, i) => {
            const disabled = props.forSale && r.stock <= 0;
            return (
              <button key={r.id} type="button" className={`picker-row ${i === hi ? "hi" : ""} ${disabled ? "disabled" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
                {r.photo ? <img src={fileUrl(r.photo)} alt="" /> : <span className="thumb-empty" />}
                <span className="grow">
                  <strong>{r.name}</strong>
                  {r.identifier && <span className="muted"> #{r.identifier}</span>}
                  <br />
                  <span className="muted">{r.category_name}</span>
                </span>
                <span className={r.stock > 0 ? "stock-ok" : "stock-out"}>{r.stock > 0 ? `${r.stock} in stock` : "Out of stock"}</span>
                {r.sale_price !== null && <span className="muted">{money(r.sale_price)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Receipt(props: { txn: any }) {
  const t = props.txn;
  const s = t.snapshot ?? {};
  const m = (c: number) => money(c, { snapshot: s });
  const title = t.kind === "sale" ? "RECEIPT" : t.kind === "purchase" ? "PURCHASE RECORD" : t.kind === "return" ? "RETURN / REFUND" : t.kind === "reversal" ? "REVERSAL" : "STOCK CHANGE";
  return (
    <div className="receipt print-area" data-testid="receipt">
      {s.receipt_watermark !== false && <TractorDrawing variant={0} className="r-watermark" testid="r-watermark" />}
      <div className="r-head">
        {s.receipt_show_logo !== false && s.shop_logo && <img className="r-logo" src={fileUrl(s.shop_logo)} alt="" />}
        <div className="r-shop">{s.shop_name}</div>
        {s.shop_address && <div>{s.shop_address}</div>}
        {(s.shop_phone || s.shop_email) && <div>{[s.shop_phone, s.shop_email].filter(Boolean).join("  ")}</div>}
        {Array.isArray(s.contacts) &&
          s.contacts.map((c: any, i: number) => (
            <div key={i} className="r-contact" data-testid="r-contact">
              {[c.name, c.title && `(${c.title})`].filter(Boolean).join(" ")}
              {(c.name || c.title) && c.phone ? ": " : ""}
              {c.phone}
            </div>
          ))}
        {s.receipt_header && <div className="r-note">{s.receipt_header}</div>}
      </div>
      <div className="r-title">{title}</div>
      <div className="r-meta">
        <span>No. {t.number}</span>
        <span>{date(t.business_date, s.date_format)}</span>
      </div>
      {t.party && <div className="r-meta">{t.kind === "purchase" ? "Supplier" : "Customer"}: {t.party}</div>}
      {t.info
        ?.filter((d: any) => d.print)
        .map((d: any) => (
          <div key={d.id ?? d.name} className="r-meta" data-testid="r-info">
            {d.name}: {d.value}
          </div>
        ))}
      {t.related && (
        <div className="r-meta">
          {kindLabel(t.kind, t.related_kind)} of {t.related.number}
        </div>
      )}
      {t.reason && <div className="r-meta">Reason: {t.reason}</div>}
      <table className="r-lines">
        <tbody>
          {t.lines.map((l: any) => (
            <tr key={l.id}>
              <td>
                <div>{l.description}</div>
                {l.details?.map((d: any) => (
                  <div key={d.name} className="r-detail">
                    {d.name}: {d.value}
                  </div>
                ))}
                <div className="r-detail">
                  {l.qty} x {m(l.unit_price)}
                  {l.line_discount > 0 && <> less {m(l.line_discount)}</>}
                </div>
              </td>
              <td className="num">{m(t.kind === "return" ? l.net : l.qty * l.unit_price - l.line_discount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="r-totals">
        {t.discount > 0 && (
          <>
            <div>
              <span>Subtotal</span>
              <span>{m(t.subtotal)}</span>
            </div>
            <div>
              <span>Discount</span>
              <span>-{m(t.discount)}</span>
            </div>
          </>
        )}
        <div className="r-total">
          <span>{t.kind === "return" ? "Refund" : "Total"}</span>
          <span>{m(t.total)}</span>
        </div>
      </div>
      {t.notes && t.kind !== "return" && t.kind !== "reversal" && <div className="r-note">{t.notes}</div>}
      {s.receipt_footer && <div className="r-foot">{s.receipt_footer}</div>}
    </div>
  );
}

