import { useEffect, useState } from "react";
import { call } from "../api";

export type Detail = { name: string; value: string; print: boolean };

const COMMON = ["Phone", "CNIC", "Address", "Payment method", "Warranty", "Delivery date", "Registration no."];

export function DetailRows(props: { rows: Detail[]; onChange: (rows: Detail[]) => void; testid?: string }) {
  const [names, setNames] = useState<string[]>(COMMON);
  useEffect(() => {
    call<string[]>("detail_names")
      .then((used) => setNames([...used, ...COMMON.filter((c) => !used.some((u) => u.toLowerCase() === c.toLowerCase()))]))
      .catch(() => {});
  }, []);
  const set = (i: number, p: Partial<Detail>) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const add = (name = "") => props.onChange([...props.rows, { name, value: "", print: false }]);
  const unused = names.filter((n) => !props.rows.some((r) => r.name.toLowerCase() === n.toLowerCase())).slice(0, 8);
  const id = props.testid ?? "detail";
  return (
    <div className="details-box" data-testid={`${id}-box`}>
      {props.rows.map((r, i) => (
        <div key={i} className="detail-row">
          <input value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Name, like Phone" list="detail-names" data-testid={`${id}-name-${i}`} />
          <input className="grow" value={r.value} onChange={(e) => set(i, { value: e.target.value })} placeholder="Value" autoFocus={!!r.name && !r.value} data-testid={`${id}-value-${i}`} />
          <label className="check small" title="Print this on the slip">
            <input type="checkbox" checked={r.print} onChange={(e) => set(i, { print: e.target.checked })} data-testid={`${id}-print-${i}`} /> On slip
          </label>
          <button type="button" className="btn btn-ghost" aria-label="Take off" onClick={() => props.onChange(props.rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="row chips">
        {unused.map((n) => (
          <button key={n} type="button" className="chip chip-btn" onClick={() => add(n)}>
            + {n}
          </button>
        ))}
        <button type="button" className="chip chip-btn" onClick={() => add()} data-testid={`${id}-add`}>
          + Other detail
        </button>
      </div>
      <datalist id="detail-names">
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </div>
  );
}
