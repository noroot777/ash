import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ServerEvent } from "@ash/shared";
import { parseSessionOutput } from "@ash/shared";
import { eq } from "drizzle-orm";
import { IS_WINDOWS } from "../src/platform.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-run-notices-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_LAX_DONE = "1";
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_NOTICE_TRIGGER = join(root, "finish");
process.env.PATH = `${root}${delimiter}${process.env.PATH ?? ""}`;

const [
  { db, ensureSchema },
  { agents, projects, sessions, tasks },
  { runTask },
  { bus },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/task-run.js"),
  import("../src/bus.js"),
]);

try {
  await ensureSchema();
  execFileSync("git", ["init", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Ash Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "ash@example.test"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", root, "add", "seed.txt"]);
  execFileSync("git", ["-C", root, "commit", "-m", "seed"]);
  const fakeCodexScript = join(root, IS_WINDOWS ? "fake-codex.mjs" : "codex");
  const fakeCodex = join(root, IS_WINDOWS ? "codex.cmd" : "codex");
  writeFileSync(fakeCodexScript, `#!/usr/bin/env node
import { existsSync } from "node:fs";
const isExec = process.argv.includes("exec");
let input = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const receive = (message) => {
  if (message.id === undefined) return;
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "notice-thread" } } });
  else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "notice-turn" } } });
    const timer = setInterval(() => {
      if (!existsSync(process.env.ASH_NOTICE_TRIGGER)) return;
      clearInterval(timer);
      send({ method: "turn/completed", params: {
        threadId: "notice-thread", turn: { id: "notice-turn", status: "completed", error: null },
      } });
    }, 10);
  }
};
if (isExec) {
  process.stdin.resume();
  process.stdin.on("end", () => {
    const timer = setInterval(() => {
      if (!existsSync(process.env.ASH_NOTICE_TRIGGER)) return;
      clearInterval(timer);
      send({ type: "thread.started", thread_id: "notice-thread" });
      send({ type: "item.completed", item: { type: "agent_message", text: "兼容参数已保留" } });
      send({ type: "turn.completed", usage: {
        input_tokens: 2, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0,
      } });
      process.exit(0);
    }, 10);
  });
} else {
  process.stdin.on("data", (chunk) => {
    input += chunk.toString();
    for (;;) {
      const newline = input.indexOf("\\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (line) receive(JSON.parse(line));
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
`);
  if (IS_WINDOWS) writeFileSync(fakeCodex, `@node "%~dp0fake-codex.mjs" %*\r\n`);
  else chmodSync(fakeCodex, 0o755);

  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "notice", repoPath: root, apiKeys: null, createdAt: at });
  const secret = "never-show-this-token";
  await db.insert(agents).values({
    id: "codex-profile",
    name: "codex notice profile",
    type: "codex",
    extraArgs: JSON.stringify(["--search", "--profile", "my-profile", "-c", "foo=1", `--api-key=${secret}`]),
    configOverrides: "{}",
    isDefault: true,
  });
  await db.insert(tasks).values({
    id: "t", projectId: "p", title: "notice", body: "test", mode: "single", status: "running",
    agentType: "codex", executorId: "codex-profile", labels: "[]", dependsOn: "[]", resumeDependsOn: "[]",
    autoTitle: false, useWorktree: false, createdAt: at, updatedAt: at,
  });

  const events: ServerEvent[] = [];
  const unsubscribe = bus.subscribe((event) => events.push(event));
  let running: Promise<void> | null = null;
  try {
    running = runTask("t");
    let inFlight: typeof sessions.$inferSelect | undefined;
    for (let i = 0; i < 200 && !(inFlight?.commandLine && (IS_WINDOWS || inFlight.agentPid)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight = (await db.select().from(sessions).where(eq(sessions.taskId, "t"))).at(0);
    }
    const taskState = (await db.select().from(tasks).where(eq(tasks.id, "t"))).at(0);
    assert.ok(inFlight?.commandLine,
      `真实 runTask 必须先落 session；session=${JSON.stringify(inFlight)} task=${JSON.stringify(taskState)}`);
    if (IS_WINDOWS) {
      assert.equal(inFlight.agentPid, null, "Windows 原生回合按平台约定不 detached");
      assert.equal(inFlight.agentOutPath, null, "Windows 不得伪造不可接管的 detached 输出路径");
    } else {
      assert.ok(inFlight.agentPid, "POSIX 原生引导进程 pid 必须落进 session");
      assert.ok(inFlight.agentOutPath && inFlight.agentErrPath && inFlight.agentRcPath,
        "POSIX 原生 runTask 必须整组落下 detached 输出路径");
    }
    assert.match(inFlight.commandLine ?? "", /\bexec\b/, "含 exec 专属参数时必须回退到 codex exec");
    assert.match(inFlight.commandLine ?? "", /--search/, "--search 不得因原生引导被静默丢弃");
    assert.match(inFlight.commandLine ?? "", /--profile my-profile/, "profile 参数及其值必须原样保留");
    assert.match(inFlight.commandLine ?? "", /-c foo=1/, "exec 与 App Server 共用的 -c 也必须保留");
    assert.doesNotMatch(inFlight.commandLine ?? "", new RegExp(secret));
    writeFileSync(process.env.ASH_NOTICE_TRIGGER!, "finish");
    await running;
  } finally {
    unsubscribe();
  }

  const session = (await db.select().from(sessions).where(eq(sessions.taskId, "t"))).at(0)!;
  const transcriptPath = join(root, "runs", "t", `${session.id}.md`);
  assert.equal(existsSync(transcriptPath), true);
  const ignoredNotice = "Codex 原生引导回合不支持以下执行器固定参数，已忽略";
  assert.equal(parseSessionOutput(readFileSync(transcriptPath, "utf8"))
    .some((segment) => segment.kind === "system" && segment.text.includes(ignoredNotice)), false,
  "exec 专属参数不应再以旁注形式宣告被忽略");
  assert.equal(events.some((event) => event.type === "agent.event"
    && event.event.kind === "system" && event.event.text?.includes(ignoredNotice)), false,
  "实时事件也不应声称兼容参数已被丢弃");
  console.log("✓ Codex 含 exec 专属参数时保留完整 CLI 语义并安全回退硬引导");
} finally {
  await releaseTmpDb();
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt >= 10) {
        console.warn(`⚠︎ 临时目录没删掉(不影响结论):${root} — ${(error as Error).message}`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
