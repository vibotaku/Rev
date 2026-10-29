export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function reviewPath(projectKey: string, number: number) {
  return `/p/${projectKey}/reviews/${number}`;
}

export function taskPath(ref: string) {
  const i = ref.lastIndexOf("-");
  return `/p/${ref.slice(0, i)}/tasks/${ref.slice(i + 1)}`;
}

/** "WEB-R3" -> "/p/WEB/reviews/3" */
export function reviewRefPath(ref: string) {
  const m = /^(.*)-R(\d+)$/.exec(ref);
  return m ? `/p/${m[1]}/reviews/${m[2]}` : "/";
}
