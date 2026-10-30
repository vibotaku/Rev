import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frameTimes, type ReviewCommentInfo, type ReviewDetail, type TaskDetail } from "@rev/shared";
import { Client, makeFixtures, startTestServer, type TestServer } from "./helpers";

let server: TestServer;
let fixtures: ReturnType<typeof makeFixtures>;
// alice: admin + project owner (review owner of her agent's reviews). bob: member. aliceBot / bobBot: their agents.
let alice: Client, bob: Client, aliceBot: Client, bobBot: Client;
let aliceBotId: string, bobBotId: string;
let assetId: string;

beforeAll(async () => {
  server = await startTestServer();
  fixtures = makeFixtures(server.dataDir);
  alice = new Client(server.app);
  bob = new Client(server.app);
  await alice.post("/api/setup", { token: "setup-secret", email: "alice@example.com", name: "Alice", password: "correct horse battery" });
  const invite = await alice.post("/api/invites", { email: "bob@example.com" });
  await bob.post(`/api/invites/${invite.json.url.split("/invite/")[1]}/accept`, { name: "Bob", password: "another long password" });
  const bobId = (await bob.get("/api/auth/me")).json.user.id;
  await alice.post("/api/projects", { key: "WEB", name: "Web" });
  await alice.post("/api/projects/WEB/members", { userId: bobId, role: "member" });
  aliceBotId = (await alice.post("/api/agents", { name: "alice-bot" })).json.id;
  aliceBot = new Client(server.app, { token: (await alice.post(`/api/agents/${aliceBotId}/tokens`, { name: "t" })).json.token });
  bobBotId = (await bob.post("/api/agents", { name: "bob-bot" })).json.id;
  bobBot = new Client(server.app, { token: (await bob.post(`/api/agents/${bobBotId}/tokens`, { name: "t" })).json.token });
  await alice.post("/api/projects/WEB/members", { userId: aliceBotId });
  await bob.post("/api/projects/WEB/members", { userId: bobBotId });

  await aliceBot.post("/api/projects/WEB/reviews", { title: "Checkout" });
  assetId = (await aliceBot.upload("/api/reviews/WEB-R1/assets", fixtures.png, "image/png")).json.id;
  await aliceBot.patch("/api/reviews/WEB-R1", { status: "open" });
});

afterAll(async () => {
  await server?.close();
});

const shapes = [
  { type: "pin", x: 0.1, y: 0.1, color: "#ff3b30" },
  { type: "arrow", x1: 0.2, y1: 0.2, x2: 0.3, y2: 0.3, color: "#ff3b30" },
  { type: "rect", x: 0.5, y: 0.5, w: 0.2, h: 0.1, color: "#0a84ff" },
];

describe("comments on individual marks", () => {
  let overall: ReviewCommentInfo & { marks: ReviewCommentInfo[] };

  it("creates an overall comment plus one decidable comment per noted mark", async () => {
    const res = await bob.post("/api/reviews/WEB-R1/comments", {
      body: "The summary panel needs work",
      assetId,
      annotation: { shapes },
      marks: [
        { index: 2, body: "Total is cut off" },
        { index: 0, body: "Wrong currency symbol" },
      ],
    });
    expect(res.status).toBe(200);
    overall = res.json;
    expect(overall).toMatchObject({ body: "The summary panel needs work", markOf: null, roundNumber: 1, status: "open" });
    expect(overall.annotation?.shapes).toHaveLength(3);
    expect(overall.marks.map((m) => [m.markIndex, m.body, m.annotation?.shapes[0]?.type, m.markOf])).toEqual([
      [1, "Wrong currency symbol", "pin", overall.id],
      [3, "Total is cut off", "rect", overall.id],
    ]);
  });

  it("validates mark notes", async () => {
    const base = { body: "x", assetId, annotation: { shapes } };
    expect((await bob.post("/api/reviews/WEB-R1/comments", { ...base, marks: [{ index: 3, body: "no such mark" }] })).json.message).toContain(
      "no mark #4",
    );
    expect(
      (await bob.post("/api/reviews/WEB-R1/comments", { ...base, marks: [{ index: 1, body: "a" }, { index: 1, body: "b" }] })).json.message,
    ).toContain("more than one note");
    expect((await bob.post("/api/reviews/WEB-R1/comments", { body: "x", marks: [{ index: 0, body: "a" }] })).status).toBe(400);
    expect(
      (await bob.post("/api/reviews/WEB-R1/comments", { body: "x", parentId: overall.id, marks: [{ index: 0, body: "a" }] })).status,
    ).toBe(400);
  });

  it("lets people reply to a mark and the owner decide each one separately", async () => {
    const [currency, total] = overall.marks;
    const reply = await aliceBot.post("/api/reviews/WEB-R1/comments", { body: "Using the locale now", parentId: currency!.id });
    expect(reply.json).toMatchObject({ parentId: currency!.id, markOf: null, roundNumber: 1 });

    expect((await aliceBot.patch(`/api/comments/${currency!.id}`, { status: "accepted" })).status).toBe(403);
    expect((await bob.patch(`/api/comments/${currency!.id}`, { status: "accepted" })).status).toBe(403);
    expect((await alice.patch(`/api/comments/${currency!.id}`, { status: "accepted" })).json.status).toBe("accepted");
    expect((await alice.patch(`/api/comments/${total!.id}`, { status: "rejected" })).json.status).toBe("rejected");

    const review = (await alice.get("/api/reviews/WEB-R1")).json as ReviewDetail;
    const byId = new Map(review.comments.map((c) => [c.id, c]));
    expect(byId.get(overall.id)!.status).toBe("open");
    expect(byId.get(currency!.id)!.status).toBe("accepted");
    expect(byId.get(total!.id)!.status).toBe("rejected");
    // Overall comment still needs a decision; the rejected/accepted marks don't.
    expect(review.openCommentCount).toBe(1);
  });

  it("turns a single mark into a task", async () => {
    const currency = overall.marks[0]!;
    const task = (await alice.post("/api/reviews/WEB-R1/tasks", { title: "Fix currency", commentIds: [currency.id], assigneeId: aliceBotId }))
      .json as TaskDetail;
    expect(task.ref).toBe("WEB-1");
    expect(task.description).toContain("mark #1: Wrong currency symbol");
    expect(task.sourceComments.map((c) => [c.markIndex, c.markOf])).toEqual([[1, overall.id]]);
    expect((await alice.post("/api/reviews/WEB-R1/tasks", { title: "dup", commentIds: [overall.marks[1]!.id] })).status).toBe(409);
    // The overall comment can't be deleted while one of its marks has a task.
    expect((await bob.del(`/api/comments/${overall.id}`)).status).toBe(409);
  });
});

describe("review rounds", () => {
  it("lets the agent working on the feedback start round 2 as a draft", async () => {
    await alice.patch("/api/reviews/WEB-R1", { status: "changes_requested" });
    expect((await bobBot.post("/api/reviews/WEB-R1/rounds", { notes: "x" })).status).toBe(403);
    expect((await bob.get("/api/reviews/WEB-R1")).json.can.addRound).toBe(false);
    expect((await aliceBot.get("/api/reviews/WEB-R1")).json.can.addRound).toBe(true);

    const res = await aliceBot.post("/api/reviews/WEB-R1/rounds", { notes: "Currency now follows the locale." });
    expect(res.status).toBe(200);
    const review = res.json as ReviewDetail;
    expect(review.rounds.map((r) => [r.number, !!r.submittedAt])).toEqual([
      [1, true],
      [2, false],
    ]);
    // Default: the open tasks from this review assigned to the agent.
    expect(review.rounds[1]!.addressedTasks.map((t) => t.ref)).toEqual(["WEB-1"]);
    expect(review.currentRound).toBe(1);
    expect((await aliceBot.post("/api/reviews/WEB-R1/rounds", {})).status).toBe(409);
  });

  it("keeps the draft round private until it is submitted", async () => {
    expect((await aliceBot.post("/api/reviews/WEB-R1/rounds/2/submit")).json.message).toContain("at least one");
    const upload = await aliceBot.upload("/api/reviews/WEB-R1/assets?round=2", fixtures.png, "image/png", "fixed.png");
    expect(upload.json).toMatchObject({ roundNumber: 2 });
    // Bob cannot see the draft round or its media yet.
    const forBob = (await bob.get("/api/reviews/WEB-R1")).json as ReviewDetail;
    expect(forBob.rounds.map((r) => r.number)).toEqual([1]);
    expect(forBob.assets.map((a) => a.id)).toEqual([assetId]);
    expect((await bob.get(`/api/media/assets/${upload.json.id}`)).status).toBe(404);
    expect((await bobBot.upload("/api/reviews/WEB-R1/assets?round=2", fixtures.png, "image/png")).status).toBe(404);
  });

  it("submits round 2: the review reopens and the addressed task moves to review", async () => {
    const submitted = (await aliceBot.post("/api/reviews/WEB-R1/rounds/2/submit")).json as ReviewDetail;
    expect(submitted).toMatchObject({ status: "open", currentRound: 2 });
    expect(submitted.rounds[1]!.submittedAt).toBeTruthy();
    expect((await aliceBot.post("/api/reviews/WEB-R1/rounds/2/submit")).status).toBe(409);
    expect((await aliceBot.post("/api/reviews/WEB-R1/rounds/1/submit")).status).toBe(400);

    const task = (await alice.get("/api/tasks/WEB-1")).json as TaskDetail;
    expect(task.status).toBe("in_review");
    expect(task.deliveries).toEqual([expect.objectContaining({ ref: "WEB-R1", round: 2 })]);
    expect(task.activity.find((a) => a.kind === "review")?.data).toMatchObject({ round: 2 });

    const forBob = (await bob.get("/api/reviews/WEB-R1")).json as ReviewDetail;
    expect(forBob.rounds.map((r) => r.number)).toEqual([1, 2]);
    expect(forBob.assets.map((a) => a.roundNumber)).toEqual([1, 2]);
  });

  it("files comments under the right round", async () => {
    const general = (await bob.post("/api/reviews/WEB-R1/comments", { body: "Looks better" })).json;
    expect(general.roundNumber).toBe(2);
    const onOld = (await bob.post("/api/reviews/WEB-R1/comments", { body: "Still wrong here", assetId })).json;
    expect(onOld.roundNumber).toBe(1);
    expect((await bob.post("/api/reviews/WEB-R1/comments", { body: "explicit", round: 1 })).json.roundNumber).toBe(1);
    expect((await bob.post("/api/reviews/WEB-R1/comments", { body: "nope", round: 9 })).status).toBe(400);
  });

  it("lets another agent address only its own task, and discard its draft round", async () => {
    const t = (await alice.post("/api/reviews/WEB-R1/tasks", { title: "Total cut off", assigneeId: bobBotId })).json;
    expect((await bobBot.get("/api/reviews/WEB-R1")).json.can.addRound).toBe(true);
    expect((await bobBot.post("/api/reviews/WEB-R1/rounds", { taskRefs: ["WEB-1"] })).status).toBe(403);
    const r3 = (await bobBot.post("/api/reviews/WEB-R1/rounds", {})).json as ReviewDetail;
    expect(r3.rounds.at(-1)).toMatchObject({ number: 3, addressedTasks: [expect.objectContaining({ ref: t.ref })] });
    await bobBot.upload("/api/reviews/WEB-R1/assets?round=3", fixtures.png, "image/png");
    // A draft round belongs to its author (and the human deciders), not to whoever created the review.
    expect((await aliceBot.del("/api/reviews/WEB-R1/rounds/3")).status).toBe(403);
    expect((await aliceBot.upload("/api/reviews/WEB-R1/assets?round=3", fixtures.png, "image/png")).status).toBe(403);
    const after = (await bobBot.del("/api/reviews/WEB-R1/rounds/3")).json as ReviewDetail;
    expect(after.rounds.map((r) => r.number)).toEqual([1, 2]);
  });
});

describe("context for video comments", () => {
  let videoId: string;
  let overall: ReviewCommentInfo & { marks: ReviewCommentInfo[] };

  it("spans a second either side of the moment, shifted to stay inside the video", () => {
    expect(frameTimes(5000, 60000)).toEqual({ timesMs: [4000, 4250, 4500, 4750, 5000, 5250, 5500, 5750, 6000], markedIndex: 4 });
    expect(frameTimes(0, 60000)).toEqual({ timesMs: [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000], markedIndex: 0 });
    expect(frameTimes(59990, 60000)).toMatchObject({ markedIndex: 8, timesMs: expect.arrayContaining([57960, 59960]) });
    // Short clips get closer frames rather than fewer.
    const short = frameTimes(1000, 2000);
    expect(short.timesMs).toHaveLength(9);
    expect(short.timesMs[short.markedIndex]).toBe(1000);
    expect(Math.max(...short.timesMs)).toBeLessThanOrEqual(1960);
  });

  it("attaches frames around the moment to a video comment and its marks", async () => {
    await aliceBot.post("/api/projects/WEB/reviews", { title: "Combo animation" });
    videoId = (await aliceBot.upload("/api/reviews/WEB-R2/assets", fixtures.mp4, "video/mp4")).json.id;
    await server.ctx.processor.idle();
    await aliceBot.patch("/api/reviews/WEB-R2", { status: "open" });
    overall = (
      await alice.post("/api/reviews/WEB-R2/comments", {
        body: "Second punch looks wrong",
        assetId: videoId,
        timestampMs: 1000,
        annotation: { shapes: shapes.slice(0, 2) },
        marks: [
          { index: 0, body: "Fist clips the shoulder" },
          { index: 1, body: "Hit spark is late" },
        ],
      })
    ).json;
    expect(overall.frames).toMatchObject({ url: `/api/media/frames/${overall.id}`, markedIndex: 4 });
    expect(overall.frames!.timesMs[4]).toBe(1000);
    expect(overall.marks.map((m) => m.frames?.url)).toEqual([overall.frames!.url, overall.frames!.url]);

    const res = await bob.get(overall.frames!.url);
    expect(res.status).toBe(200);
    expect(res.res.headers["content-type"]).toBe("image/jpeg");
    // A 3×3 grid of frames up to 480×360 each, in the video's shape (4:3 here), cached next to the video.
    const sheet = path.join(server.dataDir, "media", "assets", videoId, "frames-1000.jpg");
    const dims = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", sheet], { encoding: "utf8" });
    expect(dims.trim()).toBe("1428,1080");
    expect((await aliceBot.get(overall.marks[1]!.frames!.url)).status).toBe(200);
  });

  it("gives image comments and text-only comments no frames", async () => {
    const image = (await bob.post("/api/reviews/WEB-R1/comments", { body: "Image", assetId, annotation: { shapes } })).json;
    expect(image.frames).toBeNull();
    expect((await bob.get(`/api/media/frames/${image.id}`)).status).toBe(404);
    const general = (await bob.post("/api/reviews/WEB-R2/comments", { body: "General" })).json;
    expect(general.frames).toBeNull();
  });

  it("sends the mark notes along when the overall comment becomes a task", async () => {
    await alice.patch(`/api/comments/${overall.marks[1]!.id}`, { status: "rejected" });
    const task = (await alice.post("/api/reviews/WEB-R2/tasks", { title: "Fix the punch", commentIds: [overall.id], assigneeId: aliceBotId }))
      .json as TaskDetail;
    expect(task.sourceComments.map((c) => c.id)).toEqual([overall.id]);
    expect(task.sourceMarks.map((m) => [m.markOf, m.markIndex, m.body, m.status])).toEqual([
      [overall.id, 1, "Fist clips the shoulder", "open"],
      [overall.id, 2, "Hit spark is late", "rejected"],
    ]);
    const shown = (await aliceBot.get(`/api/tasks/${task.ref}`)).json as TaskDetail;
    expect(shown.sourceMarks).toHaveLength(2);
    expect(shown.sourceComments[0]!.frames?.timesMs).toHaveLength(9);
  });
});
