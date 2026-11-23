const WHEEL = (cx: number, cy: number, r: number) => (
  <g>
    <circle cx={cx} cy={cy} r={r} />
    <circle cx={cx} cy={cy} r={r + 5} strokeDasharray="6 5" />
    <circle cx={cx} cy={cy} r={r * 0.36} />
    {[0, 60, 120].map((a) => {
      const t = (a * Math.PI) / 180;
      const k = r * 0.36;
      return <line key={a} x1={cx + Math.cos(t) * k} y1={cy + Math.sin(t) * k} x2={cx - Math.cos(t) * k} y2={cy - Math.sin(t) * k} />;
    })}
  </g>
);

function Tractor(props: { x?: number; y?: number }) {
  const { x = 0, y = 0 } = props;
  return (
    <g transform={`translate(${x} ${y})`}>
      {WHEEL(170, 112, 38)}
      {WHEEL(54, 126, 22)}
      <path d="M24 104V84q0-8 8-8h96l8-14h16" />
      <path d="M24 92h16M24 100h16" />
      <path d="M128 76l6-56h62l6 56" />
      <path d="M134 34h62" />
      <path d="M120 98a52 52 0 0 1 100-6" />
      <path d="M78 76V44h8v32" />
      <path d="M76 44h12" />
      <path d="M78 112h54" />
      <path d="M32 104l12 6" />
    </g>
  );
}

export function TractorDrawing(props: { variant?: number; className?: string; testid?: string }) {
  const v = (props.variant ?? 0) % 3;
  return (
    <svg className={props.className} viewBox={v === 1 ? "0 0 400 170" : "0 0 260 170"} aria-hidden data-testid={props.testid}>
      <g fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
        {v === 0 && (
          <>
            <Tractor />
            <path d="M6 162h248M30 152h40M150 152h60" strokeWidth="3" />
          </>
        )}
        {v === 1 && (
          <>
            <Tractor />
            <path d="M220 104h28" />
            <path d="M248 60h140v54H248z" />
            <path d="M256 60v-8h124v8M280 60v54M318 60v54M356 60v54" />
            {WHEEL(296, 128, 18)}
            {WHEEL(346, 128, 18)}
            <path d="M6 162h390" strokeWidth="3" />
          </>
        )}
        {v === 2 && (
          <>
            <Tractor x={40} />
            <path d="M70 92l-30 10-12 26h34l12-18" />
            <path d="M28 128l-6 10h44" />
            <path d="M6 162h248M40 150c10-14 20-14 30 0M200 150c10-14 20-14 30 0" strokeWidth="3" />
          </>
        )}
      </g>
    </svg>
  );
}

export function ShowroomLogo(props: { size?: number; className?: string }) {
  const s = props.size ?? 64;
  return (
    <svg className={props.className} width={s} height={s} viewBox="0 0 256 256" role="img" aria-label="Tractor showroom logo" data-testid="showroom-logo">
      <defs>
        <linearGradient id="lg-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1f7a3a" />
          <stop offset="1" stopColor="#0f3d1e" />
        </linearGradient>
      </defs>
      <circle cx="128" cy="128" r="124" fill="url(#lg-bg)" />
      <circle cx="128" cy="128" r="110" fill="none" stroke="#f5c518" strokeWidth="6" />
      <circle cx="128" cy="128" r="100" fill="none" stroke="#f5c518" strokeWidth="2" strokeDasharray="4 6" />
      <g transform="translate(24 52) scale(0.8)" fill="none" stroke="#f5c518" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
        <Tractor />
      </g>
      <path d="M58 196h140M78 210h100" stroke="#f5c518" strokeWidth="6" strokeLinecap="round" />
      <g fill="#f5c518">
        <path d="M128 30l5 10 11 1-8 8 2 11-10-5-10 5 2-11-8-8 11-1z" />
      </g>
    </svg>
  );
}

export async function logoPngFile(size = 512): Promise<File> {
  const holder = document.createElement("div");
  holder.style.position = "fixed";
  holder.style.left = "-9999px";
  holder.setAttribute("data-testid", "showroom-logo-src");
  document.body.appendChild(holder);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(holder);
  root.render(<ShowroomLogo size={size} />);
  await new Promise((r) => setTimeout(r, 50));
  let svg = new XMLSerializer().serializeToString(holder.querySelector("svg")!);
  if (!svg.includes("xmlns=")) svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  root.unmount();
  holder.remove();
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  c.getContext("2d")!.drawImage(img, 0, 0, size, size);
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
  return new File([blob], "showroom-logo.png", { type: "image/png" });
}
