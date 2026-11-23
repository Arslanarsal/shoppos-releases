import { useMemo, useState } from "react";
import { call } from "../api";
import { FIELD_KINDS, money, moneyInput, parseMoney } from "../format";
import { ErrorBox, FieldDef, Label, Modal } from "../ui";

export function displayValue(def: FieldDef, v: any): string {
  if (v === null || v === undefined || v === "") return "";
  let s: string;
  if (def.kind === "bool") s = v ? "Yes" : "No";
  else if (def.kind === "money") return money(Number(v));
  else s = String(v);
  return def.unit ? `${s} ${def.unit}` : s;
}

export function FieldInput(props: { def: FieldDef; value: any; onChange: (v: any) => void; id?: string }) {
  const { def, value, onChange } = props;
  const [moneyText, setMoneyText] = useState(def.kind === "money" ? moneyInput(value) : "");
  const common = { id: props.id, "aria-label": def.name, "data-field": def.name };
  switch (def.kind) {
    case "longtext":
      return <textarea {...common} rows={3} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "int":
      return (
        <div className="with-unit">
          <input {...common} inputMode="numeric" value={value ?? ""} onChange={(e) => onChange(e.target.value.replace(/[^\d-]/g, ""))} />
          {def.unit && <span className="unit">{def.unit}</span>}
        </div>
      );
    case "decimal":
      return (
        <div className="with-unit">
          <input {...common} inputMode="decimal" value={value ?? ""} onChange={(e) => onChange(e.target.value.replace(/[^\d.,-]/g, ""))} />
          {def.unit && <span className="unit">{def.unit}</span>}
        </div>
      );
    case "money":
      return (
        <input
          {...common}
          inputMode="decimal"
          value={moneyText}
          onChange={(e) => {
            setMoneyText(e.target.value);
            const p = parseMoney(e.target.value);
            onChange(p === null || Number.isNaN(p) ? (e.target.value.trim() ? e.target.value : null) : p);
          }}
        />
      );
    case "date":
      return <input {...common} type="date" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "bool":
      return (
        <select {...common} value={value === true ? "yes" : value === false ? "no" : ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "yes")}>
          <option value="">-</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    case "choice":
      return <ChoiceInput def={def} value={value} onChange={onChange} common={common} />;
    default:
      return <input {...common} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
}

function ChoiceInput(props: { def: FieldDef; value: any; onChange: (v: any) => void; common: any }) {
  const { def, value, onChange } = props;
  const [extra, setExtra] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const options = [...def.options, ...extra.filter((x) => !def.options.includes(x))];
  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setErr("");
    const same = options.find((o) => o.toLowerCase() === t.toLowerCase());
    if (!same) {
      try {
        await call("field_update", { id: def.id, patch: { options: [...options, t] } });
        setExtra((x) => [...x, t]);
      } catch (e: any) {
        return setErr(e.message);
      }
    }
    onChange(same ?? t);
    setAdding(false);
    setText("");
  };
  if (adding) {
    return (
      <div className="row nowrap">
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} placeholder={`New ${def.name.toLowerCase()}`} autoFocus data-testid={`choice-new-${def.name}`} />
        <button type="button" className="btn btn-small btn-primary" onClick={add} data-testid={`choice-add-${def.name}`}>
          Add
        </button>
        <button type="button" className="btn btn-small" onClick={() => setAdding(false)}>
          Cancel
        </button>
        {err && <span className="field-error">{err}</span>}
      </div>
    );
  }
  return (
    <select {...props.common} value={value ?? ""} onChange={(e) => (e.target.value === "__new__" ? setAdding(true) : onChange(e.target.value || null))}>
      <option value="">-</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
      {def.id > 0 && <option value="__new__">+ Add new...</option>}
    </select>
  );
}

export type DraftField = Partial<FieldDef> & { name: string; kind: string; scope?: "category" | "item" };

export function FieldEditor(props: {
  initial?: FieldDef;
  categoryName?: string;
  allowItemScope?: boolean;
  allowCategoryScope?: boolean;
  groups: string[];
  onSave: (d: DraftField) => Promise<void>;
  onClose: () => void;
}) {
  const init = props.initial;
  const [name, setName] = useState(init?.name ?? "");
  const [kind, setKind] = useState(init?.kind ?? "text");
  const [unit, setUnit] = useState(init?.unit ?? "");
  const [options, setOptions] = useState((init?.options ?? []).join("\n"));
  const [group, setGroup] = useState(init?.group_name ?? "");
  const [required, setRequired] = useState(init?.required ?? false);
  const [inList, setInList] = useState(init?.show_in_list ?? false);
  const [onReceipt, setOnReceipt] = useState(init?.show_on_receipt ?? true);
  const [scope, setScope] = useState<"category" | "item">(props.allowCategoryScope === false ? "item" : "category");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError("");
    if (!name.trim()) return setError("Please type a name for the field");
    const opts = options
      .split(/\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (kind === "choice" && opts.length === 0) return setError("Write at least one choice, one per line");
    setBusy(true);
    try {
      await props.onSave({ name: name.trim(), kind, unit, options: opts, group_name: group, required, show_in_list: inList, show_on_receipt: onReceipt, scope });
      props.onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={init ? `Change field "${init.name}"` : "New field"}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy} data-testid="field-save">
            {init ? "Save field" : "Add field"}
          </button>
        </>
      }
    >
      <div className="stack">
        <Label text="Field name" required hint="For example: Drawer count, Material, Chassis number">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="field-name" />
        </Label>
        <Label text="What kind of information?">
          <select value={kind} onChange={(e) => setKind(e.target.value)} data-testid="field-kind">
            {FIELD_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label} - {k.hint}
              </option>
            ))}
          </select>
        </Label>
        {(kind === "decimal" || kind === "int") && (
          <Label text="Unit (optional)" hint="Like cm, kg, cc, km">
            <input value={unit} onChange={(e) => setUnit(e.target.value)} style={{ width: 160 }} />
          </Label>
        )}
        {kind === "choice" && (
          <Label text="Choices" hint="One choice per line">
            <textarea rows={4} value={options} onChange={(e) => setOptions(e.target.value)} data-testid="field-options" />
          </Label>
        )}
        <Label text="Group (optional)" hint="Fields with the same group are shown together, like Size or Engine">
          <input list="field-groups" value={group} onChange={(e) => setGroup(e.target.value)} />
          <datalist id="field-groups">
            {props.groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </Label>
        <label className="check">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Must be filled in
        </label>
        <label className="check">
          <input type="checkbox" checked={inList} onChange={(e) => setInList(e.target.checked)} /> Show in item lists
        </label>
        <label className="check">
          <input type="checkbox" checked={onReceipt} onChange={(e) => setOnReceipt(e.target.checked)} /> Print on receipts
        </label>
        {!init && (props.allowItemScope ?? false) && (
          <fieldset className="scope">
            <legend>Use this field for</legend>
            {props.allowCategoryScope !== false && (
              <label className="check">
                <input type="radio" name="scope" checked={scope === "category"} onChange={() => setScope("category")} data-testid="scope-category" />
                All {props.categoryName ?? "category"} items, now and in future
              </label>
            )}
            <label className="check">
              <input type="radio" name="scope" checked={scope === "item"} onChange={() => setScope("item")} data-testid="scope-item" />
              Only this item
            </label>
          </fieldset>
        )}
        <ErrorBox text={error} />
      </div>
    </Modal>
  );
}

export function GroupedFields(props: {
  fields: FieldDef[];
  values: Record<string, any>;
  keyOf: (f: FieldDef) => string;
  onChange: (key: string, v: any) => void;
  onEditField?: (f: FieldDef) => void;
}) {
  const [q, setQ] = useState("");
  const many = props.fields.length > 30;
  const groups = useMemo(() => {
    const m = new Map<string, FieldDef[]>();
    for (const f of props.fields) {
      const g = f.group_name || "Details";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(f);
    }
    return [...m.entries()];
  }, [props.fields]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const query = q.trim().toLowerCase();

  if (props.fields.length === 0) return null;
  return (
    <div className="fields">
      {many && (
        <div className="row">
          <input className="search" placeholder={`Search ${props.fields.length} fields...`} value={q} onChange={(e) => setQ(e.target.value)} data-testid="field-search" />
        </div>
      )}
      {groups.map(([g, fs]) => {
        const visible = query ? fs.filter((f) => f.name.toLowerCase().includes(query)) : fs;
        if (visible.length === 0) return null;
        const filled = fs.filter((f) => {
          const v = props.values[props.keyOf(f)];
          return v !== undefined && v !== null && v !== "";
        }).length;
        const isOpen = query ? true : (open[g] ?? (!many || groups.length === 1));
        const shown = isOpen ? visible : visible.filter((f) => f.required);
        return (
          <section key={g} className="field-group">
            <button type="button" className="group-head" onClick={() => setOpen({ ...open, [g]: !isOpen })} aria-expanded={isOpen}>
              <span>{isOpen ? "▾" : "▸"}</span> {g}
              <span className="muted">
                {" "}
                {filled}/{fs.length} filled
              </span>
            </button>
            {shown.length > 0 && (
              <div className="grid2">
                {shown.map((f) => (
                  <div key={props.keyOf(f)} className="field-cell">
                    <Label text={f.name + (f.archived ? " (archived)" : "")} required={f.required}>
                      <FieldInput def={f} value={props.values[props.keyOf(f)]} onChange={(v) => props.onChange(props.keyOf(f), v)} />
                    </Label>
                    {props.onEditField && f.id > 0 && (
                      <button type="button" className="field-change" onClick={() => props.onEditField!(f)} title="Change name or type" data-testid={`field-change-${f.name}`}>
                        Change
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export async function createCategoryField(categoryId: number, d: DraftField): Promise<FieldDef> {
  return call<FieldDef>("field_create", { category_id: categoryId, ...d });
}
