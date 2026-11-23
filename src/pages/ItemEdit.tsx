import { useEffect, useMemo, useRef, useState } from "react";
import { call, fileUrl, newToken, uploadImage } from "../api";
import { DraftField, FieldEditor, GroupedFields, createCategoryField } from "../components/Fields";
import { money, moneyInput, parseMoney, parseQty, todayIso } from "../format";
import { Category, ErrorBox, FieldDef, Label, Modal, go, useApp } from "../ui";

type PhotoRef = { file: string; sha256: string; bytes: number; original_name: string; id?: number };

export default function ItemEdit(props: { id?: number; categoryId?: string | null; onSaved?: (item: any) => void; onCancel?: () => void }) {
  const { toast } = useApp();
  const [cats, setCats] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<number | null>(props.categoryId ? Number(props.categoryId) : null);
  const [name, setName] = useState("");
  const [tracking, setTracking] = useState<"quantity" | "unique">("quantity");
  const [identifier, setIdentifier] = useState("");
  const [price, setPrice] = useState("");
  const [reorder, setReorder] = useState("");
  const [qty, setQty] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  const [boughtOn, setBoughtOn] = useState(todayIso());
  const [supplier, setSupplier] = useState("");
  const stockToken = useRef(newToken());
  const [boughtEach, setBoughtEach] = useState<number | null>(null);
  const [taken, setTaken] = useState<any>(null);
  useEffect(() => {
    if (tracking !== "unique" || !identifier.trim()) return setTaken(null);
    const t = setTimeout(() => {
      call("identifier_check", { identifier, except: props.id ?? null })
        .then((r) => setTaken(r.free ? null : r))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [identifier, tracking, props.id]);
  const [notes, setNotes] = useState("");
  const [values, setValues] = useState<Record<string, any>>({});
  const [catFields, setCatFields] = useState<FieldDef[]>([]);
  const [itemFields, setItemFields] = useState<FieldDef[]>([]);
  const [newFields, setNewFields] = useState<{ key: string; def: FieldDef }[]>([]);
  const [photos, setPhotos] = useState<PhotoRef[]>([]);
  const [added, setAdded] = useState<PhotoRef[]>([]);
  const [fieldModal, setFieldModal] = useState(false);
  const [editField, setEditField] = useState<FieldDef | null>(null);
  const [catModal, setCatModal] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const editing = !!props.id;

  useEffect(() => {
    call<Category[]>("category_list").then(setCats);
  }, []);

  useEffect(() => {
    if (!props.id) return;
    call("item_get", { id: props.id }).then((r) => {
      const it = r.item;
      setCategoryId(it.category_id);
      setName(it.name);
      setTracking(it.tracking);
      setIdentifier(it.identifier);
      setPrice(moneyInput(it.sale_price));
      setReorder(it.reorder_level ?? "");
      const m = r.money;
      setBoughtEach(m && m.bought_qty > 0 ? Math.round(m.bought_cost / m.bought_qty) : null);
      setNotes(it.notes);
      setValues(r.values);
      setPhotos(r.photos);
      setItemFields((r.fields as FieldDef[]).filter((f) => f.item_id === props.id || (f.category_id !== it.category_id && !f.item_id)));
    });
  }, [props.id]);

  useEffect(() => {
    if (!categoryId) return setCatFields([]);
    call<FieldDef[]>("field_list", { category_id: categoryId }).then(setCatFields);
  }, [categoryId]);

  const category = cats.find((c) => c.id === categoryId);
  const allFields: FieldDef[] = useMemo(() => {
    const ids = new Set(catFields.map((f) => f.id));
    const extra = itemFields.filter((f) => !ids.has(f.id));
    const pending = newFields.map((n, i) => ({ ...n.def, id: -1 - i }));
    return [...catFields, ...extra, ...pending];
  }, [catFields, itemFields, newFields]);
  const keyOf = (f: FieldDef) => (f.id > 0 ? String(f.id) : `new:${newFields[-1 - f.id]?.key}`);
  const groups = useMemo(() => [...new Set(allFields.map((f) => f.group_name).filter(Boolean))], [allFields]);

  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const p = await uploadImage("photo_store", f);
        setAdded((a) => [...a, p]);
      }
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const saveField = async (d: DraftField) => {
    if (d.scope === "item" || !categoryId) {
      const key = `f${Date.now()}`;
      setNewFields((n) => [...n, { key, def: { ...(d as FieldDef), id: 0, category_id: null, item_id: props.id ?? null, sort_order: 0, archived: false } }]);
    } else {
      const f = await createCategoryField(categoryId, d);
      setCatFields((c) => [...c, f]);
      toast(`Field "${f.name}" added to ${category?.name}`);
    }
  };

  const save = async () => {
    setError("");
    if (!categoryId) return setError("Please choose a category");
    if (taken) return setError(`Chassis / serial number already used by "${taken.name}". Each number must be different.`);
    const sp = parseMoney(price);
    if (Number.isNaN(sp)) return setError("The selling price is not a valid amount");
    const rl = parseQty(String(reorder));
    if (Number.isNaN(rl)) return setError("Low stock warning must be a whole number");
    const bp = editing ? null : parseMoney(buyPrice);
    if (Number.isNaN(bp)) return setError("The buy price is not a valid amount");
    const q = editing ? null : tracking === "unique" ? (bp !== null ? 1 : null) : parseQty(qty);
    if (Number.isNaN(q)) return setError("Quantity must be a whole number, like 5");
    if (q && bp === null) return setError("Please type the price you paid for each piece");
    if (bp !== null && !q) return setError("Please type how many pieces you have");
    setBusy(true);
    try {
      const r = await call("item_save", {
        id: props.id,
        category_id: categoryId,
        name,
        tracking,
        identifier,
        sale_price: sp,
        reorder_level: rl,
        notes,
        values,
        new_fields: newFields.map((n) => ({ key: n.key, ...n.def })),
        add_photos: added,
      });
      if (q && bp !== null) {
        try {
          await call("purchase_post", {
            client_token: stockToken.current,
            business_date: boughtOn,
            party: supplier,
            notes: "Stock entered when the item was added",
            lines: [{ item_id: r.item.id, qty: q, unit_price: bp }],
          });
        } catch (e: any) {
          toast(`Item saved, but the stock was not: ${e.message}. Press Buy more on the item to add it.`, "error");
          go(`/item/${r.item.id}`);
          return;
        }
      }
      toast(editing ? "Item saved" : q ? `"${r.item.name}" added with ${q} in stock` : `"${r.item.name}" added`);
      if (props.onSaved) props.onSaved(await call("item_get", { id: r.item.id }).catch(() => r));
      else go(`/item/${r.item.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const shownPhotos = [...photos, ...added];

  return (
    <div className="page">
      <div className="page-head">
        <h1>{editing ? `Edit ${name}` : "Add item"}</h1>
      </div>
      <div className="card stack">
        <div className="photos-edit">
          {shownPhotos.map((p, i) => (
            <div key={p.file + i} className="photo-tile">
              <img src={fileUrl(p.file)} alt={p.original_name} />
              {p.id ? (
                <span className="muted small">Saved</span>
              ) : (
                <button type="button" className="btn btn-small" onClick={() => setAdded((a) => a.filter((x) => x !== p))} title="Not saved yet">
                  Take off
                </button>
              )}
            </div>
          ))}
          <button type="button" className="photo-add" onClick={() => fileInput.current?.click()} disabled={uploading}>
            {uploading ? "Adding..." : "+ Add photo"}
          </button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => addPhotos(e.target.files)} data-testid="photo-input" />
        </div>

        <div className="grid2">
          <Label text="Item name" required>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="item-name" />
          </Label>
          <Label text="Category" required>
            <div className="row nowrap">
              <select
                value={categoryId ?? ""}
                onChange={(e) => (e.target.value === "__new" ? setCatModal(true) : setCategoryId(e.target.value ? Number(e.target.value) : null))}
                data-testid="item-category"
              >
                <option value="">Choose...</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="__new">+ New category...</option>
              </select>
            </div>
          </Label>
        </div>

        {!editing && (
          <fieldset className="scope">
            <legend>How is this item counted?</legend>
            <label className="check">
              <input type="radio" checked={tracking === "quantity"} onChange={() => setTracking("quantity")} />
              <span>
                <strong>By quantity</strong> - many identical pieces, like 20 chairs
              </span>
            </label>
            <label className="check">
              <input type="radio" checked={tracking === "unique"} onChange={() => setTracking("unique")} data-testid="tracking-unique" />
              <span>
                <strong>One of a kind</strong> - a single piece with its own number, like a used scooter with a chassis number
              </span>
            </label>
          </fieldset>
        )}

        {(tracking === "unique" || (editing && identifier)) && (
          <div className="grid4">
            <Label text={tracking === "unique" ? "Chassis / serial number" : "Item code"} required={tracking === "unique"}>
              <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} className={taken ? "input-bad" : ""} data-testid="item-identifier" />
              {taken && (
                <span className="field-error" data-testid="identifier-taken">
                  Already used by "{taken.name}" ({taken.identifier}). Each number must be different.
                </span>
              )}
            </Label>
          </div>
        )}
        <fieldset className="scope stock-now" data-testid="stock-section">
          <legend>{tracking === "unique" ? "Prices" : "Prices and stock"}</legend>
          <div className="grid4">
            {tracking === "quantity" && !editing && (
              <Label text="Quantity (pieces)">
                <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" data-testid="item-qty" />
              </Label>
            )}
            {editing ? (
              <Label text={tracking === "unique" ? "Buy price" : "Buy price (each)"} hint={boughtEach === null ? "Not bought yet. Press Buy more on the item." : "From your purchases"}>
                <input value={boughtEach === null ? "" : moneyInput(boughtEach)} disabled data-testid="item-buy-price" />
              </Label>
            ) : (
              <Label text={tracking === "unique" ? "Buy price" : "Buy price (each)"}>
                <input inputMode="decimal" value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)} placeholder="0" data-testid="item-buy-price" />
              </Label>
            )}
            <Label text={tracking === "unique" ? "Selling price" : "Selling price (each)"}>
              <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" data-testid="item-price" />
            </Label>
          </div>
          <ProfitLine
            qty={editing ? 1 : tracking === "unique" ? 1 : parseQty(qty)}
            buy={editing ? boughtEach : parseMoney(buyPrice)}
            sell={parseMoney(price)}
            unique={tracking === "unique"}
          />
          {!editing && (
            <div className="grid4">
              <Label text="Date bought">
                <input type="date" value={boughtOn} onChange={(e) => setBoughtOn(e.target.value)} data-testid="item-bought-on" />
              </Label>
              <Label text="Bought from (optional)">
                <input value={supplier} onChange={(e) => setSupplier(e.target.value)} data-testid="item-supplier" />
              </Label>
              {tracking === "quantity" && (
                <Label text="Warn me when stock is at or below (optional)">
                  <input inputMode="numeric" value={reorder} onChange={(e) => setReorder(e.target.value)} />
                </Label>
              )}
            </div>
          )}
          {editing && tracking === "quantity" && (
            <div className="grid4">
              <Label text="Warn me when stock is at or below (optional)">
                <input inputMode="numeric" value={reorder} onChange={(e) => setReorder(e.target.value)} />
              </Label>
            </div>
          )}
          <p className="muted small">
            {editing
              ? "To add more stock later, open the item and press Buy more."
              : tracking === "unique"
                ? "Leave the buy price empty if it is not in the shop yet. You can record the purchase later."
                : "Leave the quantity empty if you have none yet. You can add stock later with Record purchase."}
          </p>
        </fieldset>

        <div className="section-head">
          <h2>Details</h2>
          <button type="button" className="btn" onClick={() => setFieldModal(true)} data-testid="add-field">
            + Add a field
          </button>
        </div>
        {allFields.length === 0 && <p className="muted">{categoryId ? "No fields yet. Press Add a field to record details like size, material or model year." : "Choose a category to see its fields."}</p>}
        <GroupedFields fields={allFields} values={values} keyOf={keyOf} onChange={(k, v) => setValues((x) => ({ ...x, [k]: v }))} onEditField={setEditField} />

        <Label text="Notes">
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Label>
        <ErrorBox text={error} />
        <div className="row">
          <button className="btn" onClick={() => (props.onCancel ? props.onCancel() : history.back())}>
            Cancel
          </button>
          <button className="btn btn-primary btn-big" onClick={save} disabled={busy || uploading} data-testid="item-save">
            {editing ? "Save changes" : "Save item"}
          </button>
        </div>
      </div>
      {fieldModal && (
        <FieldEditor
          categoryName={category?.name}
          allowItemScope
          allowCategoryScope={!!categoryId}
          groups={groups}
          onSave={saveField}
          onClose={() => setFieldModal(false)}
        />
      )}
      {editField && (
        <FieldEditor
          initial={editField}
          groups={groups}
          onSave={async (d) => {
            const { scope: _scope, ...patch } = d as any;
            const f = await call<FieldDef>("field_update", { id: editField.id, patch });
            const swap = (list: FieldDef[]) => list.map((x) => (x.id === f.id ? f : x));
            setCatFields(swap);
            setItemFields(swap);
            setValues((v) => {
              const k = String(f.id);
              if (v[k] === undefined || v[k] === null || f.kind === editField.kind) return v;
              return { ...v, [k]: ["text", "longtext", "choice", "date", "decimal"].includes(f.kind) ? String(v[k]) : v[k] };
            });
            toast(`Field "${f.name}" changed`);
          }}
          onClose={() => setEditField(null)}
        />
      )}
      {catModal && (
        <NewCategory
          onClose={() => setCatModal(false)}
          onCreated={(c) => {
            setCats((x) => [...x, c]);
            setCategoryId(c.id);
          }}
        />
      )}
    </div>
  );
}

export function NewCategory(props: { onClose: () => void; onCreated: (c: Category) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const create = async () => {
    try {
      const r = await call("category_create", { name });
      props.onCreated({ id: r.id, name: name.trim(), archived: false, item_count: 0, field_count: 0 });
      props.onClose();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <Modal
      title="New category"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create} data-testid="category-create">
            Create
          </button>
        </>
      }
    >
      <Label text="Category name" hint="Like Furniture, Scooters, Phones">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} data-testid="category-name" />
      </Label>
      <ErrorBox text={error} />
    </Modal>
  );
}

function ProfitLine(props: { qty: number | null; buy: number | null; sell: number | null; unique: boolean }) {
  const ok = (v: number | null) => v !== null && !Number.isNaN(v);
  if (!ok(props.buy) || !ok(props.sell)) return null;
  const each = (props.sell as number) - (props.buy as number);
  const q = ok(props.qty) && (props.qty as number) > 0 ? (props.qty as number) : 1;
  const cls = each > 0 ? "profit" : each < 0 ? "loss" : "";
  const word = each < 0 ? "Loss" : "Profit";
  return (
    <div className={`profit-line ${cls}`} data-testid="stock-preview">
      <strong>
        {word} {money(Math.abs(each))}
        {props.unique ? "" : " on each piece"}
      </strong>
      {!props.unique && q > 1 && (
        <span>
          {" "}
          ({word.toLowerCase()} {money(Math.abs(each) * q)} on all {q}. You pay {money((props.buy as number) * q)}.)
        </span>
      )}
    </div>
  );
}
