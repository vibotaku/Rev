// Annotation shapes are stored normalised (0..1). These helpers draw them in
// the media's natural pixel space, both as SVG (on screen) and onto a canvas
// (the snapshot image agents receive).
import type { Shape } from "@rev/shared";

export type Tool = "none" | "pin" | "rect" | "arrow" | "pen";
export const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff"];

const strokeFor = (w: number, h: number) => Math.max(2, Math.min(w, h) / 160);

function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const a1 = angle + Math.PI * 0.85;
  const a2 = angle - Math.PI * 0.85;
  return [
    [x2, y2],
    [x2 + size * Math.cos(a1), y2 + size * Math.sin(a1)],
    [x2 + size * Math.cos(a2), y2 + size * Math.sin(a2)],
  ] as const;
}

/** Where a shape's number badge goes: on a pin itself, otherwise at the shape's start. */
function anchorOf(s: Shape, w: number, h: number): [number, number] {
  switch (s.type) {
    case "pin":
      return [s.x * w, s.y * h];
    case "rect":
      return [s.x * w, s.y * h];
    case "arrow":
      return [s.x1 * w, s.y1 * h];
    case "pen":
      return [s.points[0]![0] * w, s.points[0]![1] * h];
  }
}

/** Dark text on light colours (yellow, white), white text otherwise. */
function labelInk(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 160 ? "#111" : "#fff";
}

/**
 * `labels[i]` is the number drawn on shape i (null = no number); `highlight`
 * dims every other shape, e.g. while a single mark's comment is selected.
 */
export function ShapesSvg({
  shapes,
  w,
  h,
  faded,
  labels,
  highlight,
}: {
  shapes: Shape[];
  w: number;
  h: number;
  faded?: boolean;
  labels?: (number | null)[];
  highlight?: number | null;
}) {
  const sw = strokeFor(w, h);
  return (
    <g opacity={faded ? 0.55 : 1} style={{ filter: "drop-shadow(0 0 1px rgba(0,0,0,.8))" }}>
      {shapes.map((s, i) => {
        const dim = highlight != null && highlight !== i ? 0.3 : 1;
        const label = labels?.[i];
        const [ax, ay] = anchorOf(s, w, h);
        let body: React.ReactNode;
        switch (s.type) {
          case "rect":
            body = <rect x={s.x * w} y={s.y * h} width={s.w * w} height={s.h * h} fill="none" stroke={s.color} strokeWidth={sw} rx={sw} />;
            break;
          case "arrow": {
            const [p1, p2, p3] = arrowHead(s.x1 * w, s.y1 * h, s.x2 * w, s.y2 * h, sw * 5);
            body = (
              <>
                <line x1={s.x1 * w} y1={s.y1 * h} x2={s.x2 * w} y2={s.y2 * h} stroke={s.color} strokeWidth={sw} strokeLinecap="round" />
                <polygon points={`${p1.join(",")} ${p2.join(",")} ${p3.join(",")}`} fill={s.color} />
              </>
            );
            break;
          }
          case "pen":
            body = (
              <polyline
                points={s.points.map(([x, y]) => `${x * w},${y * h}`).join(" ")}
                fill="none"
                stroke={s.color}
                strokeWidth={sw}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
            break;
          case "pin":
            body = <circle cx={ax} cy={ay} r={sw * 4} fill={s.color} stroke="#000" strokeOpacity={0.4} strokeWidth={sw / 2} />;
            break;
        }
        return (
          <g key={i} opacity={dim}>
            {body}
            {label != null && (
              <g>
                {s.type !== "pin" && <circle cx={ax} cy={ay} r={sw * 3.4} fill={s.color} stroke="#000" strokeOpacity={0.4} strokeWidth={sw / 2} />}
                <text x={ax} y={ay} fontSize={sw * 4} fontWeight={700} textAnchor="middle" dominantBaseline="central" fill={labelInk(s.color)}>
                  {label}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}

export function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[], w: number, h: number, labels?: (number | null)[]) {
  const sw = strokeFor(w, h);
  ctx.lineWidth = sw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(0,0,0,.8)";
  ctx.shadowBlur = 2;
  shapes.forEach((s, i) => {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    switch (s.type) {
      case "rect":
        ctx.strokeRect(s.x * w, s.y * h, s.w * w, s.h * h);
        break;
      case "arrow": {
        ctx.moveTo(s.x1 * w, s.y1 * h);
        ctx.lineTo(s.x2 * w, s.y2 * h);
        ctx.stroke();
        const [p1, p2, p3] = arrowHead(s.x1 * w, s.y1 * h, s.x2 * w, s.y2 * h, sw * 5);
        ctx.beginPath();
        ctx.moveTo(...p1);
        ctx.lineTo(...p2);
        ctx.lineTo(...p3);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "pen":
        s.points.forEach(([x, y], j) => (j ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
        ctx.stroke();
        break;
      case "pin":
        ctx.arc(s.x * w, s.y * h, sw * 4, 0, Math.PI * 2);
        ctx.fill();
        break;
    }
    const label = labels?.[i];
    if (label == null) return;
    const [ax, ay] = anchorOf(s, w, h);
    if (s.type !== "pin") {
      ctx.beginPath();
      ctx.arc(ax, ay, sw * 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = labelInk(s.color);
    ctx.font = `700 ${sw * 4}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(label), ax, ay);
    ctx.restore();
  });
}

/** Renders the current frame (or image) plus shapes to a JPEG, capped at 1920px wide. */
export async function renderSnapshot(
  el: HTMLVideoElement | HTMLImageElement,
  shapes: Shape[],
  labels?: (number | null)[],
): Promise<Blob | null> {
  const nw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
  const nh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
  if (!nw || !nh) return null;
  const scale = Math.min(1, 1920 / nw);
  const w = Math.round(nw * scale);
  const h = Math.round(nh * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(el, 0, 0, w, h);
  drawShapes(ctx, shapes, w, h, labels);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.88));
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(clamp(v) * 10000) / 10000;

/** Builds a shape from a drag gesture; returns null for accidental clicks. */
export function shapeFromDrag(tool: Tool, color: string, start: [number, number], end: [number, number], points: [number, number][]): Shape | null {
  const [x1, y1] = start;
  const [x2, y2] = end;
  switch (tool) {
    case "pin":
      return { type: "pin", x: round(x1), y: round(y1), color };
    case "rect": {
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      if (w < 0.005 && h < 0.005) return null;
      return { type: "rect", x: round(Math.min(x1, x2)), y: round(Math.min(y1, y2)), w: round(w), h: round(h), color };
    }
    case "arrow":
      if (Math.hypot(x2 - x1, y2 - y1) < 0.01) return null;
      return { type: "arrow", x1: round(x1), y1: round(y1), x2: round(x2), y2: round(y2), color };
    case "pen":
      if (points.length < 2) return null;
      return { type: "pen", points: points.slice(0, 2000).map(([x, y]) => [round(x), round(y)] as [number, number]), color };
    default:
      return null;
  }
}
