import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewDetail, TaskDetail } from "@rev/shared";
import { Client, makeFixtures, startTestServer, type TestServer } from "./helpers";

let server: TestServer;
let fixtures: ReturnType<typeof makeFixtures>;

// Cast of characters:
//   alice  - admin, owns project WEB, linked to agent "alice-bot"
//   bob    - invited member of WEB, linked to agent "bob-bot"
//   carol  - invited, not a member of WEB
let alice: Client, bob: Client, carol: Client, aliceBot: Client, bobBot: Client, anon: Client;
let aliceBotId: string, bobBotId: string, bobId: string;

beforeAll(async () => {
  server = await startTestServer();
  fixtures = makeFixtures(server.dataDir);
  anon = new Client(server.app);
  alice = new Client(server.app);
  bob = new Client(server.app);
  carol = new Client(server.app);
});

afterAll(async () => {
  await server?.close();
});

describe("Rev end-to-end flow", () => {
  it("bootstraps the first admin with the setup token only", async () => {
    expect((await anon.get("/api/setup/status")).json).toEqual({ needsSetup: true });
    const body = { email: "alice@example.com", name: "Alice", password: "correct horse battery" };
    expect((await anon.post("/api/setup", { ...body, token: "nope" })).status).toBe(403);
    const ok = await alice.post("/api/setup", { ...body, token: "setup-secret" });
    expect(ok.status).toBe(200);
    expect(ok.json.user.role).toBe("admin");
    expect((await anon.post("/api/setup", { ...body, token: "setup-secret" })).status).toBe(409);
    expect((await anon.get("/api/setup/status")).json).toEqual({ needsSetup: false });
  });

  it("invites users who then set their own password", async () => {
    for (const [client, email, name] of [
      [bob, "bob@example.com", "Bob"],
      [carol, "carol@example.com", "Carol"],
    ] as const) {
      const invite = await alice.post("/api/invites", { email });
      expect(invite.status).toBe(200);
      const token = invite.json.url.split("/invite/")[1];
      expect((await anon.get(`/api/invites/${token}`)).json.email).toBe(email);
      const accepted = await client.post(`/api/invites/${token}/accept`, { name, password: "another long password" });
      expect(accepted.status).toBe(200);
      expect((await anon.post(`/api/invites/${token}/accept`, { name, password: "another long password" })).status).toBe(404);
    }
    bobId = (await bob.get("/api/auth/me")).json.user.id;
    expect((await bob.post("/api/invites", { email: "x@example.com" })).status).toBe(403);
    expect((await anon.post("/api/auth/login", { email: "bob@example.com", password: "wrong password!" })).status).toBe(401);
    const login = new Client(server.app);
    expect((await login.post("/api/auth/login", { email: "BOB@example.com", password: "another long password" })).status).toBe(200);
  });

  it("links agents to their humans and issues API tokens", async () => {
    const a = await alice.post("/api/agents", { name: "alice-bot", description: "Claude Code on build box" });
    aliceBotId = a.json.id;
    const at = await alice.post(`/api/agents/${aliceBotId}/tokens`, { name: "laptop" });
    expect(at.json.token).toMatch(/^rev_/);
    aliceBot = new Client(server.app, { token: at.json.token });

    const b = await bob.post("/api/agents", { name: "bob-bot" });
    bobBotId = b.json.id;
    bobBot = new Client(server.app, { token: (await bob.post(`/api/agents/${bobBotId}/tokens`, { name: "ci" })).json.token });

    expect((await bob.post(`/api/agents/${aliceBotId}/tokens`, { name: "steal" })).status).toBe(403);
    const me = await aliceBot.get("/api/auth/me");
    expect(me.json.user).toMatchObject({ kind: "agent", ownerId: a.json.owner.id });
    expect(me.json.viaToken).toBe(true);
    expect((await aliceBot.post("/api/projects", { key: "BOT", name: "Bot project" })).status).toBe(403);
  });

  it("manages project membership", async () => {
    const p = await alice.post("/api/projects", { key: "web", name: "Website" });
    expect(p.json).toMatchObject({ key: "WEB", myRole: "owner" });
    expect((await alice.post("/api/projects", { key: "WEB", name: "Dup" })).status).toBe(409);

    expect((await alice.post("/api/projects/WEB/members", { userId: bobId, role: "member" })).status).toBe(200);
    expect((await alice.post("/api/projects/WEB/members", { userId: aliceBotId, role: "member" })).status).toBe(200);
    expect((await alice.post("/api/projects/WEB/members", { userId: aliceBotId, role: "owner" })).status).toBe(400);
    // Members can link their own agents but nobody else's.
    expect((await bob.post("/api/projects/WEB/members", { userId: bobBotId, role: "member" })).status).toBe(200);
    const carolId = (await carol.get("/api/auth/me")).json.user.id;
    expect((await bob.post("/api/projects/WEB/members", { userId: carolId })).status).toBe(403);

    expect((await carol.get("/api/projects/WEB")).status).toBe(404);
    expect((await bob.get("/api/projects")).json.map((x: any) => x.key)).toEqual(["WEB"]);
    expect((await alice.get("/api/projects/WEB/members")).json).toHaveLength(4);
  });

  let review: ReviewDetail;
  let videoAssetId: string;

  it("lets an agent build and publish a review kit", async () => {
    const created = await aliceBot.post("/api/projects/WEB/reviews", {
      title: "New onboarding flow",
      description: "Recorded with Playwright.",
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ ref: "WEB-R1", status: "draft", owner: { name: "Alice" } });
    review = created.json;

    // Drafts are private to the people involved.
    expect((await bob.get("/api/reviews/WEB-R1")).status).toBe(404);
    expect((await bob.get("/api/projects/WEB/reviews")).json).toHaveLength(0);

    const img = await aliceBot.upload("/api/reviews/WEB-R1/assets?caption=Home", fixtures.png, "image/png");
    expect(img.status).toBe(200);
    expect(img.json).toMatchObject({ kind: "image", caption: "Home", status: "processing" });
    const vid = await aliceBot.upload("/api/reviews/WEB-R1/assets", fixtures.mp4, "application/octet-stream");
    expect(vid.json.kind).toBe("video");
    videoAssetId = vid.json.id;
    const mov = await aliceBot.upload("/api/reviews/WEB-R1/assets", fixtures.mov, "video/quicktime");
    expect(mov.status).toBe(200);

    const txt = path.join(server.dataDir, "notes.txt");
    writeFileSync(txt, "hello");
    expect((await aliceBot.upload("/api/reviews/WEB-R1/assets", txt, "text/plain")).status).toBe(400);
    expect((await bobBot.upload("/api/reviews/WEB-R1/assets", fixtures.png, "image/png")).status).toBe(404);

    await server.ctx.processor.idle();
    const published = await aliceBot.patch("/api/reviews/WEB-R1", { status: "open" });
    expect(published.status).toBe(200);
    review = published.json;
    expect(review.status).toBe("open");
    const [image, video, quicktime] = review.assets;
    expect(image).toMatchObject({ status: "ready", width: 320, height: 240 });
    expect(image!.posterUrl).toBeTruthy();
    expect(video).toMatchObject({ status: "ready", width: 320, height: 240, mime: "video/mp4" });
    expect(video!.durationMs).toBeGreaterThan(1500);
    // mpeg4-in-mov is not browser playable, so it was transcoded to H.264 MP4.
    expect(quicktime).toMatchObject({ status: "ready", mime: "video/mp4" });

    // The agent cannot approve its own work.
    expect((await aliceBot.patch("/api/reviews/WEB-R1", { status: "approved" })).status).toBe(403);
  });

  it("serves media only to people who can see the review, with range support", async () => {
    const url = `/api/media/assets/${videoAssetId}`;
    expect((await anon.get(url)).status).toBe(401);
    expect((await carol.get(url)).status).toBe(404);
    const ranged = await bob.get(url, { range: "bytes=0-99" });
    expect(ranged.status).toBe(206);
    expect(ranged.res.headers["content-range"]).toMatch(/^bytes 0-99\//);
    expect((await aliceBot.get(`${url}?download=1`)).res.headers["content-disposition"]).toContain("clip.mp4");
  });

  let commentId: string;

  it("collects annotated comments and lets only the review owner decide", async () => {
    const c = await bob.post("/api/reviews/WEB-R1/comments", {
      body: "The CTA overlaps the footer here",
      assetId: videoAssetId,
      timestampMs: 1200,
      annotation: { shapes: [{ type: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.1, color: "#ff3b30" }] },
    });
    expect(c.status).toBe(200);
    commentId = c.json.id;
    const snap = await bob.upload(`/api/comments/${commentId}/snapshot`, fixtures.png, "image/png", "snap.png");
    expect(snap.status).toBe(200);

    const reply = await aliceBot.post("/api/reviews/WEB-R1/comments", { body: "Will fix", parentId: commentId });
    expect(reply.status).toBe(200);
    expect(reply.json.assetId).toBe(videoAssetId);

    const bad = await bob.post("/api/reviews/WEB-R1/comments", {
      body: "x",
      annotation: { shapes: [{ type: "pin", x: 2, y: 0, color: "#ff3b30" }] },
    });
    expect(bad.status).toBe(400);

    expect((await aliceBot.patch(`/api/comments/${commentId}`, { status: "accepted" })).status).toBe(403);
    expect((await bob.patch(`/api/comments/${commentId}`, { status: "accepted" })).status).toBe(403);
    const accepted = await alice.patch(`/api/comments/${commentId}`, { status: "accepted" });
    expect(accepted.json).toMatchObject({ status: "accepted", decidedBy: { name: "Alice" } });
  });

  let taskRef: string;

  it("turns accepted comments into tasks assigned to the linked agent", async () => {
    // Bob is not the review owner.
    expect((await bob.post("/api/reviews/WEB-R1/tasks", { title: "x", commentIds: [commentId] })).status).toBe(403);
    expect((await aliceBot.post("/api/reviews/WEB-R1/tasks", { title: "x", commentIds: [commentId] })).status).toBe(403);

    const t = await alice.post("/api/reviews/WEB-R1/tasks", {
      title: "Fix CTA overlap",
      commentIds: [commentId],
      assigneeId: aliceBotId,
      priority: "high",
    });
    expect(t.status).toBe(200);
    const task: TaskDetail = t.json;
    taskRef = task.ref;
    expect(task).toMatchObject({ ref: "WEB-1", assignee: { id: aliceBotId }, sourceReview: { ref: "WEB-R1" } });
    expect(task.description).toContain("clip.mp4 @ 0:01.2");
    expect(task.sourceComments[0]).toMatchObject({ id: commentId, status: "accepted", timestampMs: 1200 });
    expect(task.sourceComments[0]!.snapshotUrl).toBeTruthy();

    // The same comment cannot spawn two tasks.
    expect((await alice.post("/api/reviews/WEB-R1/tasks", { title: "dup", commentIds: [commentId] })).status).toBe(409);
    expect((await alice.get("/api/reviews/WEB-R1")).json.tasks).toHaveLength(1);
  });

  it("only lets an agent's linked human (or a project owner) assign it work", async () => {
    expect((await bob.post("/api/projects/WEB/tasks", { title: "x", assigneeId: aliceBotId })).status).toBe(403);
    const own = await bob.post("/api/projects/WEB/tasks", { title: "Bob's bot task", assigneeId: bobBotId });
    expect(own.status).toBe(200);
    expect((await alice.post("/api/projects/WEB/tasks", { title: "Owner may", assigneeId: bobBotId })).status).toBe(200);
    expect((await bob.patch(`/api/tasks/${own.json.ref}`, { assigneeId: aliceBotId })).status).toBe(403);
    expect((await aliceBot.post("/api/projects/WEB/tasks", { title: "agent task" })).status).toBe(403);
  });

  it("lets the agent pull its work, deliver a review and finish the task", async () => {
    const mine = await aliceBot.get("/api/tasks");
    expect(mine.json.map((t: any) => t.ref)).toEqual([taskRef]);
    const detail = await aliceBot.get(`/api/tasks/${taskRef}`);
    expect(detail.json.sourceComments[0].annotation.shapes[0].type).toBe("rect");
    expect((await aliceBot.get(detail.json.sourceComments[0].snapshotUrl)).status).toBe(200);

    expect((await aliceBot.patch(`/api/tasks/${taskRef}`, { title: "renamed" })).status).toBe(403);
    expect((await bobBot.patch(`/api/tasks/${taskRef}`, { status: "in_progress" })).status).toBe(403);
    expect((await aliceBot.patch(`/api/tasks/${taskRef}`, { status: "in_progress" })).json.status).toBe("in_progress");
    expect((await aliceBot.post(`/api/tasks/${taskRef}/comments`, { body: "Working on it" })).status).toBe(200);

    // Bob's agent cannot submit a review for a task that is not its own.
    expect((await bobBot.post("/api/projects/WEB/reviews", { title: "x", taskRef })).status).toBe(403);
    const delivery = await aliceBot.post("/api/projects/WEB/reviews", { title: "CTA fixed", taskRef, publish: true });
    expect(delivery.json).toMatchObject({ ref: "WEB-R2", status: "open", task: { ref: taskRef } });
    const afterDelivery = (await alice.get(`/api/tasks/${taskRef}`)).json as TaskDetail;
    expect(afterDelivery.status).toBe("in_review");
    expect(afterDelivery.deliveries.map((d) => d.ref)).toEqual(["WEB-R2"]);

    await alice.patch("/api/reviews/WEB-R2", { status: "approved" });
    const done = (await alice.patch(`/api/tasks/${taskRef}`, { status: "done" })).json as TaskDetail;
    // A human closing the task is its human review.
    expect(done.closure).toMatchObject({ review: "human", by: { name: "Alice" }, reviewedBy: { name: "Alice" } });
    expect(done.can.reviewClosure).toBe(false);
    expect(done.sourceComments[0]!.status).toBe("resolved");
    expect(done.activity.map((a) => a.kind)).toEqual(["created", "status", "comment", "review", "status", "status"]);

    const dash = (await alice.get("/api/dashboard")).json;
    expect(dash.reviewsToDecide.map((r: any) => r.ref)).toEqual(["WEB-R1"]);
  });

  it("keeps agent closures distinct until a human reviews them", async () => {
    // Feedback on the delivery becomes a new task for the agent, which closes it itself.
    const comment = await bob.post("/api/reviews/WEB-R2/comments", { body: "Tiny copy fix" });
    const created = await alice.post("/api/reviews/WEB-R2/tasks", {
      title: "Copy fix",
      commentIds: [comment.json.id],
      assigneeId: aliceBotId,
    });
    const ref = created.json.ref;
    const closed = (await aliceBot.patch(`/api/tasks/${ref}`, { status: "done" })).json as TaskDetail;
    expect(closed.closure).toMatchObject({ review: "agent", by: { id: aliceBotId, kind: "agent" }, reviewedBy: null });
    expect(closed.sourceComments[0]).toMatchObject({ status: "resolved", task: { ref, closureReview: "agent" } });

    const review = (await alice.get("/api/reviews/WEB-R2")).json as ReviewDetail;
    expect(review.tasks.find((t) => t.ref === ref)?.closureReview).toBe("agent");
    expect((await alice.get("/api/dashboard")).json.agentClosuresToReview.map((t: any) => t.ref)).toEqual([ref]);
    expect((await bob.get("/api/dashboard")).json.agentClosuresToReview).toEqual([]);

    // Only humans can review a closure, once.
    expect((await alice.get(`/api/tasks/${ref}`)).json.can.reviewClosure).toBe(true);
    expect((await aliceBot.post(`/api/tasks/${ref}/review-closure`, {})).status).toBe(403);
    const reviewed = (await alice.post(`/api/tasks/${ref}/review-closure`, { body: "Checked on staging" })).json as TaskDetail;
    expect(reviewed.closure).toMatchObject({ review: "human", by: { id: aliceBotId }, reviewedBy: { name: "Alice" } });
    expect(reviewed.activity.at(-1)).toMatchObject({ kind: "closure_reviewed", body: "Checked on staging" });
    expect((await alice.post(`/api/tasks/${ref}/review-closure`, {})).status).toBe(409);
    expect((await alice.get("/api/dashboard")).json.agentClosuresToReview).toEqual([]);

    // Reopening clears the closure; closing again starts a fresh, unreviewed one.
    expect(((await aliceBot.patch(`/api/tasks/${ref}`, { status: "in_progress" })).json as TaskDetail).closure).toBeNull();
    const cancelled = (await aliceBot.patch(`/api/tasks/${ref}`, { status: "cancelled" })).json as TaskDetail;
    expect(cancelled.closure).toMatchObject({ review: "agent", reviewedBy: null });
    expect(cancelled.activity.filter((a) => a.kind === "status").at(-1)?.data).toMatchObject({ to: "cancelled", byKind: "agent" });
    expect((await alice.post(`/api/tasks/${ref}/review-closure`, {})).status).toBe(200);
  });

  it("rejects cross-origin cookie requests", async () => {
    const r = await alice.post("/api/projects", { key: "EVIL", name: "Evil" }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    const same = await alice.post("/api/projects", { key: "OK", name: "Fine" }, { origin: "http://localhost:80" });
    expect(same.status).toBe(200);
  });

  it("cuts off agents when their token is revoked or their human is disabled", async () => {
    expect((await bobBot.get("/api/tasks")).status).toBe(200);
    expect((await alice.patch(`/api/users/${bobId}`, { disabled: true })).status).toBe(200);
    expect((await bobBot.get("/api/tasks")).status).toBe(401);
    expect((await bob.get("/api/auth/me")).status).toBe(401);
    await alice.patch(`/api/users/${bobId}`, { disabled: false });
    expect((await bobBot.get("/api/tasks")).status).toBe(200);

    const agents = (await alice.get("/api/agents")).json;
    const tokenId = agents[0].tokens[0].id;
    await alice.del(`/api/agents/${aliceBotId}/tokens/${tokenId}`);
    expect((await aliceBot.get("/api/tasks")).status).toBe(401);
  });
});
