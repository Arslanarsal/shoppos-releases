import { useEffect, useState } from "react";
import { call, exportCsv } from "../api";
import { date, kindLabel, money } from "../format";
import { Category, Empty, ErrorBox, Label, go, useApp, useAsync } from "../ui";

const KINDS = [
  { key: "purchase", label: "Purchases" },
  { key: "sale", label: "Sales" },
  { key: "return", label: "Returns" },
  { key: "adjustment", label: "Stock changes" },
  { key: "reversal", label: "Reversals" },
];

export function LinesTable(props: { data: any; showItem?: boolean }) {
  const rows: any[] = props.data?.rows ?? [];
  if (rows.length === 0) return <Empty>Nothing found</Empty>;
  return (
    <div className="table-wrap">
      <table className="table" data-testid="lines-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Number</th>
            <th>Type</th>
            {props.showItem !== false && <th>Item</th>}
            <th>Customer / supplier</th>
            <th className="num">Qty</th>
            <th className="num">Price each</th>
            <th className="num">Amount</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.line_id} className={`click ${r.reversed_by ? "row-muted" : ""}`} onClick={() => go(`/txn/${r.txn_id}`)}>
              <td className="nowrap">{date(r.business_date)}</td>
              <td className="nowrap">{r.number}</td>
              <td>
                {kindLabel(r.kind, r.related_kind)}
                {r.reversed_by && <div className="tag tag-warn">Reversed by {r.reversed_by}</div>}
                {r.reason && <div className="muted small">{r.reason}</div>}
              </td>
              {props.showItem !== false && (
                <td>
                  {r.description}
                  <div className="muted small">{r.category_name}</div>
                </td>
              )}
              <td>{r.party}</td>
              <td className="num">
                {r.direction === 1 ? "+" : "-"}
                {r.qty}
              </td>
              <td className="num">{money(r.unit_price)}</td>
              <td className="num">{money(r.net)}</td>
              <td className="num muted">{r.cost ? money(r.cost) : ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={props.showItem !== false ? 5 : 4}>
              {props.data.total} line{props.data.total === 1 ? "" : "s"}
              {props.data.total > rows.length && ` (showing first ${rows.length})`}
            </td>
            <td className="num">{props.data.sum_qty}</td>
            <td></td>
            <td className="num">{money(props.data.sum_net)}</td>
            <td className="num muted">{money(props.data.sum_cost)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function HistoryPage(props: { query: URLSearchParams }) {
  const { toast } = useApp();
  const q = props.query;
  const [kinds, setKinds] = useState<string[]>(q.get("kinds")?.split(",").filter(Boolean) ?? []);
  const [from, setFrom] = useState(q.get("from") ?? "");
  const [to, setTo] = useState(q.get("to") ?? "");
  const [text, setText] = useState(q.get("text") ?? "");
  const [cat, setCat] = useState(q.get("category") ?? "");
  const [hideRev, setHideRev] = useState(false);
  const [limit, setLimit] = useState(200);
  const cats = useAsync(() => call<Category[]>("category_list", { include_archived: true }), []);
  const title = q.get("title");

  const params = {
    kinds: kinds.flatMap((k) => (k === "reversal" ? ["reversal"] : [k])),
    from: from || null,
    to: to || null,
    text,
    category_id: cat ? Number(cat) : null,
    item_id: q.get("item") ? Number(q.get("item")) : null,
    hide_reversed: hideRev,
    limit,
  };
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      call("line_search", params)
        .then((d) => (setData(d), setError("")))
        .catch((e) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [JSON.stringify(params)]);

  const toggle = (k: string) => setKinds((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]));
  const exp = async () => {
    const p = await exportCsv(`history-${from || "all"}-${to || "all"}.csv`, "lines", { ...params, limit: 1000000 });
    if (p) toast(`Saved ${p}`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{title ?? "History"}</h1>
        <button className="btn" onClick={exp}>
          Export to spreadsheet (CSV)
        </button>
      </div>
      <div className="card filters">
        <div className="row">
          {KINDS.map((k) => (
            <label key={k.key} className={`chip ${kinds.includes(k.key) || kinds.some((x) => x.startsWith(k.key + ":")) ? "chip-on" : ""}`}>
              <input type="checkbox" checked={kinds.includes(k.key)} onChange={() => toggle(k.key)} /> {k.label}
            </label>
          ))}
          {kinds.some((k) => k.includes(":")) && (
            <span className="muted small">
              Also: {kinds.filter((k) => k.includes(":")).map((k) => kindLabel("reversal", k.split(":")[1])).join(", ")}
            </span>
          )}
        </div>
        <div className="row">
          <Label text="From date">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="hist-from" />
          </Label>
          <Label text="To date">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="hist-to" />
          </Label>
          <Label text="Category">
            <select value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">All</option>
              {cats.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Label>
          <Label text="Search">
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Item, number, customer, supplier" />
          </Label>
          <label className="check">
            <input type="checkbox" checked={hideRev} onChange={(e) => setHideRev(e.target.checked)} /> Hide reversed
          </label>
        </div>
      </div>
      <ErrorBox text={error} />
      {data && <LinesTable data={data} />}
      {data && data.total > data.rows.length && (
        <button className="btn" onClick={() => setLimit((l) => l + 500)}>
          Show more
        </button>
      )}
    </div>
  );
}
