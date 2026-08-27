// 接力前言的投递:「你被搬过机器了」这段话必须**两条起跑路径都收得到**,而且只收一次。
//
// 为什么值得单开一条用例:这段话原先寄生在 tasks.resume_prompt 上,搬到 handoff 标记
// 之后,起跑路径有两条各自独立拼 prompt 的实现——task-run.ts 的 fresh run(会话文件没
// 随任务到货时走这条)和 orchestrator.ts 的 continueTask。只改一条,另一条就静默地
// 永远不投,而且失败得毫无痕迹:任务照跑,agent 只是不知道自己换了台机器、旧路径全变了。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { eq } from "drizzle-orm";
import type { TaskHandoff } from "@ash/shared";
import { IS_WINDOWS } from "../src/platform.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-handoff-notice-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_LAX_DONE = "1";
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_PROMPT_DIR = join(root, "prompts");
process.env.PATH = `${root}${delimiter}${process.env.PATH ?? ""}`;

const [{ db, ensureSchema }, { agents, projects, tasks }, { runTask }, { continueTask }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/task-run.js"),
  import("../src/orchestrator.js"),
]);

const NOTICE = "【任务接力】本任务从另一台机器(peer-host)接力到本机继续。";

const markerFor = (notice: string | undefined): string => JSON.stringify({
  direction: "in", peerUrl: null, peerName: "peer-host", peerTaskId: "t",
  at: new Date().toISOString(), sessions: 0, git: "none",
  ...(notice ? { notice } : {}),
} satisfies TaskHandoff);

try {
  await ensureSchema();
  execFileSync("git", ["init", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Ash Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "ash@example.test"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", root, "add", "seed.txt"]);
  execFileSync("git", ["-C", root, "commit", "-m", "seed"]);

  // 假 codex:把 stdin 上收到的整条 prompt 按 ASH_TASK_ID 落盘,然后立刻收工。
  const script = join(root, IS_WINDOWS ? "fake-codex.mjs" : "codex");
  const launcher = join(root, IS_WINDOWS ? "codex.cmd" : "codex");
  writeFileSync(script, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
let input = "";
process.stdin.on("data", (chunk) => { input += chunk.toString(); });
process.stdin.on("end", () => {
  mkdirSync(process.env.ASH_PROMPT_DIR, { recursive: true });
  writeFileSync(join(process.env.ASH_PROMPT_DIR, process.env.ASH_TASK_ID + ".txt"), input);
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
  send({ type: "thread.started", thread_id: "notice-thread-" + process.env.ASH_TASK_ID });
  send({ type: "item.completed", item: { type: "agent_message", text: "收到" } });
  send({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
  process.exit(0);
});
process.stdin.resume();
`);
  if (IS_WINDOWS) writeFileSync(launcher, `@node "%~dp0fake-codex.mjs" %*\r\n`);
  else chmodSync(script, 0o755);

  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "notice", repoPath: root, apiKeys: null, createdAt: at });
  await db.insert(agents).values({
    id: "codex-profile", name: "codex", type: "codex",
    // exec 专属参数逼执行器走 `codex exec`(prompt 走 stdin),假 CLI 才捞得到整条 prompt。
    extraArgs: JSON.stringify(["--search"]), configOverrides: "{}", isDefault: true,
  });
  for (const id of ["fresh-task", "resume-task"]) {
    await db.insert(tasks).values({
      id, projectId: "p", title: id, body: "把功能做完", mode: "single", status: "backlog",
      agentType: "codex", executorId: "codex-profile", labels: "[]", dependsOn: "[]", resumeDependsOn: "[]",
      autoTitle: false, useWorktree: false, handoff: markerFor(NOTICE), createdAt: at, updatedAt: at,
    });
  }

  // ① fresh run(task-run.ts):会话文件没随任务到货时,接过来的任务第一次跑走这条。
  await runTask("fresh-task");
  // ② continueTask(orchestrator.ts):挂着 checkpoint 指令/收到真人消息时走这条。
  await continueTask("resume-task", "继续:完成第二步");

  for (const [id, hint] of [["fresh-task", "fresh run"], ["resume-task", "continueTask"]] as const) {
    const prompt = readFileSync(join(root, "prompts", `${id}.txt`), "utf8");
    assert.ok(prompt.includes(NOTICE), `${hint} 的 prompt 里必须带上接力前言`);
    const row = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const marker = JSON.parse(row.handoff!) as TaskHandoff;
    assert.equal(marker.notice, undefined, `${hint} 投递完必须把前言从标记上划掉,否则每一轮都重念一遍`);
    assert.equal(marker.direction, "in", `${hint} 划掉前言不能连带动到接力标记本身`);
    assert.equal(row.resumePrompt, null, `${hint} 前言不得写回 resume_prompt——那一列是前端「正等续跑指令」的门禁`);
  }

  console.log("✓ 接力前言两条起跑路径都投得到,投完即划掉,且不占 resume_prompt");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
