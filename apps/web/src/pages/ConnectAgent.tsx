import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus } from "lucide-react";
import { Link } from "react-router";
import { PageHeader } from "../components/Layout";
import { Button, Card, Input } from "../components/ui";
import { CopyBlock } from "../components/CopyBlock";
import { cx } from "../lib";
import { CreateKey } from "./EnrollmentKeys";

/**
 * Where the enrollment key comes from: a literal key, an OpenBao/Vault KV reference
 * (`bao:<path>#<field>`, mount `secret`, as /rev:setup takes it), or not given yet.
 */
type KeySource = { kind: "literal"; key: string } | { kind: "bao"; ref: string; path: string; field: string } | { kind: "none" };

function keySource(input: string): KeySource {
  const v = input.trim();
  const bao = /^bao:([^#\s]+)#(\S+)$/.exec(v);
  if (bao) return { kind: "bao", ref: v, path: bao[1]!.replace(/^secret\//, ""), field: bao[2]! };
  return v ? { kind: "literal", key: v } : { kind: "none" };
}

const PLACEHOLDER = "<enrollment key>";
const installCli = (origin: string) =>
  `mkdir -p ~/.local/bin && curl -fsSL ${origin}/downloads/rev.mjs -o ~/.local/bin/rev && chmod +x ~/.local/bin/rev`;

function registerCommand(origin: string, src: KeySource, rev: string, name: string) {
  const args = `--url ${origin} --name ${name}`;
  if (src.kind === "bao") return `bao kv get -mount=secret -field=${src.field} ${src.path} | ${rev} register ${args} --key -`;
  return `REV_ENROLL_KEY=${src.kind === "literal" ? src.key : PLACEHOLDER} ${rev} register ${args}`;
}

/** A prompt for Claude Code: it installs the plugin and the CLI, registers and checks the connection. */
export function claudePrompt(origin: string, src: KeySource) {
  const rev = "~/.local/bin/rev";
  const key =
    src.kind === "literal"
      ? src.key
      : src.kind === "bao"
        ? `in OpenBao (mount "secret", path "${src.path}", field "${src.field}"). Pipe it straight into the register command so it never shows in output; use \`vault\` instead of \`bao\` if only the Vault CLI is installed.`
        : "ask me for it.";
  return [
    "Connect this machine to Rev, our task and visual-review tracker, as an agent account.",
    "",
    `- Rev: ${origin}`,
    `- Enrollment key: ${key}`,
    "- Agent name: choose one like claude-<host>-<repo>; it must be unique among my agents.",
    "",
    "The enrollment key is a secret: never print it, echo it or write it to a file.",
    "",
    "1. Install the Rev plugin for Claude Code (Rev's MCP tools and the rev:workflow skill):",
    "   claude plugin marketplace add vibotaku/Rev",
    "   claude plugin install rev@vibotaku",
    "   If the marketplace was already added, also run `claude plugin marketplace update vibotaku` to get the latest version.",
    "2. Install the rev CLI (needs Node.js 20 or newer):",
    `   ${installCli(origin)}`,
    "3. Register this machine:",
    `   ${registerCommand(origin, src, rev, "<agent name>")}`,
    "   If the name is taken, pick another. If this machine is already registered, stop and tell me.",
    "   If the key is revoked, expired or used up, ask me for a new one.",
    `4. Check the connection: \`${rev} whoami\`, \`${rev} projects\` and \`${rev} tasks\`.`,
    "5. Report the agent name, its linked human, the projects it joined and its open tasks.",
    "   Then remind me to run /reload-plugins so the Rev tools load in this session.",
  ].join("\n");
}

/** The same setup typed by hand in Claude Code. */
export function claudeCommands(origin: string, src: KeySource) {
  const key = src.kind === "literal" ? src.key : src.kind === "bao" ? src.ref : PLACEHOLDER;
  return ["/plugin marketplace add vibotaku/Rev", "/plugin install rev@vibotaku", `/rev:setup ${origin} ${key}`].join("\n");
}

/** Shell commands for any other agent, CI job or script. */
export function shellCommands(origin: string, src: KeySource) {
  return [
    "# Install the rev CLI (Node.js 20+); ~/.local/bin must be on your PATH",
    installCli(origin),
    "",
    "# Register this machine as an agent (the name must be unique among your agents)",
    registerCommand(origin, src, "rev", '"$(hostname -s)-agent"'),
    "rev whoami",
    "",
    "# Optional: Rev's MCP tools for any MCP client (stdio server)",
    "rev mcp",
  ].join("\n");
}

/** Working instructions for agents without the Claude Code plugin (AGENTS.md, system prompt, …). */
export function workingInstructions(origin: string) {
  return [
    "## Rev",
    "",
    `Tasks and visual reviews for this work live in Rev (${origin}). You act through an agent account (\`rev whoami\`) linked to a human, using the \`rev\` CLI.`,
    "",
    "1. Pull work: `rev tasks`, then `rev task show WEB-12 --save-snapshots ./rev-feedback`. A task made from review feedback lists each comment with its exact video time, its numbered marks (matching the saved snapshots) and their notes, and a 3×3 frame sheet around each video moment. Address every note; leave [rejected] ones alone.",
    '2. Start: `rev task start WEB-12`. Post questions or progress with `rev task comment WEB-12 "…"`.',
    "3. Deliver evidence a reviewer can check without running anything: screenshots and short screen recordings (MP4 or WebM, under about 60 s), saved outside the repo.",
    '   - The task came from a review ("From review: WEB-R3"): submit the next round of that review, `rev review round WEB-R3 -n "what changed, how to verify" --caption-each clip.mp4 after.png`.',
    '   - New work: `rev review create -p WEB -t "Short title" -d "What changed and how to verify" --task WEB-12 --caption-each clip.mp4 after.png`.',
    '4. Read feedback with `rev review show WEB-R3` and answer a comment with `rev review reply <comment id> "…"`.',
    '5. Close a task yourself only when the work is small and objectively verified: `rev task done WEB-12 --note "what you did and how you verified it"`. It shows as agent-closed until a human reviews it.',
    "",
    "Humans approve reviews, accept or reject comments, and create and assign tasks; you can't. Never print or store Rev tokens or enrollment keys.",
  ].join("\n");
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <h2 className="text-sm font-semibold text-zinc-800">{title}</h2>
        {children}
      </div>
    </section>
  );
}

/** Copyable instructions for connecting an agent, filled in with `enrollKey` (a key or a bao: reference). */
export function AgentInstructions({ enrollKey, start = 1 }: { enrollKey: string; start?: number }) {
  const [agent, setAgent] = useState<"claude" | "other">("claude");
  const origin = window.location.origin;
  const src = keySource(enrollKey);
  return (
    <div className="space-y-5">
      <Step n={start} title="Choose the agent">
        <div className="flex w-fit rounded-md border border-zinc-300 bg-white p-0.5 text-sm">
          {(["claude", "other"] as const).map((a) => (
            <button
              key={a}
              onClick={() => setAgent(a)}
              className={cx("rounded px-3 py-1 whitespace-nowrap", agent === a ? "bg-zinc-100 font-medium text-zinc-900" : "text-zinc-500")}
            >
              {a === "claude" ? "Claude Code" : "Other agents & scripts"}
            </button>
          ))}
        </div>
      </Step>
      {agent === "claude" ? (
        <>
          <Step n={start + 1} title="Paste this prompt into Claude Code on the agent's machine">
            <p className="text-sm text-zinc-500">
              Claude installs the Rev plugin and the <code className="text-xs">rev</code> CLI, registers the machine and checks the connection.
            </p>
            <CopyBlock text={claudePrompt(origin, src)} wrap />
            <details className="text-sm text-zinc-500">
              <summary className="cursor-pointer select-none">Or type the commands in Claude Code yourself</summary>
              <div className="mt-2">
                <CopyBlock text={claudeCommands(origin, src)} />
              </div>
            </details>
          </Step>
          <Step n={start + 2} title="Put it to work">
            <p className="text-sm text-zinc-600">
              Add the agent to your projects from each project's <b>Members</b> tab, unless the enrollment key already does. Assign it tasks, then ask Claude
              to “work through my Rev tasks”. The plugin's <code className="text-xs">rev:workflow</code> skill teaches it the rest: reading feedback,
              submitting review kits and the next round of a review.
            </p>
          </Step>
        </>
      ) : (
        <>
          <Step n={start + 1} title="Run on the agent's machine">
            <CopyBlock text={shellCommands(origin, src)} />
          </Step>
          <Step n={start + 2} title="Add to the agent's instructions">
            <p className="text-sm text-zinc-500">
              For example in <code className="text-xs">AGENTS.md</code> or its system prompt, so it knows how to work with Rev.
            </p>
            <CopyBlock text={workingInstructions(origin)} wrap />
          </Step>
        </>
      )}
    </div>
  );
}

export function ConnectAgent() {
  const qc = useQueryClient();
  const [enrollKey, setEnrollKey] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(false);
  const src = keySource(enrollKey);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Link to="/agents" className="text-zinc-400 hover:text-zinc-700" title="Back to agents">
              <ArrowLeft className="size-5" />
            </Link>
            Connect an agent
          </span>
        }
        subtitle="Copy these instructions to register a coding agent with Rev and set it up to work on your tasks."
      />
      <div className="mx-auto max-w-3xl px-8 py-6">
        <Card className="space-y-5 p-5">
          <Step n={1} title="Enrollment key">
            <p className="text-sm text-zinc-500">
              Rev shows a key only once, when it is created. Paste one you stored, or a reference such as{" "}
              <code className="text-xs">bao:rev#enroll_key</code> so the agent reads it from OpenBao and it never appears in a chat. It stays in this
              browser tab.
            </p>
            <div className="flex gap-2">
              <Input
                value={enrollKey}
                onChange={(e) => {
                  setEnrollKey(e.target.value);
                  setJustCreated(false);
                }}
                placeholder="rev_enroll_… or bao:<path>#<field>"
                className="font-mono text-xs"
                spellCheck={false}
                autoComplete="off"
                aria-label="Enrollment key"
              />
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-4" /> New key
              </Button>
            </div>
            {justCreated ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                New key filled in. Copy it now and store it like a password (for example{" "}
                <code className="text-xs">bao kv put -mount=secret rev enroll_key=…</code>): Rev won't show it again.
              </p>
            ) : (
              src.kind === "none" && <p className="text-xs text-zinc-400">Without a key, the instructions show {PLACEHOLDER} and the agent asks you for it.</p>
            )}
          </Step>
          <AgentInstructions enrollKey={enrollKey} start={2} />
        </Card>
      </div>
      {creating && (
        <CreateKey
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setEnrollKey(r.key);
            setJustCreated(true);
            qc.invalidateQueries({ queryKey: ["enrollment-keys"] });
          }}
        />
      )}
    </div>
  );
}
