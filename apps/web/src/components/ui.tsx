import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Loader2, UserCheck, X } from "lucide-react";
import {
  REVIEW_STATUS_LABELS,
  TASK_STATUS_LABELS,
  type ClosureReview,
  type CommentStatus,
  type ReviewStatus,
  type TaskPriority,
  type TaskStatus,
  type UserSummary,
} from "@rev/shared";
import { cx } from "../lib";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-accent-600 text-white shadow-sm hover:bg-accent-700",
        variant === "secondary" && "border border-zinc-300 bg-white text-zinc-800 shadow-sm hover:bg-zinc-50",
        variant === "ghost" && "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
        variant === "danger" && "border border-red-200 bg-white text-red-600 hover:bg-red-50",
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

const fieldBase =
  "rounded-md border border-zinc-300 bg-white px-3 text-sm shadow-sm placeholder:text-zinc-400 focus:border-accent-500 focus:ring-2 focus:ring-accent-100 focus:outline-none disabled:bg-zinc-50 disabled:text-zinc-500";

/** Full width unless the caller sets its own width class. */
const field = (className?: string) => cx(fieldBase, !/(^|\s)w-/.test(className ?? "") && "w-full", className);

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={field(cx("h-9", className))} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={field(cx("py-2", className))} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={field(cx("h-9 pr-8", className))}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-zinc-700">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-lg border border-zinc-200 bg-white shadow-sm", className)}>{children}</div>;
}

export function Badge({ className, children, title }: { className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", className)}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin text-zinc-400", className)} />;
}

export function PageLoader() {
  return (
    <div className="flex h-full min-h-40 items-center justify-center">
      <Spinner />
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center">
      {icon && <div className="text-zinc-400">{icon}</div>}
      <div className="text-sm font-medium text-zinc-700">{title}</div>
      {children && <div className="max-w-md text-sm text-zinc-500">{children}</div>}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-900/40 p-4 pt-[10vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className={cx("w-full rounded-lg bg-white shadow-xl", wide ? "max-w-2xl" : "max-w-md")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="rounded p-1 text-zinc-500 hover:bg-zinc-100" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cx("markdown", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

const avatarColors = ["bg-rose-500", "bg-amber-500", "bg-emerald-500", "bg-sky-500", "bg-violet-500", "bg-pink-500", "bg-teal-500"];

export function Avatar({ user, size = "md" }: { user: Pick<UserSummary, "id" | "name" | "kind">; size?: "sm" | "md" }) {
  const dim = size === "sm" ? "size-5 text-[10px]" : "size-7 text-xs";
  if (user.kind === "agent") {
    return (
      <span className={cx("inline-flex shrink-0 items-center justify-center rounded-md bg-zinc-800 text-white", dim)} title={`${user.name} (agent)`}>
        <Bot className={size === "sm" ? "size-3" : "size-4"} />
      </span>
    );
  }
  const color = avatarColors[[...user.id].reduce((a, c) => a + c.charCodeAt(0), 0) % avatarColors.length];
  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", color, dim)} title={user.name}>
      {initials}
    </span>
  );
}

export function UserChip({ user, size = "sm" }: { user: UserSummary | null; size?: "sm" | "md" }) {
  if (!user) return <span className="text-sm text-zinc-400">Unassigned</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
      <Avatar user={user} size={size} />
      <span className="truncate">{user.name}</span>
      {user.kind === "agent" && <span className="rounded bg-zinc-100 px-1 text-[10px] font-medium text-zinc-500 uppercase">agent</span>}
    </span>
  );
}

const taskStatusStyle: Record<TaskStatus, string> = {
  todo: "bg-zinc-100 text-zinc-700",
  in_progress: "bg-amber-100 text-amber-800",
  in_review: "bg-violet-100 text-violet-800",
  done: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-zinc-100 text-zinc-400 line-through",
};

/**
 * Closed tasks show who reviewed the closure: a dashed violet "agent" badge when
 * only an agent has closed it, a check when a human closed or reviewed it.
 */
export function TaskStatusBadge({ status, closureReview, title }: { status: TaskStatus; closureReview?: ClosureReview | null; title?: string }) {
  if (closureReview === "agent") {
    return (
      <Badge className="border border-dashed border-violet-400 bg-violet-50 text-violet-700">
        <Bot className="size-3" aria-hidden />
        <span title={title ?? "Closed by an agent — not yet reviewed by a human"}>{TASK_STATUS_LABELS[status]} · agent</span>
      </Badge>
    );
  }
  return (
    <Badge className={taskStatusStyle[status]}>
      {closureReview === "human" && <UserCheck className="size-3" aria-label="Human reviewed" />}
      <span title={title}>{TASK_STATUS_LABELS[status]}</span>
    </Badge>
  );
}

/** Tooltip text describing a task's closure. */
export function closureTitle(closure: { review: ClosureReview; by: UserSummary; reviewedBy: UserSummary | null } | null) {
  if (!closure) return undefined;
  if (closure.review === "agent") return `Closed by ${closure.by.name} (agent) — not yet reviewed by a human`;
  return closure.reviewedBy && closure.reviewedBy.id !== closure.by.id
    ? `Closed by ${closure.by.name}, reviewed by ${closure.reviewedBy.name}`
    : `Closed by ${closure.by.name}`;
}

const reviewStatusStyle: Record<ReviewStatus, string> = {
  draft: "bg-zinc-100 text-zinc-600",
  open: "bg-sky-100 text-sky-800",
  changes_requested: "bg-orange-100 text-orange-800",
  approved: "bg-emerald-100 text-emerald-800",
  closed: "bg-zinc-100 text-zinc-500",
};

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  return <Badge className={reviewStatusStyle[status]}>{REVIEW_STATUS_LABELS[status]}</Badge>;
}

const commentStatusStyle: Record<CommentStatus, string> = {
  open: "bg-zinc-100 text-zinc-600",
  accepted: "bg-sky-100 text-sky-800",
  rejected: "bg-red-50 text-red-600",
  resolved: "bg-emerald-100 text-emerald-800",
};

export function CommentStatusBadge({ status }: { status: CommentStatus }) {
  return <Badge className={commentStatusStyle[status]}>{status}</Badge>;
}

const priorityStyle: Record<TaskPriority, string> = {
  none: "text-zinc-300",
  low: "text-zinc-500",
  medium: "text-amber-500",
  high: "text-orange-600",
  urgent: "text-red-600",
};

export function PriorityMark({ priority }: { priority: TaskPriority }) {
  if (priority === "none") return null;
  return (
    <span className={cx("text-xs font-semibold uppercase", priorityStyle[priority])} title={`Priority: ${priority}`}>
      {priority === "urgent" ? "!!!" : priority === "high" ? "!!" : priority === "medium" ? "!" : "low"}
    </span>
  );
}
