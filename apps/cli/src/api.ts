import { openAsBlob } from "node:fs";
import path from "node:path";
import {
  MEDIA_EXTENSIONS,
  type AgentRegistration,
  type Me,
  type ProjectInfo,
  type ReviewAssetInfo,
  type ReviewCommentInfo,
  type ReviewDetail,
  type ReviewStatus,
  type TaskDetail,
  type TaskInfo,
  type TaskStatus,
} from "@rev/shared";

export class RevApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Thin typed client for the Rev HTTP API, authenticated with an agent API token. */
export class RevApi {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  url(pathOrUrl: string) {
    return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
  }

  webUrl(kind: "tasks" | "reviews", projectKey: string, number: number) {
    return `${this.baseUrl}/p/${projectKey}/${kind}/${number}`;
  }

  private async send(method: string, pathname: string, body?: RequestInit["body"], headers: Record<string, string> = {}) {
    let res: Response;
    try {
      res = await fetch(this.url(pathname), {
        method,
        body,
        headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...headers },
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new RevApiError(0, "network", `Cannot reach Rev at ${this.baseUrl}: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
    }
    if (!res.ok) {
      let code = "http_error";
      let message = `${method} ${pathname} failed with HTTP ${res.status}`;
      try {
        const err = (await res.json()) as { error?: string; message?: string };
        code = err.error ?? code;
        if (err.message) message = err.message;
      } catch {
        // Non-JSON error body.
      }
      throw new RevApiError(res.status, code, message);
    }
    return res;
  }

  async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const res = await this.send(
      method,
      pathname,
      body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? {} : { "content-type": "application/json" },
    );
    return (await res.json()) as T;
  }

  /** Fetches an authenticated binary resource such as a comment snapshot. */
  async download(pathOrUrl: string) {
    const res = await this.send("GET", pathOrUrl);
    return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream" };
  }

  me() {
    return this.request<Me>("GET", "/api/auth/me");
  }

  /** Self-registration with an enrollment key; needs no API token. */
  static register(baseUrl: string, body: { key: string; name: string; description: string }) {
    return new RevApi(baseUrl, "").request<AgentRegistration>("POST", "/api/agents/register", body);
  }

  projects() {
    return this.request<ProjectInfo[]>("GET", "/api/projects");
  }

  myTasks(statuses?: TaskStatus[]) {
    const q = statuses?.length ? `?status=${statuses.join(",")}` : "";
    return this.request<TaskInfo[]>("GET", `/api/tasks${q}`);
  }

  task(ref: string) {
    return this.request<TaskDetail>("GET", `/api/tasks/${encodeURIComponent(ref)}`);
  }

  updateTaskStatus(ref: string, status: TaskStatus) {
    return this.request<TaskDetail>("PATCH", `/api/tasks/${encodeURIComponent(ref)}`, { status });
  }

  commentOnTask(ref: string, body: string) {
    return this.request<TaskDetail>("POST", `/api/tasks/${encodeURIComponent(ref)}/comments`, { body });
  }

  createReview(projectKey: string, input: { title: string; description?: string; taskRef?: string; publish?: boolean }) {
    return this.request<ReviewDetail>("POST", `/api/projects/${encodeURIComponent(projectKey)}/reviews`, input);
  }

  review(ref: string) {
    return this.request<ReviewDetail>("GET", `/api/reviews/${encodeURIComponent(ref)}`);
  }

  updateReviewStatus(ref: string, status: ReviewStatus) {
    return this.request<ReviewDetail>("PATCH", `/api/reviews/${encodeURIComponent(ref)}`, { status });
  }

  commentOnReview(ref: string, input: { body: string; parentId?: string; assetId?: string }) {
    return this.request<ReviewCommentInfo>("POST", `/api/reviews/${encodeURIComponent(ref)}/comments`, input);
  }

  /** Streams a file from disk as a multipart upload. */
  async uploadAsset(reviewRef: string, filePath: string, caption?: string) {
    const type = MEDIA_EXTENSIONS[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const blob = await openAsBlob(filePath, { type });
    const form = new FormData();
    form.append("file", blob, path.basename(filePath));
    const q = caption ? `?caption=${encodeURIComponent(caption)}` : "";
    const res = await this.send("POST", `/api/reviews/${encodeURIComponent(reviewRef)}/assets${q}`, form);
    return (await res.json()) as ReviewAssetInfo;
  }
}
