// 看门狗熔断掉的那一轮**最后显示成什么**:落位优先级。
// 跑:npm -w server run test:stall-settle
//
// 判据与两档动手在 `src/turn-stall.ts`,结论怎么保存在 `src/turn-stall-verdict.ts`,这里钉的是
// 最后一段 —— 那个结论进到**统一落位**(`settleTaskStatus`)之后有没有兑现。
//
// 起因(第 3 轮审查 F1,已实测):上一版只把熔断折算成一个非零退出码。可落位里 `question` /
// `resumePrompt` / `goalTurn` 三支都排在 `exitStatus !== 0` **前面**,于是一个留过续跑指令的
// 普通回合最后显示「暂停中 + 继续」,而同一轮的区间记 failed —— 用户看到的那个结论说它在等人,
// 实际上它是被我们杀掉的。退出码表达不了「为什么结束」,所以原因得结构化地传进来。
//
// 反面同样要钉住:**真人按下的停止比看门狗的结论更该被尊重**,终态续聊「只能变好不会变差」
// 的既有契约也不许被这一条撞翻。
//
// 末尾那一段钉的是另一件事(第 1 轮审查 F2,已实测):这条优先级原先在**两处各写了一份**,
// 正常结算用分支顺序、启动对账用一行三元表达式。两份一漂,同一个事实就按进了哪个入口给出两种
// 结论 —— 一个已完成的任务被一次失败续聊打断,不重启收尾保住 `done`,重启收尾却整个降成
// `failed`,而用户那边唯一的区别只是 ash 有没有重启。现在两个入口共用同一个纯函数
// (`settle-landing.ts`),所以这一段直接把那张优先级表逐行钉住 —— 跨进程那一侧的端到端由
// `test:stall-restart` 的场景⑨钉。
//
// 库用临时文件(**绝不碰生产库**),所以 env 必须在 import 那些摸库的模块**之前**设好。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 纯类型,静态引进来不碰库(类型擦除,不会在设 env 之前加载那条链)。
import type { SettleExecutionReason } from "../src/settle-status.js";

const stage = mkdtempSync(join(tmpdir(), "ash-stall-settle-"));
process.env.ASH_DB = join(stage, "t.db");
process.env.HARNESS_DB = process.env.ASH_DB;

const { db, ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const { tasks } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { settleTaskStatus } = await import("../src/settle-status.js");

const STALL: SettleExecutionReason = { kind: "tripped", detail: "已自动终止本回合并按失败结算:只收到错误事件" };
const AT = "2026-10-30T07:36:21.000Z";
let seq = 0;

/** 每个场景一个干净的任务行:落位会改 status、消费 goalTurn 这类一次性标记。 */
async function task(patch: Partial<typeof tasks.$inferInsert> = {}): Promise<string> {
  const id = `t-${(seq += 1)}`;
  await db.insert(tasks).values({
    id, projectId: "proj-stall-settle", title: "熔断落位", body: "", status: "running",
    createdAt: AT, updatedAt: AT, ...patch,
  });
  return id;
}
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

// ── ① 留过续跑指令的普通回合:熔断了就是失败,不是检查点暂停 ─────────────────────
// 这是审查实测的那一例:同样的输入、同样被杀的句柄(exit 0),只差有没有续跑指令,旧版一个
// 落 failed、一个落「暂停中 + 继续」。
{
  const id = await task({ resumePrompt: "继续处理尚未完成的目标" });
  const settled = await settleTaskStatus(id, 1, null, undefined, STALL);
  assert.equal(settled.status, "failed", "熔断掉的回合被当成检查点暂停了 —— 顶栏会显示「暂停中 + 继续」");
  assert.match(settled.note ?? "", /上游连不上/, "落位说明没讲清为什么失败");
  assert.match(settled.note ?? "", /不是检查点暂停/, "落位说明没把它和「在等」区分开");
  // **续跑材料一个字不动**:落 failed 不许顺手清掉它,点重试还得从中断处接着跑。
  assert.equal((await row(id)).resumePrompt, "继续处理尚未完成的目标", "熔断把续跑指令清掉了");
  assert.equal((await row(id)).status, "failed", "库里的状态跟返回值不一致");
}

// ── ② 对照:同一个回合,没有熔断就照旧是检查点暂停 ───────────────────────────────
// 既有契约不许被上一条撞翻 —— agent 自己调 pause_task 留下的检查点仍然是「在等」。
{
  const id = await task({ resumePrompt: "继续处理尚未完成的目标" });
  const settled = await settleTaskStatus(id, 0, null);
  assert.equal(settled.status, "paused", "普通检查点回合不该被改成失败");
}

// ── ③ 提问也不例外:问题留着,但这一轮是失败的 ───────────────────────────────────
// 落 failed 不挡答复:`/answer` 只拦 running/queued(task-answer.ts),所以答复照旧能把它叫起来。
{
  const id = await task({ question: "这两条路选哪一条?" });
  const settled = await settleTaskStatus(id, 1, null, undefined, STALL);
  assert.equal(settled.status, "failed", "熔断掉的回合因为挂着问题落了 paused");
  assert.equal((await row(id)).question, "这两条路选哪一条?", "熔断把待答复的问题清掉了");
}

// ── ④ 持续目标同理 ──────────────────────────────────────────────────────────────
{
  const id = await task({ goalTurn: true });
  const settled = await settleTaskStatus(id, 1, null, undefined, STALL);
  assert.equal(settled.status, "failed", "持续目标回合熔断后落了 paused");
}

// ── ⑤ 真人按下的停止优先:它比看门狗的结论更该被尊重 ─────────────────────────────
{
  const id = await task({ resumePrompt: "继续" });
  const canceled = await settleTaskStatus(id, 1, "canceled", undefined, STALL);
  assert.equal(canceled.status, "canceled", "用户点了停止,却按熔断记成失败");
  const paused = await settleTaskStatus(await task(), 1, "paused", undefined, STALL);
  assert.equal(paused.status, "paused", "分组被暂停,却按熔断记成失败");
}

// ── ⑥ 终态续聊「只能变好,不会变差」:状态回原样,但话要说准 ───────────────────────
// 第 3 轮审查明确不要求把终态续聊改成 failed。要改的只是措辞:退出码是我们自己合成的,
// 照原样念「异常结束(退出码 1)」会让人去查一个不存在的崩溃。
{
  const id = await task({ status: "done", followUpFrom: "done" });
  const settled = await settleTaskStatus(id, 1, null, undefined, STALL);
  assert.equal(settled.status, "done", "续聊回合熔断把一个已完成的任务打成了失败");
  assert.match(settled.note ?? "", /上游连不上/, "续聊的收尾说明还在念那个合成的退出码");
  assert.doesNotMatch(settled.note ?? "", /退出码/, "续聊的收尾说明还在念那个合成的退出码");
}

// ── ⑦ 续聊回合被我们自己杀掉,就不许凭那个确认把任务升级成「已完成」 ─────────────
// 第 2 轮审查 F2(已实测):⑥ 那一条只挡住了「failed 打翻 done」,反方向还开着 —— 一个
// **原本 failed** 的任务续聊,agent 在被杀之前(或上一轮)留下过完成确认,于是 `confirmed`
// 为真,落位照原样把它升级成 done、清掉 followUpFrom 并消费掉续跑材料。那一轮压根没跑完:
// 是看门狗判它上游连不上、把它终止的。「只能变好不会变差」说的是**保持原状态**,不是
// 「拿一个没兑现的确认换个更好的结论」。
{
  const id = await task({
    status: "failed", followUpFrom: "failed",
    completeConfirmedAt: AT, resumePrompt: "继续处理尚未完成的目标",
  });
  const settled = await settleTaskStatus(id, 1, null, undefined, STALL);
  assert.equal(settled.status, "failed", "我们自己杀掉的那一轮,靠一个没兑现的确认升级成了「已完成」");
  const after = await row(id);
  assert.equal(after.status, "failed", "库里的状态跟返回值不一致");
  // 升级那一支顺带会清掉续跑材料并广播一句,所以得连着钉:材料还在,点重试才接得上。
  assert.equal(after.resumePrompt, "继续处理尚未完成的目标", "熔断的续聊回合把续跑指令当成功消费掉了");
}

// ── ⑧ 对照:同一个 failed 续聊,**没有**熔断时照旧能升级成 done ──────────────────
// 上一条只许拦住「被我们杀掉的那一轮」。正常跑完并确认完成的续聊,既有契约不许动。
{
  const id = await task({ status: "failed", followUpFrom: "failed", completeConfirmedAt: AT });
  const settled = await settleTaskStatus(id, 0, null);
  assert.equal(settled.status, "done", "正常确认完成的续聊回合升级不上去了 —— 上一条拦过头了");
}

// ── ⑨ 落位优先级表本体:两个入口共用的那一份(第 1 轮审查 F2) ────────────────────
// 纯函数,逐行钉。四个轴都不给默认值是刻意的(见 settle-landing.ts),所以这里每条都写全 ——
// 将来多一个轴,这几行会跟两个调用点一起编译不过。
{
  const { failedTurnLanding } = await import("../src/settle-landing.js");
  const landing = (facts: Partial<Parameters<typeof failedTurnLanding>[0]>) => failedTurnLanding({
    ashFailed: false, followUpFrom: null, queueAdvancePrev: null, goalHeld: false, ...facts,
  });
  // ① 终态续聊回到原终态 —— 而且它压过 ash 判的失败:回合失败和任务此前的成果是两个轴。
  assert.equal(landing({ followUpFrom: "done" }), "done", "终态续聊没回到原终态");
  assert.equal(landing({ followUpFrom: "done", ashFailed: true }), "done",
    "一次被我们熔断的续聊把整个已完成的任务降成了失败 —— 续聊的契约是「只能变好,不会变差」");
  assert.equal(landing({ followUpFrom: "paused" }), "paused",
    "旁路回合恢复的不止三个终态,这一支不能只认 done/failed");
  // ② ash 判的失败压过残留的队列占位和持续目标 —— 那两句话都替用户表达了「它在等你」。
  assert.equal(landing({ ashFailed: true, queueAdvancePrev: "backlog" }), "failed",
    "一条残留的起跑请求把一轮确凿的失败落回了「尚未起跑」");
  assert.equal(landing({ ashFailed: true, goalHeld: true }), "failed",
    "持续目标那一支把我们自己判的失败说成了「暂停中 + 继续」");
  // ③④⑤ 没有 ash 失败时,后两条按序生效;都没有就是 failed。
  assert.equal(landing({ queueAdvancePrev: "backlog" }), "backlog", "压根没起跑的一轮留下了失败记录");
  assert.equal(landing({ queueAdvancePrev: "backlog", goalHeld: true }), "backlog",
    "队列占位该排在持续目标前面:这一轮连开始都没开始");
  assert.equal(landing({ goalHeld: true }), "paused", "持续目标留住了却不是 paused,/goal resume 接不上");
  assert.equal(landing({}), "failed", "什么都没有的一轮失败,落位不是 failed");
}

console.log("test:stall-settle ok：熔断排在被动检查点之前、真人停止之后,续跑材料与两个方向的终态续聊契约都没动,落位优先级只有一份");
