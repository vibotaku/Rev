import { Film, MessageSquare } from "lucide-react";
import { Link } from "react-router";
import type { ReviewInfo, TaskInfo } from "@rev/shared";
import { reviewPath, taskPath, timeAgo } from "../lib";
import { closureTitle, PriorityMark, ReviewStatusBadge, TaskStatusBadge, UserChip } from "./ui";

export function TaskRow({ task, showProject }: { task: TaskInfo; showProject?: boolean }) {
  return (
    <Link to={taskPath(task.ref)} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-zinc-50">
      <span className="w-16 shrink-0 font-mono text-xs text-zinc-500">{task.ref}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
      {showProject && task.sourceReview && <span className="hidden text-xs text-zinc-400 md:inline">from {task.sourceReview.ref}</span>}
      <PriorityMark priority={task.priority} />
      <TaskStatusBadge status={task.status} closureReview={task.closure?.review} title={closureTitle(task.closure)} />
      <span className="hidden w-44 shrink-0 overflow-hidden md:flex">
        <UserChip user={task.assignee} />
      </span>
    </Link>
  );
}

export function ReviewCard({ review }: { review: ReviewInfo }) {
  return (
    <Link
      to={reviewPath(review.projectKey, review.number)}
      className="group flex overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm transition hover:border-zinc-300 hover:shadow"
    >
      <div className="flex w-36 shrink-0 items-center justify-center bg-zinc-900">
        {review.thumbnailUrl ? (
          <img src={review.thumbnailUrl} alt="" className="h-full max-h-24 w-full object-cover" />
        ) : (
          <Film className="size-6 text-zinc-600" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5 p-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-zinc-500">{review.ref}</span>
          <ReviewStatusBadge status={review.status} />
          {review.task && <span className="truncate text-xs text-zinc-500">for {review.task.ref}</span>}
        </div>
        <div className="truncate text-sm font-medium group-hover:text-accent-700">{review.title}</div>
        <div className="flex items-center gap-3 text-xs whitespace-nowrap text-zinc-500">
          <span className="min-w-0 overflow-hidden">
            <UserChip user={review.createdBy} />
          </span>
          <span>{review.assetCount} media</span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3" />
            {review.openCommentCount} open
          </span>
          <span className="ml-auto">{timeAgo(review.updatedAt)}</span>
        </div>
      </div>
    </Link>
  );
}
