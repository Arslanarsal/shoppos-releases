import { useEffect, useState } from "react";
import { call, exportCsv, fileUrl } from "../api";
import { FieldInput } from "../components/Fields";
import { date, money, STATUS } from "../format";
import { Category, Empty, ErrorBox, FieldDef, Label, go, useApp, useAsync } from "../ui";

type Filter = { key: number; field_id: number | null; op: string; value: any; value2: any };

const OPS: Record<string, { value: string; label: string }[]> = {
  text: [
    { value: "contains", label: "contains" },
    { value: "eq", label: "is exactly" },
  ],
  number: [
    { value: "eq", label: "is" },
    { value: "gte", label: "at least" },
    { value: "lte", label: "at most" },
    { value: "between", label: "between" },
  ],
  date: [
    { value: "eq", label: "on" },
    { value: "gte", label: "on or after" },
    { value: "lte", label: "on or before" },
    { value: "between", label: "between" },
  ],
  exact: [{ value: "eq", label: "is" }],
};

function opsFor(kind: string) {
  if (kind === "text" || kind === "longtext") return OPS.text;
  if (kind === "int" || kind === "decimal" || kind === "money") return OPS.number;
  if (kind === "date") return OPS.date;
  return OPS.exact;
}

export default function ItemsPage(props: { query: URLSearchParams }) {
  const { toast } = useApp();
  const [text, setText] = useState(props.query.get("text") ?? "");
  const [cat, setCat] = useState(props.query.get("category") ?? "");
  const [status, setStatus] = useState(props.query.get("status") ?? "all");
  const [pFrom, setPFrom] = useState("");
  const [pTo, setPTo] = useState("");
  const [sFrom, setSFrom] = useState("");
  const [sTo, setSTo] = useState("");
  const [asOf, setAsOf] = useState(props.query.get("as_of") ?? "");
  const [filters, setFilters] = useState<Filter[]>([]);
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(100);
  const cats = useAsync(() => call<Category[]>("category_list", { include_archived: true }), []);
  const fields = useAsync(() => (cat ? call<FieldDef[]>("field_list", { category_id: Number(cat), include_archived: true }) : call<FieldDef[]>("field_all")), [cat]);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  const params = {
    text,
    category_id: cat ? Number(cat) : null,
    status,
    purchased_from: pFrom || null,
    purchased_to: pTo || null,
    sold_from: sFrom || null,
    sold_to: sTo || null,
    as_of: asOf || null,
    filters: filters
      .filter((f) => f.field_id && f.value !== null && f.value !== undefined && f.value !== "")
      .map((f) => ({ field_id: f.field_id, op: f.op, value: f.value, value2: f.value2 })),
    limit,
  };

  useEffect(() => {
    const t = setTimeout(() => {
      call("item_search", params)
        .then((d) => (setData(d), setError("")))
        .catch((e) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [JSON.stringify(params)]);

  const fieldById = (id: number | null) => fields.data?.find((f) => f.id === id);
  const catName = (id: number | null) => cats.data?.find((c) => c.id === id)?.name ?? "";
  const exp = async () => {
    const p = await exportCsv(`items-${new Date().toISOString().slice(0, 10)}.csv`, "items", { ...params, limit: 100000 });
    if (p) toast(`Saved ${p}`);
  };
  const activeCount = params.filters.length + [pFrom, pTo, sFrom, sTo, asOf].filter(Boolean).length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Items & stock</h1>
        <div className="row">
          <button className="btn" onClick={exp}>
            Export to spreadsheet (CSV)
          </button>
          <button className="btn btn-primary" onClick={() => go("/item/new", { category: cat })}>
            + Add item
          </button>
        </div>
      </div>
      <div className="card filters stack">
        <div className="row">
          <input className="search grow" placeholder="Search by name, number, or any detail..." value={text} onChange={(e) => setText(e.target.value)} data-testid="items-search" />
          <Label text="Category">
            <select value={cat} onChange={(e) => (setCat(e.target.value), setFilters([]))} data-testid="items-category">
              <option value="">All categories</option>
              {cats.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.archived ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </Label>
          <Label text="Show">
            <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="items-status">
              <option value="all">Everything</option>
              <option value="active">All active items</option>
              <option value="in_stock">In stock</option>
              <option value="sold">Sold</option>
              <option value="damaged">Damaged</option>
              <option value="low">Low stock</option>
              <option value="out_of_stock">Out of stock</option>
              <option value="inactive">Inactive</option>
            </select>
          </Label>
          <button className="btn" onClick={() => setMore(!more)} data-testid="more-filters">
            {more ? "Fewer filters" : `More filters${activeCount ? ` (${activeCount})` : ""}`}
          </button>
        </div>
        {more && (
          <div className="stack">
            <div className="row">
              <Label text="Bought from">
                <input type="date" value={pFrom} onChange={(e) => setPFrom(e.target.value)} />
              </Label>
              <Label text="Bought to">
                <input type="date" value={pTo} onChange={(e) => setPTo(e.target.value)} />
              </Label>
              <Label text="Sold from">
                <input type="date" value={sFrom} onChange={(e) => setSFrom(e.target.value)} />
              </Label>
              <Label text="Sold to">
                <input type="date" value={sTo} onChange={(e) => setSTo(e.target.value)} />
              </Label>
              <Label text="Stock as on date" hint="Leave empty for today">
                <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} data-testid="items-asof" />
              </Label>
            </div>
            <div className="stack">
              <strong>Details</strong>
              {filters.map((f) => {
                const def = fieldById(f.field_id);
                const upd = (p: Partial<Filter>) => setFilters((fs) => fs.map((x) => (x.key === f.key ? { ...x, ...p } : x)));
                return (
                  <div key={f.key} className="row filter-row">
                    <select
                      value={f.field_id ?? ""}
                      onChange={(e) => {
                        const d = fieldById(Number(e.target.value));
                        upd({ field_id: Number(e.target.value) || null, op: d ? opsFor(d.kind)[0].value : "eq", value: null, value2: null });
                      }}
                      data-testid="filter-field"
                    >
                      <option value="">Choose a detail...</option>
                      {fields.data?.map((d) => (
                        <option key={d.id} value={d.id}>
                          {cat ? "" : `${catName(d.category_id)}: `}
                          {d.name}
                          {d.archived ? " (archived)" : ""}
                        </option>
                      ))}
                    </select>
                    {def && (
                      <>
                        <select value={f.op} onChange={(e) => upd({ op: e.target.value })} data-testid="filter-op">
                          {opsFor(def.kind).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        <div className="filter-val" data-testid="filter-value">
                          <FieldInput key={`${f.key}-${def.id}`} def={{ ...def, unit: def.unit }} value={f.value} onChange={(v) => upd({ value: v })} />
                        </div>
                        {f.op === "between" && (
                          <>
                            <span>and</span>
                            <div className="filter-val">
                              <FieldInput key={`${f.key}-${def.id}-2`} def={def} value={f.value2} onChange={(v) => upd({ value2: v })} />
                            </div>
                          </>
                        )}
                      </>
                    )}
                    <button className="btn btn-ghost" onClick={() => setFilters((fs) => fs.filter((x) => x.key !== f.key))} aria-label="Remove filter">
                      ✕
                    </button>
                  </div>
                );
              })}
              <div>
                <button className="btn btn-small" onClick={() => setFilters((fs) => [...fs, { key: Date.now(), field_id: null, op: "eq", value: null, value2: null }])} data-testid="add-filter">
                  + Filter by a detail
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <ErrorBox text={error} />
      {data && data.rows.length === 0 && <Empty>No items match. Try fewer filters.</Empty>}
      {data && data.rows.length > 0 && (
        <div className="table-wrap">
          <table className="table" data-testid="items-table">
            <thead>
              <tr>
                <th></th>
                <th>Item</th>
                <th>Category</th>
                {data.list_fields.map((f: FieldDef) => (
                  <th key={f.id}>{f.name}</th>
                ))}
                <th>Status</th>
                <th className="num">{data.as_of ? `Stock on ${date(data.as_of)}` : "In stock"}</th>
                <th>Bought</th>
                <th>Sold</th>
                <th className="num">Profit / loss</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: any) => (
                <tr key={r.id} className="click" onClick={() => go(`/item/${r.id}`)}>
                  <td className="thumb-cell">{r.photo ? <img src={fileUrl(r.photo)} alt="" /> : <span className="thumb-empty" />}</td>
                  <td>
                    <strong>{r.name}</strong>
                    {r.identifier && <span className="muted"> #{r.identifier}</span>}
                    
                  </td>
                  <td>{r.category_name}</td>
                  {data.list_fields.map((f: FieldDef) => (
                    <td key={f.id}>{r.fields?.[String(f.id)] ?? ""}</td>
                  ))}
                  <td>
                    <span className={`status ${STATUS[r.status]?.cls}`}>{STATUS[r.status]?.label}</span>
                  </td>
                  <td className={`num ${r.stock > 0 ? "" : "stock-out"}`}>{r.stock}</td>
                  <td className="small nowrap">
                    {r.money.bought_qty > 0 && (
                      <>
                        {date(r.money.last_bought)}
                        <div className="muted">
                          {r.money.bought_qty} at {money(r.money.avg_cost)}
                        </div>
                      </>
                    )}
                  </td>
                  <td className="small nowrap">
                    {r.money.sold_qty > 0 && (
                      <>
                        {date(r.money.last_sold)}
                        <div className="muted">
                          {r.money.sold_qty} for {money(r.money.revenue)}
                        </div>
                      </>
                    )}
                  </td>
                  <td className={`num ${r.money.profit > 0 ? "profit" : r.money.profit < 0 ? "loss" : "muted"}`}>
                    {r.money.sold_qty > 0 || r.money.written_off > 0 ? (r.money.profit < 0 ? `Loss ${money(-r.money.profit)}` : money(r.money.profit)) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted">
            {data.total} item{data.total === 1 ? "" : "s"}
            {data.total > data.rows.length && (
              <button className="btn btn-small" onClick={() => setLimit((l) => l + 200)} style={{ marginLeft: 12 }}>
                Show more
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
