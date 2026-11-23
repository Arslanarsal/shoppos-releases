import { useMemo, useState } from "react";
import { call } from "../api";
import { DraftField, FieldEditor } from "../components/Fields";
import { kindName } from "../format";
import { Category, Empty, ErrorBox, FieldDef, Modal, go, useApp, useAsync } from "../ui";
import { NewCategory } from "./ItemEdit";

export default function CategoriesPage(props: { selected: string | null }) {
  const { toast } = useApp();
  const [showArchived, setShowArchived] = useState(false);
  const cats = useAsync(() => call<Category[]>("category_list", { include_archived: true }), []);
  const sel = props.selected ? Number(props.selected) : (cats.data?.find((c) => !c.archived)?.id ?? null);
  const fields = useAsync(() => (sel ? call<FieldDef[]>("field_list", { category_id: sel, include_archived: true }) : Promise.resolve([] as FieldDef[])), [sel]);
  const [newCat, setNewCat] = useState(false);
  const [rename, setRename] = useState<Category | null>(null);
  const [editField, setEditField] = useState<FieldDef | "new" | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const cat = cats.data?.find((c) => c.id === sel);

  const all = fields.data ?? [];
  const active = all.filter((f) => !f.archived);
  const archived = all.filter((f) => f.archived);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? active.filter((f) => f.name.toLowerCase().includes(s) || f.group_name.toLowerCase().includes(s)) : active;
  }, [active, q]);
  const groups = [...new Set(all.map((f) => f.group_name).filter(Boolean))];

  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    setError("");
    try {
      await fn();
      if (msg) toast(msg);
      cats.reload();
      fields.reload();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const move = (f: FieldDef, dir: -1 | 1) => {
    const ids = active.map((x) => x.id);
    const i = ids.indexOf(f.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    run(() => call("field_reorder", { ids: [...ids, ...archived.map((x) => x.id)] }));
  };

  const saveField = async (d: DraftField) => {
    if (editField === "new") {
      await call("field_create", { ...d, category_id: sel });
      toast(`Field "${d.name}" added`);
    } else if (editField) {
      await call("field_update", { id: editField.id, patch: d });
      toast("Field saved");
    }
    fields.reload();
    cats.reload();
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Categories & fields</h1>
        <button className="btn btn-primary" onClick={() => setNewCat(true)} data-testid="new-category">
          + New category
        </button>
      </div>
      <ErrorBox text={error} />
      <div className="split">
        <div className="card list">
          {cats.data?.filter((c) => showArchived || !c.archived).map((c) => (
            <button key={c.id} className={`list-row ${c.id === sel ? "on" : ""}`} onClick={() => go("/categories", { id: c.id })}>
              <strong>{c.name}</strong>
              {c.archived && <span className="tag">Archived</span>}
              <span className="muted small">
                {c.item_count} items · {c.field_count} fields
              </span>
            </button>
          ))}
          {cats.data?.length === 0 && <Empty>No categories yet</Empty>}
          <label className="check small">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
          </label>
        </div>
        {cat && (
          <div className="card stack grow">
            <div className="section-head">
              <h2>{cat.name}</h2>
              <div className="row">
                <button className="btn" onClick={() => setRename(cat)}>
                  Rename
                </button>
                <button className="btn" onClick={() => run(() => call("category_archive", { id: cat.id, archived: !cat.archived }), cat.archived ? "Category brought back" : "Category archived")}>
                  {cat.archived ? "Bring back" : "Archive"}
                </button>
                <button className="btn btn-primary" onClick={() => setEditField("new")} data-testid="cat-add-field">
                  + Add field
                </button>
              </div>
            </div>
            {active.length > 10 && <input className="search" placeholder={`Search ${active.length} fields...`} value={q} onChange={(e) => setQ(e.target.value)} />}
            {active.length === 0 && <Empty>No fields yet. Add fields like Size, Material or Model year.</Empty>}
            {shown.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Field</th>
                    <th>Type</th>
                    <th>Group</th>
                    <th>Shown</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 500).map((f) => (
                    <tr key={f.id}>
                      <td className="nowrap">
                        <button className="btn btn-ghost btn-small" onClick={() => move(f, -1)} aria-label="Move up" disabled={!!q}>
                          ↑
                        </button>
                        <button className="btn btn-ghost btn-small" onClick={() => move(f, 1)} aria-label="Move down" disabled={!!q}>
                          ↓
                        </button>
                      </td>
                      <td>
                        <strong>{f.name}</strong>
                        {f.required && <span className="tag">Required</span>}
                        {f.unit && <span className="muted"> ({f.unit})</span>}
                      </td>
                      <td>{kindName(f.kind)}</td>
                      <td>{f.group_name}</td>
                      <td className="small">
                        {[f.show_in_list && "lists", f.show_on_receipt && "receipts"].filter(Boolean).join(", ")}
                      </td>
                      <td className="nowrap">
                        <button className="btn btn-small" onClick={() => setEditField(f)}>
                          Change
                        </button>
                        <button className="btn btn-small btn-ghost" onClick={() => run(() => call("field_archive", { id: f.id, archived: true }), "Field archived. Saved values are kept.")}>
                          Archive
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {shown.length > 500 && <p className="muted">Showing 500 of {shown.length}. Use search to find a field.</p>}
            {archived.length > 0 && (
              <details>
                <summary>{archived.length} archived field(s)</summary>
                {archived.map((f) => (
                  <div key={f.id} className="row">
                    <span>{f.name}</span>
                    <button className="btn btn-small" onClick={() => run(() => call("field_archive", { id: f.id, archived: false }), "Field brought back")}>
                      Bring back
                    </button>
                  </div>
                ))}
              </details>
            )}
          </div>
        )}
      </div>
      {newCat && <NewCategory onClose={() => setNewCat(false)} onCreated={(c) => (cats.reload(), go("/categories", { id: c.id }))} />}
      {rename && <RenameCategory cat={rename} onClose={() => setRename(null)} onDone={() => cats.reload()} />}
      {editField && (
        <FieldEditor
          initial={editField === "new" ? undefined : editField}
          categoryName={cat?.name}
          groups={groups}
          onSave={saveField}
          onClose={() => setEditField(null)}
        />
      )}
    </div>
  );
}

function RenameCategory(props: { cat: Category; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(props.cat.name);
  const [error, setError] = useState("");
  const save = async () => {
    try {
      await call("category_rename", { id: props.cat.id, name });
      props.onDone();
      props.onClose();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <Modal
      title="Rename category"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      <ErrorBox text={error} />
    </Modal>
  );
}
