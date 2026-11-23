import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../api";

export type ViewPhoto = { url: string; name?: string };

export function showPhotos(photos: ViewPhoto[], index = 0) {
  window.dispatchEvent(new CustomEvent("shoppos-photos", { detail: { photos, index } }));
}

async function setFull(on: boolean) {
  if (isTauri) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(on);
      return;
    } catch {
      /* fall back to the browser */
    }
  }
  try {
    if (on) await document.documentElement.requestFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* not available */
  }
}

export function PhotoHost() {
  const [state, setState] = useState<{ photos: ViewPhoto[]; index: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setState((e as CustomEvent).detail);
    window.addEventListener("shoppos-photos", on);
    return () => window.removeEventListener("shoppos-photos", on);
  }, []);
  if (!state) return null;
  return <PhotoViewer photos={state.photos} start={state.index} onClose={() => setState(null)} />;
}

const MIN = 1;
const MAX = 10;

function PhotoViewer(props: { photos: ViewPhoto[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(props.start);
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 });
  const [full, setFullState] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; s: number } | null>(null);
  const n = props.photos.length;
  const p = props.photos[i];

  const close = useCallback(() => {
    if (full) setFull(false);
    props.onClose();
  }, [full, props]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    setZ((cur) => {
      const s = Math.min(MAX, Math.max(MIN, cur.s * factor));
      if (s === MIN) return { s: 1, x: 0, y: 0 };
      const r = stage.current?.getBoundingClientRect();
      const ox = cx !== undefined && r ? cx - (r.left + r.width / 2) : 0;
      const oy = cy !== undefined && r ? cy - (r.top + r.height / 2) : 0;
      const k = s / cur.s;
      return { s, x: ox - (ox - cur.x) * k, y: oy - (oy - cur.y) * k };
    });
  }, []);

  const go = useCallback(
    (d: number) => {
      if (n < 2) return;
      setI((x) => (x + d + n) % n);
      setZ({ s: 1, x: 0, y: 0 });
    },
    [n],
  );

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "+" || e.key === "=") zoomAt(1.4);
      else if (e.key === "-") zoomAt(1 / 1.4);
      else if (e.key === "0") setZ({ s: 1, x: 0, y: 0 });
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [close, go, zoomAt]);

  const toggleFull = async () => {
    await setFull(!full);
    setFullState(!full);
  };

  return (
    <div className="pv" role="dialog" aria-label="Photo" data-testid="photo-viewer">
      <div className="pv-bar">
        <span className="pv-name">
          {p.name || "Photo"} {n > 1 && <span className="pv-count">{`${i + 1} / ${n}`}</span>}
        </span>
        <div className="pv-tools">
          <button onClick={() => zoomAt(1 / 1.4)} aria-label="Zoom out" data-testid="pv-out">
            −
          </button>
          <span className="pv-pct" data-testid="pv-zoom">
            {Math.round(z.s * 100)}%
          </span>
          <button onClick={() => zoomAt(1.4)} aria-label="Zoom in" data-testid="pv-in">
            +
          </button>
          <button onClick={() => setZ({ s: 1, x: 0, y: 0 })} data-testid="pv-fit">
            Fit
          </button>
          <button onClick={toggleFull} data-testid="pv-full">
            {full ? "Exit full screen" : "Full screen"}
          </button>
          <button onClick={close} aria-label="Close" data-testid="pv-close">
            ✕
          </button>
        </div>
      </div>
      <div
        ref={stage}
        className={`pv-stage ${z.s > 1 ? "pv-zoomed" : ""}`}
        onWheel={(e) => zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY)}
        onDoubleClick={(e) => (z.s > 1 ? setZ({ s: 1, x: 0, y: 0 }) : zoomAt(3, e.clientX, e.clientY))}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), s: z.s };
            drag.current = null;
          } else {
            drag.current = { px: e.clientX, py: e.clientY, x: z.x, y: z.y };
          }
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pinch.current && pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            const target = Math.min(MAX, Math.max(MIN, (pinch.current.s * d) / pinch.current.d));
            zoomAt(target / z.s, (a.x + b.x) / 2, (a.y + b.y) / 2);
          } else if (drag.current && z.s > 1) {
            const d = drag.current;
            setZ((c) => ({ ...c, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
          }
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          if (pointers.current.size === 0) drag.current = null;
        }}
        onClick={(e) => e.target === e.currentTarget && z.s === 1 && close()}
      >
        <img
          src={p.url}
          alt={p.name ?? ""}
          draggable={false}
          style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})` }}
          data-testid="pv-img"
        />
        {n > 1 && (
          <>
            <button className="pv-nav pv-prev" onClick={() => go(-1)} aria-label="Previous photo">
              ‹
            </button>
            <button className="pv-nav pv-next" onClick={() => go(1)} aria-label="Next photo" data-testid="pv-next">
              ›
            </button>
          </>
        )}
      </div>
      <div className="pv-help">Mouse wheel or + − to zoom where you point · drag to move · double click to zoom in · ← → next photo · Esc to close</div>
    </div>
  );
}
