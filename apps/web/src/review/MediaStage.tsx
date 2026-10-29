import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Pause, Play, StepBack, StepForward, Volume2, VolumeX } from "lucide-react";
import { formatTimestamp, type ReviewAssetInfo, type Shape } from "@rev/shared";
import { Spinner } from "../components/ui";
import { cx } from "../lib";
import { shapeFromDrag, ShapesSvg, type Tool } from "./shapes";

export interface Marker {
  id: string;
  timestampMs: number;
  status: string;
  selected: boolean;
}

const FRAME = 1 / 30;

export function MediaStage({
  asset,
  tool,
  color,
  draft,
  onDraftChange,
  overlay,
  markers,
  onMarkerClick,
  mediaRef,
  onTime,
}: {
  asset: ReviewAssetInfo;
  tool: Tool;
  color: string;
  draft: Shape[];
  onDraftChange: (shapes: Shape[]) => void;
  overlay: Shape[] | null;
  markers: Marker[];
  onMarkerClick: (id: string) => void;
  mediaRef: React.RefObject<HTMLVideoElement | HTMLImageElement | null>;
  onTime: (seconds: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: asset.width ?? 0, h: asset.height ?? 0 });
  const [gesture, setGesture] = useState<{ start: [number, number]; end: [number, number]; points: [number, number][] } | null>(null);

  useEffect(() => setNatural({ w: asset.width ?? 0, h: asset.height ?? 0 }), [asset.id, asset.width, asset.height]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setBox({ w: entry!.contentRect.width, h: entry!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nw = natural.w || 16;
  const nh = natural.h || 9;
  const scale = Math.min(box.w / nw, box.h / nh) || 0;
  const dw = Math.floor(nw * scale);
  const dh = Math.floor(nh * scale);

  function point(e: ReactPointerEvent): [number, number] {
    const r = svgRef.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  }

  function onPointerDown(e: ReactPointerEvent) {
    if (tool === "none") return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const media = mediaRef.current;
    if (media instanceof HTMLVideoElement && !media.paused) media.pause();
    const p = point(e);
    if (tool === "pin") {
      const s = shapeFromDrag("pin", color, p, p, []);
      if (s) onDraftChange([...draft, s]);
      return;
    }
    setGesture({ start: p, end: p, points: [p] });
  }

  function onPointerMove(e: ReactPointerEvent) {
    if (!gesture) return;
    const p = point(e);
    const last = gesture.points[gesture.points.length - 1]!;
    const points = tool === "pen" && Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.003 ? [...gesture.points, p] : gesture.points;
    setGesture({ ...gesture, end: p, points });
  }

  function onPointerUp() {
    if (!gesture) return;
    const s = shapeFromDrag(tool, color, gesture.start, gesture.end, gesture.points);
    setGesture(null);
    if (s) onDraftChange([...draft, s]);
  }

  const preview = gesture ? shapeFromDrag(tool, color, gesture.start, gesture.end, gesture.points) : null;
  const processingVideo = asset.kind === "video" && asset.status === "processing";

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden">
        {asset.status === "failed" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-400">
            <span>Could not process this file.</span>
            <span className="max-w-md text-center text-xs text-zinc-500">{asset.error}</span>
            <a className="text-xs text-zinc-300 underline" href={`${asset.url}?download=1`}>
              Download original
            </a>
          </div>
        ) : processingVideo ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-zinc-400">
            <Spinner /> Processing video…
          </div>
        ) : (
          <div className="absolute" style={{ width: dw, height: dh, left: (box.w - dw) / 2, top: (box.h - dh) / 2 }}>
            {asset.kind === "video" ? (
              <video
                key={asset.id}
                ref={mediaRef as React.RefObject<HTMLVideoElement>}
                src={asset.url}
                poster={asset.posterUrl ?? undefined}
                className="size-full"
                preload="auto"
                playsInline
                onLoadedMetadata={(e) => setNatural({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
                onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)}
                onSeeked={(e) => onTime(e.currentTarget.currentTime)}
                onClick={(e) => (e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause())}
              />
            ) : (
              <img
                key={asset.id}
                ref={mediaRef as React.RefObject<HTMLImageElement>}
                src={asset.url}
                alt={asset.filename}
                className="size-full select-none"
                draggable={false}
                onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              />
            )}
            <svg
              ref={svgRef}
              data-annotation-layer
              aria-label="Annotation layer"
              viewBox={`0 0 ${nw} ${nh}`}
              className={cx("absolute inset-0 size-full touch-none", tool === "none" ? "pointer-events-none" : "cursor-crosshair")}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setGesture(null)}
            >
              {overlay && <ShapesSvg shapes={overlay} w={nw} h={nh} numbered />}
              <ShapesSvg shapes={preview ? [...draft, preview] : draft} w={nw} h={nh} numbered />
            </svg>
          </div>
        )}
      </div>
      {asset.kind === "video" && !processingVideo && asset.status !== "failed" && (
        <VideoControls key={asset.id} mediaRef={mediaRef} markers={markers} onMarkerClick={onMarkerClick} durationHint={asset.durationMs} />
      )}
    </div>
  );
}

function VideoControls({
  mediaRef,
  markers,
  onMarkerClick,
  durationHint,
}: {
  mediaRef: React.RefObject<HTMLVideoElement | HTMLImageElement | null>;
  markers: Marker[];
  onMarkerClick: (id: string) => void;
  durationHint: number | null;
}) {
  const [state, setState] = useState({ t: 0, d: (durationHint ?? 0) / 1000, playing: false, muted: false, rate: 1 });

  useEffect(() => {
    const v = mediaRef.current;
    if (!(v instanceof HTMLVideoElement)) return;
    const sync = () =>
      setState({ t: v.currentTime, d: Number.isFinite(v.duration) ? v.duration : (durationHint ?? 0) / 1000, playing: !v.paused, muted: v.muted, rate: v.playbackRate });
    const events = ["timeupdate", "play", "pause", "loadedmetadata", "durationchange", "volumechange", "ratechange", "seeked"];
    events.forEach((ev) => v.addEventListener(ev, sync));
    sync();
    // timeupdate fires ~4x/s; poll faster while playing for a smooth scrubber.
    const id = setInterval(() => !v.paused && sync(), 100);
    return () => {
      events.forEach((ev) => v.removeEventListener(ev, sync));
      clearInterval(id);
    };
  }, [mediaRef, durationHint]);

  const video = () => mediaRef.current as HTMLVideoElement | null;
  const d = state.d || 1;

  return (
    <div className="space-y-1.5 border-t border-zinc-800 bg-zinc-900 px-4 pt-2 pb-2.5 text-zinc-300">
      <div className="relative h-5">
        <input
          type="range"
          min={0}
          max={d}
          step={0.001}
          value={Math.min(state.t, d)}
          onChange={(e) => {
            const v = video();
            if (v) v.currentTime = Number(e.target.value);
          }}
          className="absolute inset-x-0 top-1.5 h-2 w-full cursor-pointer accent-indigo-500"
          aria-label="Seek"
        />
        {markers.map((m) => (
          <button
            key={m.id}
            title={`Comment @ ${formatTimestamp(m.timestampMs)}`}
            onClick={() => onMarkerClick(m.id)}
            className={cx(
              "absolute -top-0.5 size-2.5 -translate-x-1/2 rounded-full border border-zinc-900",
              m.selected ? "z-10 scale-150 bg-white" : m.status === "open" ? "bg-amber-400" : m.status === "rejected" ? "bg-zinc-500" : "bg-sky-400",
            )}
            style={{ left: `${Math.min(100, (m.timestampMs / 1000 / d) * 100)}%` }}
          />
        ))}
      </div>
      <div className="flex items-center gap-1 text-xs">
        <button className="rounded p-1.5 hover:bg-zinc-800" onClick={() => video()?.[state.playing ? "pause" : "play"]()} title="Play/pause (space)">
          {state.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <button
          className="rounded p-1.5 hover:bg-zinc-800"
          title="Previous frame (←)"
          onClick={() => {
            const v = video();
            if (v) {
              v.pause();
              v.currentTime = Math.max(0, v.currentTime - FRAME);
            }
          }}
        >
          <StepBack className="size-4" />
        </button>
        <button
          className="rounded p-1.5 hover:bg-zinc-800"
          title="Next frame (→)"
          onClick={() => {
            const v = video();
            if (v) {
              v.pause();
              v.currentTime = Math.min(v.duration || 0, v.currentTime + FRAME);
            }
          }}
        >
          <StepForward className="size-4" />
        </button>
        <span className="ml-1 font-mono tabular-nums">
          {formatTimestamp(state.t * 1000)} / {formatTimestamp(state.d * 1000)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <select
            className="rounded bg-zinc-800 px-1.5 py-1 text-xs"
            value={state.rate}
            onChange={(e) => {
              const v = video();
              if (v) v.playbackRate = Number(e.target.value);
            }}
            title="Playback speed"
          >
            {[0.25, 0.5, 1, 1.5, 2].map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
          <button
            className="rounded p-1.5 hover:bg-zinc-800"
            onClick={() => {
              const v = video();
              if (v) v.muted = !v.muted;
            }}
            title="Mute"
          >
            {state.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
