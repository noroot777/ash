// 用户插话必须**当场转向**,哪怕它是排在别的投递后面进来的。
//
// 团队插话的契约是「interrupt + send」(见 team/session.ts 头注 ②③):codex 常驻一次只跑
// 一个回合,忙的时候 send 只是把文本塞进 waiting,真正转向非 interrupt 不可。投递改成串行
// 之后,打断的判据一度还留在**入队那一刻**:排队期间前面那条执行者汇报刚把一个新回合送出
// 去,等轮到插话时它只是排在队尾 —— 用户看到「已发出」,调度者却要把整个旧回合跑完才理他
// (第 7 链第 2 轮审查 P1)。
//
// 所以这条测试驱动**真的** codex 常驻泵(openCodexResident,带它自己的回合队列),让旧回合
// 一直不结束,看用户那句话能不能在它结束之前就开跑。断言的不是 send 的先后,而是「哪个回合
// 真的启动了、哪个回合被杀了」。
//
// 跑:ASH_DB=/tmp/t.db npx tsx server/scripts/test-team-user-interrupt.ts
import assert from "node:assert/strict";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "@ash/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

requireTmpDb("test-team-user-interrupt");
const root = mkdtempSync(join(tmpdir(), "ash-team-interrupt-"));
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_TEAM_IDLE_MS = "0";

const TASK = "task-user-interrupt";
const SESS = "sess-user-interrupt";
const AT = "2026-10-14T00:00:00.000Z";
const WORKER = "WORKER_RESULT:执行者把第 1 项做完了";
const USER = "NEW_USER_INSTRUCTION:先停下旧任务,立即按新要求做";

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { attachLead, deliverToLead, sendInbound, teamIsLive } = await import("../src/team/session.js");
const { pendingInbound } = await import("../src/team/inbound-queue.js");
const { openCodexResident } = await import("../src/executors/codex-resident.js");

await ensureSchema();
await db.insert(projects).values({ id: "project", name: "user-interrupt", repoPath: root, createdAt: AT });
await db.insert(tasks).values({
  id: TASK, projectId: "project", title: "调度台", body: "带一队人干活", mode: "team",
  status: "running", team: JSON.stringify({ lead: "codex", worker: "codex" }),
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
  autoTitle: false, createdAt: AT, updatedAt: AT,
});
await db.insert(sessions).values({
  id: SESS, taskId: TASK, role: "lead", agentType: "codex", executor: "codex@test", cwd: root,
  cliSessionId: "thread-a", resumeCommand: "codex exec resume thread-a",
  startedAt: AT, turnStartedAt: AT, activeMs: 0,
});

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
};
const initialDone = deferred();
const workerDone = deferred();
const userDone = deferred();
const grantReached = deferred();
const grantGate = deferred();

// ── 真实的 codex 常驻泵:一次只跑一个回合,忙时 send 进 waiting ──────────────────
const started: string[] = [];
const killed: string[] = [];
const resident = openCodexResident({
  initialSessionId: "thread-a",
  initialPrompt: "INITIAL_TASK",
  startTurn: (prompt: string) => {
    const name = prompt.includes("NEW_USER_INSTRUCTION") ? "USER" : prompt.includes("WORKER_RESULT") ? "WORKER" : "INITIAL";
    started.push(name);
    const done = name === "INITIAL" ? initialDone : name === "WORKER" ? workerDone : userDone;
    return {
      child: { name } as unknown as ChildProcess,
      commandLine: `stub ${name}`,
      lifecycle: { stopRequested: false },
      events: (async function* (): AsyncGenerator<AgentEvent> {
        await done.promise;
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
  },
  // 假回合没有真进程,后代回收是空操作(真实实现是 cleanupAfterRun)。
  finalizeTurn: async () => ({ kind: "empty" }) as const,
  killTurn: (child: ChildProcess) => {
    const turn = child as unknown as { name: string };
    killed.push(turn.name);
    (turn.name === "INITIAL" ? initialDone : turn.name === "WORKER" ? workerDone : userDone).resolve();
  },
});

const runDir = join(root, "runs", TASK);
mkdirSync(runDir, { recursive: true });
attachLead({
  taskId: TASK, sessId: SESS, cliSessionId: "thread-a", agentType: "codex", ownerUserId: null,
  executorId: null, model: null, reasoningEffort: null, cwd: root, handle: resident,
  out: createWriteStream(join(runDir, `${SESS}.md`), { flags: "a" }),
  busy: true, turnStart: AT, pending: [], notices: [], pendingCredential: null,
  wantedStatus: null, statusTimer: null, retired: false, idleTimer: null, closing: null,
});

await sendInbound(TASK, WORKER); // 调度台正忙 → 只进待送队列
assert.equal((await pendingInbound(TASK)).length, 1, "前置条件:汇报进了持久待送队列");

// 卡住「投递前现读授权」那次查询(browserGrantForTask 的 select 只取 projectId 一个字段),
// 于是回合收尾送汇报时必定停在这里,给插话一个确定的插入点。
/* eslint-disable @typescript-eslint/no-explicit-any */
const plainSelect = db.select;
let armed = true;
(db as any).select = function hookedSelect(this: unknown, fields: unknown) {
  const builder: any = (plainSelect as any).call(this, fields);
  const isGrantQuery = !!fields && typeof fields === "object"
    && Object.keys(fields as object).length === 1 && "projectId" in (fields as object);
  if (!armed || !isGrantQuery) return builder;
  armed = false;
  const realFrom = builder.from.bind(builder);
  builder.from = (table: unknown) => {
    const query = realFrom(table);
    const realWhere = query.where.bind(query);
    query.where = (cond: unknown) => {
      const selected = realWhere(cond);
      const realThen = selected.then.bind(selected);
      selected.then = (okFn: unknown, errFn: unknown) => {
        grantReached.resolve();
        return grantGate.promise.then(() => realThen(okFn, errFn));
      };
      return selected;
    };
    return query;
  };
  return builder;
} as typeof db.select;
/* eslint-enable @typescript-eslint/no-explicit-any */

initialDone.resolve();        // 开场那个回合说完了 → endTurn 开始投递汇报
await grantReached.promise;   // 汇报卡在读授权上
const delivery = deliverToLead(TASK, USER); // 插话:排在那条汇报后面
await new Promise((r) => setImmediate(r));
grantGate.resolve();
assert.equal(await delivery, true, "插话要真的送进去");
await new Promise((r) => setImmediate(r));

// 关键断言:旧回合(WORKER)此刻**还没结束** —— 没人 resolve 过 workerDone。
assert.ok(started.includes("WORKER"), "前置条件:汇报那一轮确实起了回合");
assert.ok(
  started.includes("USER"),
  "用户插话必须当场转向:旧回合还在跑,它却要等旧回合整个跑完 —— 那就不是 steering 了",
);
assert.deepEqual(killed, ["WORKER"], "转向靠的是打断旧回合,而不是排队等它自己结束");
assert.deepEqual(started, ["INITIAL", "WORKER", "USER"], "三个回合的真实启动顺序");
console.log("   ✓ 排在别的投递后面进来的用户插话,照样当场打断旧回合");

(db as unknown as { select: typeof plainSelect }).select = plainSelect;
workerDone.resolve();
userDone.resolve();
await new Promise((r) => setImmediate(r));
resident.close();
for (let i = 0; i < 200 && teamIsLive(TASK); i++) await new Promise((r) => setTimeout(r, 10));
rmSync(root, { recursive: true, force: true });
try { dbClient.close(); } catch { /* 已经关了 */ }
releaseTmpDb();
console.log("test:team-user-interrupt ok");
