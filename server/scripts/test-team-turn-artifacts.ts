// 团队调度台的**回合身份 ↔ 产物归属**：插话之后新做出来的东西必须还在生成物清单里。
//
// 为什么要单独一条、而且非得走真实常驻泵：这两条路**一个故障都不需要**（第二条只需要一次
// 寻常的写库失败），.md、状态、trace 全是对的,库里也没有脏数据 —— 坏的只是「哪一轮在什么
// 时候跑过」这份账,而它唯一的出口就是生成物面板。所以判据只能架在 `readTaskArtifacts` 的
// 返回值上：图在不在清单里、面板说没说实话。
//
//   ① 用户插话:ash 先 interrupt 再 send,新一轮当场开跑,而被打断那一轮的进程过一会儿才吐
//      出它的 turnEnd。按「此刻的 lead.turnStart」结算那个结束事件,就等于把**新**回合提前
//      收口 —— 它真正干活那段落进两条记录之间的空洞,那一轮的图永久漏在清单外（第 1 轮 F1）。
//   ② 开始状态那次写库失败:活动身份已经登记在册,可会话行上还留着上一轮的 ended_at、任务
//      状态也还没刷成 running。读端拿这两个二手快照去否决一手的活动身份,正在写的这一轮就被
//      算成「崩了没收口」,区间夹回旧起点,此后落盘的图当场消失（第 1 轮 F3）。
//
// 跑:npm -w server run test:turn-identity（链在它后面）
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

requireTmpDb("team-turn-artifacts");
const stage = realpathSync(mkdtempSync(join(tmpdir(), "ash-team-turn-artifacts-")));
process.on("exit", () => {
  try { rmSync(stage, { recursive: true, force: true }); } catch { /* 文件还开着就留给下次 */ }
});
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
process.env.ASH_TEAM_IDLE_MS = "600000"; // 别让空闲回收在断言中间把台收掉
process.env.ASH_TEAM_STATUS_RETRY_MS = "40";
mkdirSync(process.env.ASH_RUNS_DIR, { recursive: true });

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { freshTurnFields, openTurn, activeTurnStarts } = await import("../src/session-turns.js");
const { attachLead, deliverToLead, teamIsLive } = await import("../src/team/session.js");
const { openCodexResident } = await import("../src/executors/codex-resident.js");
const { readTaskArtifacts } = await import("../src/task-artifacts.js");
const { eq } = await import("drizzle-orm");

await ensureSchema();

const ok = (m: string) => console.log("   ✓ " + m);
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const until = async (check: () => boolean, what: string) => {
  for (let tries = 0; tries < 600; tries += 1) {
    if (check()) return;
    await pause(20);
  }
  throw new Error(`等不到：${what}`);
};
const svg = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180"><text y="90">${label}</text></svg>`;

/** 一个干净的 git 工作区（`output/` 不纳入版本管理,产物走「未纳入版本管理」那一档）。 */
function initRepo(name: string): string {
  const root = join(stage, name);
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "team turn artifacts");
  git("config", "user.email", "test@example.test");
  git("config", "commit.gpgSign", "false");
  git("config", "core.hooksPath", join(stage, "no-hooks"));
  writeFileSync(join(root, ".gitignore"), "output/\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  mkdirSync(join(root, "output"));
  return root;
}

const openedAt = new Date(Date.now() - 60_000).toISOString();

/** 种一条 team 任务 + 它的调度台会话行,返回工作区目录。 */
async function seed(name: string, taskId: string, sessId: string): Promise<string> {
  const root = initRepo(name);
  await db.insert(projects).values({ id: `project-${taskId}`, name, repoPath: root, createdAt: openedAt });
  await db.insert(tasks).values({
    id: taskId, projectId: `project-${taskId}`, title: name, body: "回合身份与产物归属回归",
    mode: "team", status: "running", agentType: "codex", autoTitle: false, useWorktree: false,
    team: JSON.stringify({ lead: "codex", worker: "codex" }),
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", createdAt: openedAt, updatedAt: openedAt,
  });
  await db.insert(sessions).values({
    id: sessId, taskId, role: "lead", agentType: "codex", executor: "fixture", cwd: root,
    cliSessionId: "fixture-thread", startedAt: openedAt, activeMs: 0, ...freshTurnFields(openedAt),
  });
  mkdirSync(join(stage, "runs", taskId), { recursive: true });
  return root;
}

const listing = (taskId: string, root: string) => readTaskArtifacts(taskId, {
  path: root, repo: root, projectId: `project-${taskId}`, branch: "main", gitRepo: true, source: "session",
} as never);
const paths = (result: { artifacts: { path: string }[] }) => result.artifacts.map((a) => a.path).sort();

/** 手工组装一台调度台（生产路径是 openLead,它要解析项目与执行器,这里只要那台对象本身）。 */
function lead(taskId: string, sessId: string, root: string, handle: unknown, turnStart: string) {
  return {
    taskId, sessId, cliSessionId: "fixture-thread", agentType: "codex" as const, ownerUserId: null,
    executorId: null, model: null, reasoningEffort: null, cwd: root, handle,
    out: createWriteStream(join(stage, "runs", taskId, `${sessId}.md`), { flags: "a" }),
    busy: true, turnStart, pending: [], notices: [], pendingCredential: null,
    wantedStatus: null, statusTimer: null, retired: false, idleTimer: null, closing: null,
  };
}

try {
  // ── ① 真实常驻泵 + 真实插话：新一轮做出来的图必须在清单里（第 1 轮审查 F1）──────────
  {
    const taskId = "team-artifacts-interrupt";
    const sessId = "sess-interrupt";
    const root = await seed("interrupt", taskId, sessId);
    const started: string[] = [];
    let letUserSpeak = () => {};
    let letUserFinish = () => {};
    const userSpoke = new Promise<void>((resolve) => { letUserSpeak = resolve; });
    const userFinished = new Promise<void>((resolve) => { letUserFinish = resolve; });
    let killInitial = () => {};
    const initialKilled = new Promise<void>((resolve) => { killInitial = resolve; });
    // 真实的 codex 常驻泵：回合串行,打断 = 杀掉当前回合的进程,被杀那一轮退出时泵照样补一个
    // turnEnd,**然后**才起用户那一轮。只有最底层的「一个回合的事件源」换成了本地生成器。
    const resident = openCodexResident({
      initialSessionId: "fixture-thread",
      initialPrompt: "INITIAL",
      startTurn(prompt: string) {
        const name = prompt.includes("INITIAL") ? "INITIAL" : "USER";
        started.push(name);
        return {
          child: { name } as never,
          commandLine: "fixture-codex",
          lifecycle: { stopRequested: false },
          events: (async function* (): AsyncGenerator<AgentEvent> {
            if (name === "INITIAL") await initialKilled;
            else {
              await userSpoke;
              yield { kind: "text", text: "新要求的海报已经落盘。" };
              await userFinished;
            }
            yield { kind: "done", exitStatus: 0 };
          })(),
        };
      },
      killTurn(child: unknown) {
        if ((child as { name: string }).name === "INITIAL") killInitial();
        else letUserFinish();
      },
    });
    const desk = lead(taskId, sessId, root, resident, openedAt);
    writeFileSync(join(root, "output", "before-interrupt.svg"), svg("before"));
    attachLead(desk as never);
    await openTurn({ sessionId: sessId, taskId, cwd: root, startedAt: openedAt });
    assert.deepEqual([...activeTurnStarts(sessId)], [openedAt], "前置条件:首轮的身份在册");
    assert.equal(await deliverToLead(taskId, "先停下旧要求,按新要求画海报"), true, "前置条件:插话真进了调度台");
    await until(() => started.includes("USER"), "真实常驻泵起用户那一轮");
    // 落定余量（SETTLE_MS=2s）之后才落盘：这样它**只可能**靠插话那一轮自己的区间被认出来,
    // 旧回合的区间再怎么加宽限也盖不到。修复前这里是两条记录之间的空洞。
    await pause(2600);
    writeFileSync(join(root, "output", "new-user-poster.svg"), svg("after interrupt"));
    const during = await listing(taskId, root);
    assert(paths(during).includes("output/new-user-poster.svg"),
      `插话那一轮正在写,它刚做出来的图却不在清单里：${JSON.stringify(paths(during))} / ${JSON.stringify(during.incomplete)}`);
    letUserSpeak();
    await pause(100);
    letUserFinish();
    resident.close();
    await until(() => !teamIsLive(taskId), "这台收完台");
    const after = await listing(taskId, root);
    assert.deepEqual(paths(after), ["output/before-interrupt.svg", "output/new-user-poster.svg"],
      `收完台之后两张图都该在清单里,实际：${JSON.stringify(paths(after))}`);
    assert.deepEqual(after.incomplete, [],
      `两轮都正常收了口,面板不该说有缺口,实际：${JSON.stringify(after.incomplete)}`);
    assert.deepEqual([...activeTurnStarts(sessId)], [], "收完台一个活动身份都不该留");
    ok("用户插话:新一轮做出来的图在清单里,面板不报缺口");
  }

  // ── ② 开始状态写库失败：登记在册的那一轮不许被陈旧快照否决（第 1 轮审查 F3）──────────
  {
    const taskId = "team-artifacts-stale";
    const sessId = "sess-stale";
    const root = await seed("stale", taskId, sessId);
    let letLast = () => {};
    const last = new Promise<void>((resolve) => { letLast = resolve; });
    let letSecond = () => {};
    const second = new Promise<void>((resolve) => { letSecond = resolve; });
    const handle = {
      sessionId: "fixture-thread",
      commandLine: "fixture-codex",
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { kind: "turnEnd" }; // 上一轮正常收尾 —— 会话行上就此留下一个 ended_at
        await second;
        yield { kind: "turnEnd" };
        await last;
        yield { kind: "done", exitStatus: 0 };
      })(),
      send: () => true,
      interrupt: () => {},
      dropSession: () => {},
      close: () => { letLast(); },
      kill: () => { letLast(); },
    };
    const desk = lead(taskId, sessId, root, handle, openedAt);
    attachLead(desk as never);
    await openTurn({ sessionId: sessId, taskId, cwd: root, startedAt: openedAt });
    await until(() => !activeTurnStarts(sessId).size, "上一轮正常收尾");
    const settled = (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!;
    assert(settled.endedAt, "前置条件:上一轮的收尾时刻确实写在会话行上");
    // 寻常的一次写库失败：回合开始状态刷不上去（`ended_at` 没被清回 null、`turn_started_at`
    // 还是上一轮的）,而开始行与活动登记照常。任务状态也一起挡住,复现「状态还没刷成 running」
    // 的那个窗口 —— 两个都是二手快照,都不该否决一手的活动身份。
    await dbClient.executeMultiple(`
      CREATE TRIGGER stale_block_session BEFORE UPDATE OF turn_started_at ON sessions BEGIN SELECT RAISE(ABORT,'injected'); END;
      CREATE TRIGGER stale_block_task BEFORE UPDATE ON tasks WHEN NEW.id='${taskId}' BEGIN SELECT RAISE(ABORT,'injected'); END;
    `);
    try {
      assert.equal(await deliverToLead(taskId, "接着画第二张"), true, "前置条件:插话进了调度台");
      await until(() => activeTurnStarts(sessId).size === 1, "新一轮持有自己的身份");
      await pause(50);
      const row = (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!;
      assert.equal(row.endedAt, settled.endedAt, "前置条件:会话行上那个陈旧的收尾时刻确实没被清掉");
      writeFileSync(join(root, "output", "live.svg"), svg("live"));
      const live = await listing(taskId, root);
      assert(paths(live).includes("output/live.svg"),
        `这一轮正在写,它刚落盘的图却被排除了：${JSON.stringify(paths(live))} / ${JSON.stringify(live.incomplete)}`);
      assert(!live.incomplete.some((note) => note.includes("没留下收尾时刻")),
        `正在跑的那一轮被当成「崩了没收口」,实际提示：${JSON.stringify(live.incomplete)}`);
    } finally {
      await dbClient.executeMultiple("DROP TRIGGER IF EXISTS stale_block_session; DROP TRIGGER IF EXISTS stale_block_task;");
    }
    letSecond();
    letLast();
    await until(() => !teamIsLive(taskId), "这台收完台");
    ok("开始状态写库失败:登记在册的那一轮照样算在写,它的产物不被排除");
  }

  console.log("test:team-turn-artifacts ok");
} finally {
  try { dbClient.close(); } catch { /* 已经关了 */ }
  await releaseTmpDb();
}
