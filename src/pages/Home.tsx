import { call } from "../api";
import Icon from "../components/Icon";
import { date, kindLabel, money, todayIso } from "../format";
import { go, useApp, useAsync } from "../ui";

export default function Home() {
  const { settings } = useApp();
  const { data } = useAsync(() => call("dashboard", { today: todayIso() }), []);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{settings.shop_name}</h1>
        <span className="muted">{date(todayIso())}</span>
      </div>
      <div className="big-actions">
        <button className="big-action primary" onClick={() => go("/sale")} data-testid="home-sale">
          <span className="ba-icon"><Icon name="sale" /></span>Make sale
        </button>
        <button className="big-action" onClick={() => go("/purchase")}>
          <span className="ba-icon"><Icon name="purchase" /></span>Record purchase
        </button>
        <button className="big-action" onClick={() => go("/item/new")}>
          <span className="ba-icon"><Icon name="add" /></span>Add item
        </button>
        <button className="big-action" onClick={() => go("/items")}>
          <span className="ba-icon"><Icon name="search" /></span>Find items
        </button>
      </div>
      {data && (
        <>
          <div className="cards">
            <div className="card stat">
              <span>Sales today</span>
              <strong>{money(data.today.sales_revenue)}</strong>
              <small>
                {data.today.sales_count} sale(s){data.today.refunds ? `, refunds ${money(data.today.refunds)}` : ""}
              </small>
            </div>
            <div className="card stat">
              <span>Sales this month</span>
              <strong>{money(data.month.sales_revenue)}</strong>
              <small>
                {data.month.refunds ? `Refunds ${money(data.month.refunds)}, ` : ""}
                {data.month.gross_profit < 0 ? `loss ${money(-data.month.gross_profit)}` : `profit ${money(data.month.gross_profit)}`}
              </small>
            </div>
            <div className="card stat">
              <span>Items</span>
              <strong>{data.item_count}</strong>
              <small>{data.month.stock_qty} pieces in stock</small>
            </div>
            <div className={`card stat ${data.low_stock ? "stat-warn" : ""}`} onClick={() => go("/items", { status: "low" })}>
              <span>Low stock</span>
              <strong>{data.low_stock}</strong>
              <small>item(s) need buying</small>
            </div>
          </div>
          <div className="card">
            <h2>Latest records</h2>
            <table className="table">
              <tbody>
                {data.recent.map((r: any) => (
                  <tr key={r.id} className="click" onClick={() => go(`/txn/${r.id}`)}>
                    <td>{date(r.business_date)}</td>
                    <td>{r.number}</td>
                    <td>{kindLabel(r.kind, r.related_kind)}</td>
                    <td>{r.party}</td>
                    <td className="num">{money(r.total)}</td>
                  </tr>
                ))}
                {data.recent.length === 0 && (
                  <tr>
                    <td className="muted">Nothing yet. Start by adding an item, then record a purchase.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
