import { useState } from "react";
import { call, exportCsv } from "../api";
import { date, money, monthRange, thisMonth, todayIso } from "../format";
import { Category, ErrorBox, Label, Tabs, go, useApp, useAsync } from "../ui";

const DRILL: Record<string, { kinds: string[]; title: string }> = {
  purchases: { kinds: ["purchase", "reversal:purchase"], title: "Purchases" },
  sales: { kinds: ["sale"], title: "Sales" },
  refunds: { kinds: ["return", "reversal:sale", "reversal:return"], title: "Refunds and reversed sales" },
  profit: { kinds: ["sale", "return", "reversal:sale", "reversal:return"], title: "Sales, refunds and their cost" },
};

export default function ReportsPage() {
  const { toast } = useApp();
  const [mode, setMode] = useState("month");
  const [month, setMonth] = useState(thisMonth());
  const [from, setFrom] = useState(`${todayIso().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [cat, setCat] = useState("");
  const cats = useAsync(() => call<Category[]>("category_list", { include_archived: true }), []);
  const [f, t] = mode === "month" ? monthRange(month) : [from, to];
  const category_id = cat ? Number(cat) : null;
  const fig = useAsync(() => call("report_figures", { from: f, to: t, category_id }), [f, t, cat]);
  const monthly = useAsync(() => (mode === "custom" ? call("report_monthly", { from: f, to: t, category_id }) : Promise.resolve(null)), [mode, f, t, cat]);
  const me = useAsync(() => call("report_month_end", { from: f, to: t, category_id }), [f, t, cat]);
  const stock = useAsync(() => call("report_stock", { as_of: t, category_id }), [t, cat]);

  const drill = (k: keyof typeof DRILL, a = f, b = t) => go("/history", { kinds: DRILL[k].kinds, from: a, to: b, category: cat, title: `${DRILL[k].title} ${date(a)} to ${date(b)}` });
  const d = fig.data;

  const Card = (p: { label: string; value: string; sub?: string; k?: keyof typeof DRILL; testid?: string; onClick?: () => void }) => (
    <button className="card stat click" onClick={p.onClick ?? (() => p.k && drill(p.k))} data-testid={p.testid}>
      <span>{p.label}</span>
      <strong>{p.value}</strong>
      {p.sub && <small>{p.sub}</small>}
      <small className="link">Open records →</small>
    </button>
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Reports</h1>
        <div className="row">
          <button className="btn" onClick={async () => (await exportCsv(`monthly-${f}-${t}.csv`, "monthly", { from: f, to: t, category_id })) && toast("Saved")}>
            Export months (CSV)
          </button>
          <button className="btn" onClick={async () => (await exportCsv(`stock-${t}.csv`, "stock", { as_of: t, category_id })) && toast("Saved")}>
            Export stock (CSV)
          </button>
        </div>
      </div>
      <div className="card filters">
        <Tabs
          tabs={[
            { key: "month", label: "One month" },
            { key: "custom", label: "Choose dates" },
          ]}
          value={mode}
          onChange={setMode}
        />
        <div className="row">
          {mode === "month" ? (
            <Label text="Month">
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} data-testid="report-month" />
            </Label>
          ) : (
            <>
              <Label text="From">
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="report-from" />
              </Label>
              <Label text="To">
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="report-to" />
              </Label>
            </>
          )}
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
        </div>
      </div>
      <ErrorBox text={fig.error || me.error} />
      {me.data && <MonthEnd r={me.data} />}
      <h2>All figures</h2>
      {d && (
        <div className="cards">
          <Card label="Bought (pieces)" value={String(d.qty_purchased)} k="purchases" testid="fig-qty-purchased" />
          <Card label="Purchase spend" value={money(d.purchase_spend)} k="purchases" testid="fig-purchase-spend" />
          <Card label="Sold (pieces)" value={String(d.qty_sold)} k="sales" testid="fig-qty-sold" />
          <Card label="Sales revenue" value={money(d.sales_revenue)} sub={`${d.sales_count} sale(s)`} k="sales" testid="fig-revenue" />
          <Card label="Refunds" value={money(d.refunds)} sub={`${d.qty_refunded} piece(s) back`} k="refunds" testid="fig-refunds" />
          <Card label="Net sales" value={money(d.net_sales)} k="profit" testid="fig-net" />
          <Card label="Cost of goods sold" value={money(d.cogs)} k="profit" testid="fig-cogs" />
          <Card label="Gross profit" value={money(d.gross_profit)} k="profit" testid="fig-profit" />
          <Card label={`Stock on ${date(t)}`} value={`${d.stock_qty} pcs`} sub={`Cost value ${money(d.stock_value)}`} testid="fig-stock" onClick={() => go("/items", { as_of: t, category: cat, status: "in_stock" })} />
        </div>
      )}
      <p className="muted small">
        Profit uses the real cost of the pieces sold. One of a kind items use their own purchase price. Items counted by quantity use first in, first out: the oldest pieces bought are
        counted as sold first. Stock corrections are not counted as profit or loss here.
      </p>
      {monthly.data && (
        <div className="card">
          <h2>Month by month</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="num">Bought</th>
                  <th className="num">Spend</th>
                  <th className="num">Sold</th>
                  <th className="num">Revenue</th>
                  <th className="num">Refunds</th>
                  <th className="num">Net sales</th>
                  <th className="num">Cost</th>
                  <th className="num">Profit</th>
                  <th className="num">Stock at end</th>
                </tr>
              </thead>
              <tbody>
                {monthly.data.months.map((m: any) => (
                  <tr key={m.month}>
                    <td>{m.month}</td>
                    <td className="num click" onClick={() => drill("purchases", m.from, m.to)}>
                      {m.qty_purchased}
                    </td>
                    <td className="num click" onClick={() => drill("purchases", m.from, m.to)}>
                      {money(m.purchase_spend)}
                    </td>
                    <td className="num click" onClick={() => drill("sales", m.from, m.to)}>
                      {m.qty_sold}
                    </td>
                    <td className="num click" onClick={() => drill("sales", m.from, m.to)}>
                      {money(m.sales_revenue)}
                    </td>
                    <td className="num click" onClick={() => drill("refunds", m.from, m.to)}>
                      {money(m.refunds)}
                    </td>
                    <td className="num click" onClick={() => drill("profit", m.from, m.to)}>
                      {money(m.net_sales)}
                    </td>
                    <td className="num click" onClick={() => drill("profit", m.from, m.to)}>
                      {money(m.cogs)}
                    </td>
                    <td className="num click" onClick={() => drill("profit", m.from, m.to)}>
                      {money(m.gross_profit)}
                    </td>
                    <td className="num">{m.stock_qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {stock.data && (
        <div className="card">
          <h2>
            Stock on {date(t)}: {stock.data.qty} pieces, cost value {money(stock.data.value)}
          </h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th className="num">Pieces</th>
                  <th className="num">Cost value</th>
                </tr>
              </thead>
              <tbody>
                {stock.data.rows.slice(0, 300).map((r: any) => (
                  <tr key={r.id} className="click" onClick={() => go(`/item/${r.id}`)}>
                    <td>
                      {r.name}
                      {r.identifier && <span className="muted"> #{r.identifier}</span>}
                    </td>
                    <td>{r.category_name}</td>
                    <td className="num">{r.qty}</td>
                    <td className="num">{money(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function MonthEnd(props: { r: any }) {
  const r = props.r;
  return (
    <div className="stack" data-testid="month-end">
      <h2>
        Month end: {date(r.from)} to {date(r.to)}
      </h2>
      <div className="cards">
        <div className="card stat">
          <span>Sold</span>
          <strong data-testid="me-sold">{r.sold.qty} pcs</strong>
          <small>for {money(r.sold.net_sales)}</small>
        </div>
        <div className="card stat">
          <span>Not sold (still in stock)</span>
          <strong data-testid="me-unsold">{r.unsold.qty} pcs</strong>
          <small>
            {r.unsold.items} item(s), cost {money(r.unsold.value)}
          </small>
        </div>
        <div className="card stat">
          <span>Total profit</span>
          <strong className={r.total_profit > 0 ? "profit" : ""} data-testid="me-profit">
            {money(r.total_profit)}
          </strong>
        </div>
        <div className="card stat">
          <span>Total loss</span>
          <strong className={r.total_loss > 0 ? "loss" : ""} data-testid="me-loss">
            {money(r.total_loss)}
          </strong>
        </div>
        <div className="card stat">
          <span>Result</span>
          <strong className={r.net_result > 0 ? "profit" : r.net_result < 0 ? "loss" : ""} data-testid="me-net">
            {r.net_result < 0 ? `Loss ${money(-r.net_result)}` : money(r.net_result)}
          </strong>
        </div>
      </div>
      <div className="card">
        <h2>Items that made a loss</h2>
        {r.loss_items.length === 0 ? (
          <p className="muted">No loss this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="loss-items">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Sold</th>
                  <th className="num">Sold for</th>
                  <th className="num">It cost</th>
                  <th className="num">Written off</th>
                  <th className="num">Loss</th>
                </tr>
              </thead>
              <tbody>
                {r.loss_items.map((x: any) => (
                  <tr key={x.id} className="click" onClick={() => go(`/item/${x.id}`)}>
                    <td>
                      {x.name}
                      {x.identifier && <span className="muted"> #{x.identifier}</span>}
                      <div className="muted small">{x.category_name}</div>
                    </td>
                    <td className="num">{x.sold_qty}</td>
                    <td className="num">{money(x.revenue)}</td>
                    <td className="num">{money(x.sold_cost)}</td>
                    <td className="num">{x.written_off ? `${x.written_off_qty} pcs, ${money(x.written_off)}` : ""}</td>
                    <td className="num loss">{money(-x.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {r.write_offs.length > 0 && (
          <>
            <h3>Written off (damaged, lost)</h3>
            <table className="table">
              <tbody>
                {r.write_offs.map((w: any) => (
                  <tr key={w.txn_id} className={`click ${w.reversed ? "row-muted" : ""}`} onClick={() => go(`/txn/${w.txn_id}`)}>
                    <td>{date(w.business_date)}</td>
                    <td>{w.number}</td>
                    <td>{w.description}</td>
                    <td className="num">{w.qty} pcs</td>
                    <td className="num">{money(w.cost)}</td>
                    <td>
                      {w.reason}
                      {w.reversed && " (reversed)"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
