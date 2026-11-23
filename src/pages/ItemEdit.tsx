import { useEffect, useMemo, useRef, useState } from "react";
import { call, fileUrl, uploadImage } from "../api";
import { DraftField, FieldEditor, GroupedFields, createCategoryField } from "../components/Fields";
import { moneyInput, parseMoney, parseQty } from "../format";
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
  const [notes, setNotes] = useState("");
  const [values, setValues] = useState<Record<string, any>>({});
  const [catFields, setCatFields] = useState<FieldDef[]>([]);
  const [itemFields, setItemFields] = useState<FieldDef[]>([]);
  const [newFields, setNewFields] = useState<{ key: string; def: FieldDef }[]>([]);
  const [photos, setPhotos] = useState<PhotoRef[]>([]);
  const [added, setAdded] = useState<PhotoRef[]>([]);
  const [removed, setRemoved] = useState<number[]>([]);
  const [fieldModal, setFieldModal] = useState(false);
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
    const sp = parseMoney(price);
    if (Number.isNaN(sp)) return setError("The selling price is not a valid amount");
    const rl = parseQty(String(reorder));
    if (Number.isNaN(rl)) return setError("Low stock warning must be a whole number");
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
        archive_photo_ids: removed,
      });
      toast(editing ? "Item saved" : `"${r.item.name}" added`);
      if (props.onSaved) props.onSaved(r);
      else go(`/item/${r.item.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const shownPhotos = [...photos.filter((p) => !removed.includes(p.id!)), ...added];

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
              <button
                type="button"
                className="btn btn-small"
                onClick={() => (p.id ? setRemoved((r) => [...r, p.id!]) : setAdded((a) => a.filter((x) => x !== p)))}
              >
                Remove
              </button>
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

        <div className="grid3">
          <Label text={tracking === "unique" ? "Its own number (chassis / serial)" : "Item code (optional)"} required={tracking === "unique"}>
            <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} data-testid="item-identifier" />
          </Label>
          <Label text="Usual selling price (optional)">
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="item-price" />
          </Label>
          {tracking === "quantity" && (
            <Label text="Warn me when stock is at or below (optional)">
              <input inputMode="numeric" value={reorder} onChange={(e) => setReorder(e.target.value)} />
            </Label>
          )}
        </div>

        <div className="section-head">
          <h2>Details</h2>
          <button type="button" className="btn" onClick={() => setFieldModal(true)} data-testid="add-field">
            + Add a field
          </button>
        </div>
        {allFields.length === 0 && <p className="muted">{categoryId ? "No fields yet. Press Add a field to record details like size, material or model year." : "Choose a category to see its fields."}</p>}
        <GroupedFields fields={allFields} values={values} keyOf={keyOf} onChange={(k, v) => setValues((x) => ({ ...x, [k]: v }))} />

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
