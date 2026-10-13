// 回合收尾合并投递的那段 await 里,**又来了一条执行者汇报**。
//
// `sendToLead` 投递前要现读一次浏览器授权(一次查库)。这期间调度台可能已经又忙起来
// (用户插话),新到的执行者汇报就追加进同一个 `lead.pending`。原先 `endTurn` 拿的是这个
// 数组的**引用**:送出去的文本只含第一批,回来却 `lead.pending = []` 全清、再按同一个引用
// 里的 seq 去 `consumeInbound` 销账 —— 新来的那条既没送出,行也从 team_inbound 删掉了,
// 刷新、续聊、换台都找不回来(第 7 链第 1 轮审查 P1 实测到两条都没了)。
//
// 这里钉的是那条交错:**没送出去的,必须还在待送队列里**。确定性地卡在读授权那次查询上,
// 不靠 sleep 赌时序。
//
// 跑:ASH_DB=/tmp/t.db npm -w server run test:team-inbound-durability
import assert from "node:assert/strict";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

requireTmpDb("test-team-inbound-interleave");
const dir = mkdtempSync(join(tmpdir(), "ash-team-interleave-"));
process.env.ASH_RUNS_DIR = join(dir, "runs");
process.env.ASH_TEAM_IDLE_MS = "0";

const TASK = "task-inbound-interleave";
const SESS = "sess-inbound-interleave";
const FIRST = "执行者汇报一:第 1 项做完了";
const SECOND = "执行者汇报二:第 2 项也做完了";
const AT = "2026-10-14T00:00:00.000Z";

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { attachLead, deliverToLead, sendInbound } = await import("../src/team/session.js");
const { pendingInbound } = await import("../src/team/inbound-queue.js");
const { tasks: taskTable } = await import("../src/db/schema.js");

await ensureSchema();
await db.insert(projects).values({ id: "project", name: "inbound-interleave", repoPath: dir, createdAt: AT });
await db.insert(tasks).values({
  id: TASK, projectId: "project", title: "调度台", body: "带一队人干活", mode: "team",
  status: "running", team: JSON.stringify({ lead: "codex", worker: "codex" }),
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
  autoTitle: false, createdAt: AT, updatedAt: AT,
});
await db.insert(sessions).values({
  id: SESS, taskId: TASK, role: "lead", agentType: "codex", executor: "codex@test", cwd: dir,
  cliSessionId: "thread-a", resumeCommand: "codex exec resume thread-a",
  startedAt: AT, turnStartedAt: AT, activeMs: 0,
});

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
};

// ── 卡住「投递前现读授权」那次查询:browserGrantForTask 的 select 只取 projectId 一个字段 ──
/* eslint-disable @typescript-eslint/no-explicit-any */
const plainSelect = db.select;
let armed = false;
const grantReached = deferred();
const grantGate = deferred();
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

const runDir = join(dir, "runs", TASK);
mkdirSync(runDir, { recursive: true });
const sends: string[] = [];
const events: AgentEvent[] = [];
let wake: (() => void) | null = null;
const pushEvent = (e: AgentEvent) => { events.push(e); wake?.(); wake = null; };
const lead = {
  taskId: TASK, sessId: SESS, cliSessionId: "thread-a", agentType: "codex" as const, ownerUserId: null,
  executorId: null, model: null, reasoningEffort: null, cwd: dir,
  handle: {
    sessionId: "thread-a", commandLine: "codex exec resume thread-a",
    events: (async function* () {
      for (;;) {
        if (events.length) { yield events.shift()!; continue; }
        await new Promise<void>((r) => { wake = r; });
      }
    })(),
    send: (text: string) => { sends.push(text); return true; },
    interrupt: () => {}, dropSession: () => {}, close: () => {}, kill: () => {},
  },
  out: createWriteStream(join(runDir, `${SESS}.md`), { flags: "a" }),
  busy: true, turnStart: AT, pending: [], notices: [], pendingCredential: null,
  wantedStatus: null, statusTimer: null, retired: false, idleTimer: null, closing: null,
};
attachLead(lead as unknown as Parameters<typeof attachLead>[0]);

const waitFor = async (what: string, fn: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`等不到:${what}`);
};

await sendInbound(TASK, FIRST); // 调度台正忙 → 只进待送队列
assert.deepEqual((await pendingInbound(TASK)).map((r) => r.text), [FIRST], "前置条件:第一条进了持久待送队列");

armed = true;
pushEvent({ kind: "turnEnd" } as AgentEvent); // 回合收尾:合并投递这一批
await grantReached.promise; // 卡在读授权上 —— 要送的文本这时已经定死成「只含第一条」

// 用户插话让它又忙起来(这里直接置位,等价于插话跑完 beginTurn 的那一刻,但不引入新的时序)。
lead.busy = true;
// 真发一句插话:它排在投递链上等前面那条合并汇报。**不 await** —— 主流程还要先放行 gate。
const USER_MSG = "用户插话:顺便再查一下第 3 项";
const userSend = deliverToLead(TASK, USER_MSG);
await sendInbound(TASK, SECOND); // 忙 → 落库 + 追加进同一个 lead.pending
assert.deepEqual((await pendingInbound(TASK)).map((r) => r.text), [FIRST, SECOND],
  "前置条件:第二条在那段 await 里真的追加进来了");

grantGate.resolve();
await waitFor("第一批被送进调度台", () => sends.some((t) => t.includes(FIRST)));
await waitFor("第一批销账", async () => !(await pendingInbound(TASK)).some((r) => r.text === FIRST));

const queued = (await pendingInbound(TASK)).map((r) => r.text);
assert.ok(
  sends.some((t) => t.includes(SECOND)) || queued.includes(SECOND),
  "await 期间新到的汇报:要么已经真的送出去,要么还在持久待送队列里 —— 两者皆无就是永久丢失",
);
assert.deepEqual(queued, [SECOND], "它应当原样留在队列里,等下一次回合收尾合并送出");
console.log("   ✓ 合并投递的 await 期间新到的汇报不会被一起销账");

// 投递是**串行**的:合并汇报的 send 先发起,用户插话就得排在它后面。没有这条链的话,插话
// 会趁前者卡在读授权时抢先写进 stdin —— 调度者先看到「新要求」、后看到本该在它之前的那份
// 执行结果,上下文是倒的(第 7 链第 1 轮审查实测到的就是这个顺序)。
assert.equal(await userSend, true, "插话最终要真的送进去");
assert.ok(
  sends.findIndex((t) => t.includes(FIRST)) < sends.findIndex((t) => t.includes(USER_MSG)),
  "先发起的合并汇报必须先落地 —— 插话抢在它前面,调度者看到的上下文就是倒的",
);
console.log("   ✓ 同一台的投递按调用顺序串行,插话不会抢在合并汇报前面");

// 下一次回合收尾:它必须真的送出去,并且只送一次。
pushEvent({ kind: "turnEnd" } as AgentEvent);
await waitFor("第二条在下一次收尾时送出", () => sends.some((t) => t.includes(SECOND)));
await waitFor("第二条销账", async () => (await pendingInbound(TASK)).length === 0);
assert.equal(sends.filter((t) => t.includes(SECOND)).length, 1, "同一条汇报不许送两遍");
console.log("   ✓ 它在下一次回合收尾时照常送出,恰好一次");

(db as unknown as { select: typeof plainSelect }).select = plainSelect;
await db.update(taskTable).set({ status: "idle" }).where((await import("drizzle-orm")).eq(taskTable.id, TASK));
rmSync(dir, { recursive: true, force: true });
try { dbClient.close(); } catch { /* 已经关了 */ }
releaseTmpDb();
console.log("test:team-inbound-interleave ok");
