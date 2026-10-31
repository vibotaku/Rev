import { useState } from "react";
import { Copy } from "lucide-react";
import { cx } from "../lib";

/** `wrap` wraps long lines (prose prompts) instead of scrolling (commands). */
export function CopyBlock({ text, wrap }: { text: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <pre className={cx("rounded-md bg-zinc-900 p-3 pr-10 text-xs leading-relaxed text-zinc-100", wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto")}>
        {text}
      </pre>
      <button
        className="absolute top-2 right-2 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        title="Copy"
      >
        {copied ? <span className="text-[10px]">copied</span> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
