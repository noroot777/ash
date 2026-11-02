// 常驻调度台这条链的**静默档** —— 「回合起来了,一条事件都不来」在团队台上也得有人管。
// 跑:npm -w server run test:team-silence-tier
//
// 为什么单独一条:三条消费链里只有这一台原先**压根没挂静默档**(单飞 single-run.ts、
// duet/turn.ts 都挂了)。第 1 轮自由审查把它记成 N1、按「不扩成团队队列重构」放过了一轮,
// 可它跟 2026-11-02 那次 1.5 小时零输出是同一个根因:**这一档不能靠事件驱动来开**,
// 一条事件都不来的回合在错误档(`trackTurnStall`)上永远没有形状。
//
// 常驻台比另两条链多两件要命的事,这里各钉一条:
//   ① 回合是**串行队列**:用户插话那一轮可能在队里排了半小时,而它的身份就是投入那一刻。
//      按身份起算 = 刚轮到它就已经欠了半小时,当场误杀一个刚开跑的健康回合。所以钟从
//      「什么时候轮到它」起算(所有权层的 `frontSince`,见 team/lead-turns.ts)。
//   ② 进展那份参与证明得有人落:没有它,读侧一律 `unreadable` → 这一档永远不开(那正是
//      「宁可漏判不可误杀」的安全侧,但也等于这一档白挂)。落点在 `holdTurn` —— 持有的唯一
//      赋值处,新调用点漏不掉(判据见 turn-progress-mark.ts 文件头)。
import { createWriteStream, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

// 库也开在这个临时目录里(自带,不要调用方传);`requireTmpDb` 照旧把「别写进真实任务库」
// 那道闸留着 —— 这几段是真往库里写的。**库路径用没过 realpath 的那一份**:macOS 上
// `/var/folders/…` 的真身是 `/private/var/folders/…`,而那道闸是按 `os.tmpdir()` 做前缀
// 比较的,给它真身它会判「不在临时目录下」并拒跑(路径本身完全没问题)。
const rawStage = mkdtempSync(join(tmpdir(), "ash-team-silence-"));
process.env.ASH_DB = join(rawStage, "ash.db");
requireTmpDb("team-silence-tier");
const stage = realpathSync(rawStage);
process.on("exit", () => {
  try { rmSync(stage, { recursive: true, force: true }); } catch { /* 文件还开着就留给下次 */ }
});
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_TEAM_IDLE_MS = "600000"; // 别让空闲回收在断言中间把台收掉
mkdirSync(process.env.ASH_RUNS_DIR, { recursive: true });

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { freshTurnFields } = await import("../src/session-turns.js");
const { holdTurn, releaseHeldTurn } = await import("../src/team/lead-turns.js");
const { turnProgress } = await import("../src/turn-progress-mark.js");
const { attachLead, teamIsLive } = await import("../src/team/session.js");
const { configure, spy, sleep } = await import("./stall-fixtures.js");
const { watchTurnSilence, clearTurnStall } = await import("../src/turn-stall.js");
const { eq } = await import("drizzle-orm");

await ensureSchema();

let failures = 0;
const ok = (line: string) => console.log(`   ✓ ${line}`);
const fail = (line: string) => { failures += 1; console.error(`   ✗ ${line}`); };
const check = (cond: boolean, line: string) => (cond ? ok(line) : fail(line));
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

console.log("① 持有一个回合身份 = 本进程开了这一轮,参与证明当场落盘");
{
  const taskId = "team-silence-proof";
  const sessId = "sess-proof";
  mkdirSync(join(stage, "runs", taskId), { recursive: true });
  const desk = { taskId, sessId, busy: false, turnStart: null } as never as Parameters<typeof holdTurn>[0];
  const mine = ago(30 * 60_000);
  const elders = ago(35 * 60_000); // 旧代开的那一轮(或者别的进程开的)
  check(holdTurn(desk, mine), "前提:这个身份真的被收进手里了");
  check(turnProgress(taskId, sessId, mine) === "none",
    "本进程开的这一轮:参与证明在、进展记号不在 → 确证零进展(这一档开得起来)");
  check(turnProgress(taskId, sessId, elders) === "unreadable",
    "同一个目录下、没被这个进程持有过的那一轮 → 核实不了,不许当「确证零进展」杀掉");
  releaseHeldTurn(desk);
}

console.log("② 排过队的那一轮,静默钟从「轮到它」起算,不从投入那一刻起算");
{
  const taskId = "team-silence-queued";
  const sessId = "sess-queued";
  mkdirSync(join(stage, "runs", taskId), { recursive: true });
  const desk = { taskId, sessId, busy: false, turnStart: null } as never as
    Parameters<typeof holdTurn>[0] & { frontSince?: string | null };
  const running = ago(30 * 60_000); // 正在跑的那一轮
  const interjected = ago(20 * 60_000); // 用户插话那一轮:它的身份就是投入那一刻
  holdTurn(desk, running);
  holdTurn(desk, interjected);
  check(desk.turnStart === running, "前提:队首还是正在跑的那一轮(投入 ≠ 切换队首)");
  releaseHeldTurn(desk); // 正在跑那一轮说完了 → 插话那一轮顶上来
  check(desk.turnStart === interjected, "前提:插话那一轮成了队首");
  const sinceGap = Date.now() - Date.parse(desk.frontSince ?? interjected);
  check(desk.frontSince !== interjected && sinceGap < 5_000,
    `钟的起点是「轮到它」那一刻(实际欠 ${Math.round(sinceGap / 1000)} 秒,按身份算要欠 1200 秒)`);

  // 行为级:警告线设成 1 分钟。按 `frontSince` 算欠 0 秒 → 一拍都不该报;按身份算欠 20 分钟
  // → 当场误杀一个刚轮到它、还没来得及说第一句话的健康回合。
  configure({ silentWarnMs: 60_000, silentTripMs: 120_000, pollMs: 200 });
  const fresh = spy(taskId);
  watchTurnSilence(sessId, desk, desk.turnStart!, fresh.actions, "none", desk.frontSince);
  await sleep(700);
  check(fresh.log.warns.length === 0 && fresh.log.trips.length === 0,
    `刚轮到它的那一轮不报警也不熔断(实际 ${fresh.log.warns.length} 警 / ${fresh.log.trips.length} 熔断)`);
  clearTurnStall(sessId, desk);

  // 对照:同一个起点字段真的被当成钟用了 —— 换成「早就该报」的起点,这一档照旧开。
  configure({ silentWarnMs: 100, silentTripMs: 400, graceMs: 600_000, pollMs: 200 });
  const overdue = spy(taskId);
  watchTurnSilence(sessId, desk, desk.turnStart!, overdue.actions, "none", ago(40 * 60_000));
  await sleep(900);
  check(overdue.log.warns.length === 1 && overdue.log.trips.length === 1,
    "真的欠了很久就照旧报警加熔断(这一档没被「从队首起算」修没)");
  clearTurnStall(sessId, desk);
}

/** 种一台**什么都不说**的常驻调度台(正是事故现场那个形状:进程活着、协议没动静)。 */
async function seedDesk(taskId: string, sessId: string, turnStart: string) {
  mkdirSync(join(stage, "runs", taskId), { recursive: true });
  await db.insert(projects).values({
    id: `project-${taskId}`, name: taskId, repoPath: stage, createdAt: ago(60_000),
  } as never);
  await db.insert(tasks).values({
    id: taskId, projectId: `project-${taskId}`, title: taskId, body: "团队静默档回归",
    mode: "team", status: "running", agentType: "codex", autoTitle: false, useWorktree: false,
    team: JSON.stringify({ lead: "codex", worker: "codex" }),
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", createdAt: ago(60_000), updatedAt: ago(60_000),
  } as never);
  await db.insert(sessions).values({
    id: sessId, taskId, role: "lead", agentType: "codex", executor: "fixture", cwd: stage,
    cliSessionId: "fixture-thread", startedAt: ago(60_000), activeMs: 0, ...freshTurnFields(turnStart),
  } as never);
  const queued: AgentEvent[] = [];
  let wake = () => {};
  const push = (event: AgentEvent) => { queued.push(event); wake(); };
  let interrupts = 0;
  const handle = {
    sessionId: "fixture-thread",
    commandLine: "fixture-codex",
    events: (async function* (): AsyncGenerator<AgentEvent> {
      for (;;) {
        if (!queued.length) await new Promise<void>((resolve) => { wake = resolve; });
        while (queued.length) {
          const event = queued.shift()!;
          yield event;
          if (event.kind === "done") return;
        }
      }
    })(),
    send: () => true,
    interrupt: () => { interrupts += 1; },
    dropSession: () => {},
    close: () => push({ kind: "done", exitStatus: 0 }),
    kill: () => push({ kind: "done", exitStatus: 0 }),
  };
  const desk = {
    taskId, sessId, cliSessionId: "fixture-thread", agentType: "codex" as const, ownerUserId: null,
    executorId: null, model: null, reasoningEffort: null, cwd: stage, handle,
    out: createWriteStream(join(stage, "runs", taskId, `${sessId}.md`), { flags: "a" }),
    busy: true, turnStart, pending: [], notices: [], pendingCredential: null,
    wantedStatus: null, statusTimer: null, retired: false, idleTimer: null, closing: null,
  };
  attachLead(desk as never);
  const stalledSince = async () =>
    (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!.upstreamStalledSince;
  return { push, handle, stalledSince, interrupts: () => interrupts };
}

console.log("③ 消费链真的挂上了这一档:一条事件都不来的常驻台会被熔断,并留下红环");
{
  const taskId = "team-silence-live";
  const sessId = "sess-live";
  const turnStart = ago(5 * 60_000);
  // 熔断是**请求式**的(往 stdin 写一行),所以宽限期放长:这一段要钉的是「有没有挂上」,
  // 不是兜底回收那一档(那一档在 test:turn-stall 里单独钉)。
  configure({ silentWarnMs: 100, silentTripMs: 500, graceMs: 600_000, pollMs: 200 });
  const desk = await seedDesk(taskId, sessId, turnStart);
  for (let i = 0; i < 60 && desk.interrupts() === 0; i += 1) await sleep(100);
  check(desk.interrupts() === 1,
    `静默档熔断了这一轮(interrupt 次数=${desk.interrupts()});旧代码:一拍都不动`);
  check(!!(await desk.stalledSince()), "红环也投影到库里了(刷新页面后仍看得出来「它卡住了」)");

  // 熔断**之后**来的进展不许把终止义务撤掉(判据与现场见 turn-stall.ts 那一段),但「这一轮
  // 产出过东西」这个事实照样该落盘 —— 它是接管回来之后「别杀它」的唯一依据。
  desk.push({ kind: "text", text: "我在,刚才那条长命令跑完了" });
  for (let i = 0; i < 60 && turnProgress(taskId, sessId, turnStart) !== "seen"; i += 1) await sleep(100);
  check(turnProgress(taskId, sessId, turnStart) === "seen",
    "进展事实落了盘:重启接管回来也不会再被当成零进展杀掉");
  check(!!(await desk.stalledSince()),
    "熔断之后迟到的进展撤不动红环(终止义务只有「真收口」和「退役」两个出口)");
  desk.handle.close();
  for (let i = 0; i < 60 && teamIsLive(taskId); i += 1) await sleep(100);
}

console.log("④ 熔断之前上游开口 → 红环当场撤掉(常驻台跑长工具的那条正常路)");
{
  const taskId = "team-silence-recover";
  const sessId = "sess-recover";
  const turnStart = ago(5 * 60_000);
  // 警告线压到 100ms、熔断线放到 10 分钟:这一段只走「报警 → 上游回话 → 撤」。
  // **阈值要跟回合已经欠的时间比**:这台的回合起点在 5 分钟前,熔断线设成 30 秒的话它当场
  // 就熔断了(欠 300 秒 > 30 秒)—— 红的是夹具而不是判据。
  configure({ silentWarnMs: 100, silentTripMs: 600_000, graceMs: 600_000, pollMs: 200 });
  const desk = await seedDesk(taskId, sessId, turnStart);
  for (let i = 0; i < 60 && !(await desk.stalledSince()); i += 1) await sleep(100);
  check(!!(await desk.stalledSince()), "前提:先报了警并投影出红环(否则下面那条是假绿)");
  desk.push({ kind: "text", text: "在的,这条命令还要跑一会儿" });
  for (let i = 0; i < 60 && (await desk.stalledSince()); i += 1) await sleep(100);
  check(!(await desk.stalledSince()),
    "来了一条真产出 → 红环撤掉(撤的是置上它的那一刻,CAS 才匹配得上)");
  check(desk.interrupts() === 0, `还没到熔断线,一次都没终止(interrupt 次数=${desk.interrupts()})`);
  desk.handle.close();
  for (let i = 0; i < 60 && teamIsLive(taskId); i += 1) await sleep(100);
}

dbClient.close();
releaseTmpDb();
if (failures) {
  console.error(`\n✗ ${failures} 项未通过`);
  process.exit(1);
}
console.log("\n✓ 团队静默档全部通过");
process.exit(0);
