# Rev

Task management and visual review for teams of humans and coding agents.

Agents submit **review kits** (screen recordings and screenshots) with one CLI command or MCP tool call. Humans scrub through the videos, draw on frames, and comment. The review's human owner accepts the feedback that matters, turns it into tasks, and assigns them back to the agent linked to them. The agent pulls those tasks along with the annotated frames and delivers the next review kit.

```
agent ──rev review create──▶ review kit ──humans annotate & comment──▶ owner accepts comments
  ▲                                                                          │
  └────────── rev tasks / MCP get_task (with annotated snapshots) ◀── task assigned to linked agent
```

## Features

- **Projects and tasks.** Board and list views, priorities, assignees, activity, and markdown comments. References look like `WEB-12`.
- **Review kits.** Videos and images in one review (`WEB-R3`). Uploads are probed with ffmpeg, get posters, and are transcoded to H.264 when browsers can't play them (`.mov`, `.mkv`, HEVC).
- **Annotation.** Pins, boxes, arrows, and freehand drawing on any video frame or image, numbered on the frame. Each mark can carry its own note next to the overall comment; the owner accepts or rejects every comment and mark note separately. Comments carry timestamps and appear as timeline markers. While scrubbing, a video comment's marks show only within 1.25 s of its time (faded off its exact frame), each tagged with that time; click the tag to jump to the frame. Frame stepping, playback speed, and keyboard shortcuts are built in.
- **Review rounds.** When the accepted feedback has been addressed, the agent submits round 2 (3, …) of the same review: new media, notes on what changed, and the tasks it addresses, which move to in review. The review page switches between rounds, and comments belong to the round they were made on.
- **Snapshots for agents.** Each annotated comment stores a rendered JPEG of the exact frame with the marks drawn on it. A comment on a video also gets a frame sheet: 9 frames from 1 s before to 1 s after, so agents can judge motion and timing. Reviewers see both images on the comment. `rev task show` and the MCP `get_task` tool hand them to the agent, together with the exact time and every mark note.
- **Review → task hand-off.** The owner selects comments and creates one task from them. The comments are marked accepted, and the task is assigned to the agent that submitted the review by default. When the task is done, its comments become resolved.
- **Human-reviewed vs agent-closed.** Agents may close their own tasks. Every closure records who closed it and whether a human has reviewed it. Agent closures show with a dashed violet "agent" badge on the board, in lists, and on reviews, until a human marks them reviewed (or closes the task themselves). Your dashboard lists what your agents closed, and the history stays in the task's activity log.
- **Auth and privileges.** Email/password accounts (invite-only) and optional **Active Directory** sign-in over LDAPS, restricted to an AD group, with accounts created on first sign-in and periodic re-checks that cut off people who leave, along with their agents. Scoped agent API tokens, and global and per-project roles. See [Permissions](#permissions) and [docs/active-directory.md](docs/active-directory.md).
- **Agent self-registration.** A human creates an **enrollment key** with default projects, a use limit, and an expiry. Agents holding it register themselves, become linked to that human, and get their own token. Keys can be revoked; you can optionally disable every agent enrolled with a key at the same time.
- **Agent tooling.** A Claude Code plugin (`/rev:setup`, a `/rev:workflow` skill, and MCP tools) plus a single-file `rev` CLI. The CLI is served by your Rev instance at `/downloads/rev.mjs` and also runs as an MCP server (`rev mcp`).
- **Easy to self-host.** One `docker compose up -d` brings up Rev, Postgres, and ffmpeg. See the [Proxmox guide](docs/deploy-proxmox.md).

## Quick start (Proxmox / any Debian host)

```bash
git clone https://github.com/VibOtaku/rev.git /opt/rev && cd /opt/rev
sudo PUBLIC_URL=http://rev.lan:8080 ./deploy/install.sh
```

The script installs Docker if it is missing, writes `.env` with a random database password, builds and starts the stack, and prints the **setup token**. Open `PUBLIC_URL/setup` to create the first admin. Full walkthrough (LXC settings, storage for media, HTTPS, backups, upgrades): **[docs/deploy-proxmox.md](docs/deploy-proxmox.md)**.

## Connecting an agent

1. In Rev, go to **My agents → New enrollment key**. Choose the projects new agents join, then copy the key; it is shown once.
2. **Claude Code:** install the plugin and let Claude register itself:

   ```text
   /plugin marketplace add vibotaku/Rev
   /plugin install rev@vibotaku
   /rev:setup https://rev.example.com rev_enroll_…
   ```

   **Any other agent, CI job, or script** (Node.js 20 or later):

   ```bash
   mkdir -p ~/.local/bin && curl -fsSL https://rev.example.com/downloads/rev.mjs -o ~/.local/bin/rev && chmod +x ~/.local/bin/rev
   REV_ENROLL_KEY=rev_enroll_… rev register --url https://rev.example.com --name build-01
   rev mcp      # stdio MCP server for any MCP client
   ```

You can still create an agent by hand (**New agent (manual)**) and use `rev login --url … --token …`. See **[docs/agents.md](docs/agents.md)** for setup details, every CLI command, and the MCP tools.

## Concepts

| Thing | Notes |
| --- | --- |
| **User** | A human (email + password) or an **agent** (API tokens only). Each agent is *linked* to the human who created it and acts on their behalf. |
| **Project** | Has a short key (`WEB`) and members with a project role. |
| **Task** | `WEB-12`. Statuses: `todo → in_progress → in_review → done` (or `cancelled`). A closed task is either **human-reviewed** (a human closed it or reviewed the closure) or **agent-closed** (only an agent has looked at it). Reopening clears the closure; the activity log keeps the history. |
| **Review** | `WEB-R3`. A kit of media plus a description, optionally delivering a task. Statuses: `draft → open → changes_requested / approved → closed`. |
| **Review owner** | The human who decides on a review. When an agent submits one, the owner is the agent's linked human. |
| **Comment** | On a review, optionally on a media item, at a timestamp, with an annotation. Statuses: `open → accepted / rejected → resolved`. |

## Permissions

Global roles: **admin** (manages people, acts as owner of every project) and **member**. Project roles: **owner**, **member**, **viewer**.

| Action | Who |
| --- | --- |
| Invite people, reset passwords, disable accounts | Admins |
| Create projects | Any human |
| Create enrollment keys | Any human, for projects where they are an owner or member. Agents registered with a key are linked to its creator. |
| Add or remove project members, change roles, archive | Project owners. Members may add or remove *their own* agents. |
| Create and edit tasks | Human owners and members |
| Assign a task to a human | Human owners and members (assignee must be a non-viewer member) |
| Assign a task to an **agent** | The agent's **linked human**, or a project owner or admin |
| Change a task's status | Human owners and members, and an agent on **its own** tasks (including closing them as `done` or `cancelled`) |
| Mark an agent's closure as human-reviewed | Human owners and members |
| Create review kits, upload media | Owners and members, humans or agents. Agents can only link reviews to tasks assigned to them. |
| Comment, reply, annotate | Owners and members |
| Accept or reject comments, approve or request changes, **create tasks from a review** | The review **owner**, or a project owner (humans only) |
| See draft reviews | The submitter, the review owner, and project owners |
| Download media and snapshots | Anyone who can see the review |

Disabling a person immediately disables every agent linked to them. Revoking a token takes effect on the next request.

## Development

Requirements: Node.js 22+ (24 recommended) and ffmpeg (optional; used for posters and transcoding).

```bash
npm install
npm run dev          # API on :8080 (embedded PGlite in ./data), web UI on http://localhost:5173
npm run typecheck
npm test             # server + CLI integration tests (PGlite; ffmpeg required for media tests)
TEST_DATABASE_URL=postgres://… npx vitest run   # in apps/server: run the server suite on real Postgres
npm run build        # web → apps/web/dist, CLI → apps/cli/dist/rev.mjs, server → apps/server/dist
```

The server prints a setup token on first start. In development you can pin it with `REV_SETUP_TOKEN=dev npm run dev`.

After changing `apps/server/src/db/schema.ts`, run `npm run db:generate` and commit the new migration in `apps/server/drizzle/`. Migrations run automatically at startup.

### Layout

```
packages/shared   zod request schemas, DTO types, enums shared by every app
apps/server       Fastify API, auth, permissions (src/lib/access.ts), media processing, Drizzle schema + migrations
apps/web          React + Vite + Tailwind UI (review workspace in src/review/)
apps/cli          `rev` CLI and MCP server, bundled into one file (copied into plugins/rev/cli on build)
plugins/rev       Claude Code plugin (marketplace manifest in .claude-plugin/ at the repo root)
deploy/           install / backup / restore scripts, Caddyfile, container entrypoint
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | *(empty)* | Postgres URL. When empty, an embedded PGlite database in `DATA_DIR` is used (development only). |
| `DATA_DIR` | `./data` | Media, temp files, and PGlite data |
| `PUBLIC_URL` | request origin | Base URL for invite links and agent instructions |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `MAX_UPLOAD_MB` | `2048` | Largest single upload |
| `SESSION_TTL_DAYS` | `30` | Browser session lifetime (sliding) |
| `COOKIE_SECURE` | on when `PUBLIC_URL` is https | Secure session cookie |
| `TRUST_PROXY` | `true` | Honour `X-Forwarded-*` from a reverse proxy |
| `REV_SETUP_TOKEN` | random | Fix the first-run setup token |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Media tools |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `10` | Sign-in attempts per IP per minute |
| `LDAP_*` | *(unset)* | Imported once into **Admin → Active Directory**, which is the source of truth afterwards; see [docs/active-directory.md](docs/active-directory.md) |
| `REV_SECRET_KEY` | key file in `DATA_DIR` | Encrypts secrets stored in the database (e.g. the AD bind password) |

## License

[MIT](LICENSE)
