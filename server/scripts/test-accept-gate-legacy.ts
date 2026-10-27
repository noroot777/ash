// 「已经撤回的那一代结论，不许在读取边界重新变成事实」—— 第 2 轮审查 F1 的那组反例。
//
// 为什么要这组：第 10 轮把「这条命令一行都没跑到、不要为它改代码」撤了，可撤回只管得住
// **生成侧**。撤回之前落盘的那些结论原封不动躺在库里，刷新验收卡、在验收台上再交一次、
// 跨机迁入时照旧原样端出来 —— 审查用上一轮那两条真实诊断实测：`missAttribution` 已经被
// 归一成 unknown 了，`failure=command_missing` 和「一行都没跑到 / main 上也找不到」却还在
// 卡片和交接文本里，卡片顶上写着「证明不了它一行都没跑到」，正文照旧断言它一行没跑。
//
// 现在的闸在 `gateView`（**所有消费点都从那儿拿**）：结论落盘时连代号一起记，读的时候只认
// 当代那一份，代号不匹配就降成 `legacyDiagnosis`（只给人查证、带失效说明、不进正式输入）。
// 这个文件钉的就是那一闸的四件事：
//
//   A 旧代 + 已经撤掉的枚举（command_missing / not-mine）→ 全部不承担当前事实；
//   B 旧代 + 当代仍合法的枚举（exit_code / mine）→ 真实观测留着，结论和归因一起作废
//     （审查明说「修复不应只针对一种枚举组合」）；
//   C 当代行照常承担事实；
//   D 代号**不匹配**就失效，不是「非空就算当代」—— 这是下一次撤回能自动生效的唯一机关；
//   E 跨机那条路把代号搬过去，旧 payload 没这个字段就按旧代待。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ACCEPT_GATE_DIAGNOSIS_GENERATION, summarizeAcceptGate } from "@ash/shared/accept-gate";
import { db } from "../src/db/index.js";
import { acceptGateRuns } from "../src/db/schema.js";
import { gateView } from "../src/accept-gate-state.js";
import { gateFailureInputFor } from "../src/accept-gate-messages.js";
import { gateHandoffTimeline } from "../src/accept-gate-handoff.js";
import { collectGateRuns, replaceGateRuns, validateGatePayload } from "../src/handoff-accept-gate.js";
import type { HandoffManifest } from "../src/handoff-types.js";

type Ctx = { makeRepo: (name: string) => string; createdAt: string };

/** 旧代那段结论的原文（取第 9 轮真实落盘的措辞，不是为这组用例手写的）。 */
const OBSOLETE = "这条命令点名要跑的 npm 脚本 `test:accept` 在被测快照里压根不存在：它要测的东西一行都没跑到，"
  + "这不是某条断言失败。判据：被测快照 package.json 的 scripts 里没有 test:accept。"
  + "目标分支 main 上也找不到它，所以合目标分支进来也不会把它带回来。"
  + "这件事看起来跟本次改动无关，不要为这件事改任何代码。";

const CURRENT = "这条命令点名要跑的 npm 脚本 `test:accept` 在被测快照里解析不出来（起跑前核过）。"
  + "这句话到此为止：ash 证明不了它一行都没跑到。";

export async function testGateLegacyDiagnosis(ctx: Ctx): Promise<void> {
  const repo = ctx.makeRepo("gate-legacy");
  mkdirSync(join(repo, "logs"), { recursive: true });
  const taskId = "gatelegacy1";

  // 日志原文照旧保留（审查只要求它不再承担当前结论），所以这儿也写一份真的日志文件：
  // 卡片和交接拿它当「自己去核」的落脚点。
  let seq = 0;
  const seed = async (over: Partial<typeof acceptGateRuns.$inferInsert>) => {
    const id = `legacy-run-${++seq}`;
    const logPath = join(repo, "logs", `${id}.log`);
    writeFileSync(logPath, `npm error Missing script: "test:accept"\n[ash] ${OBSOLETE}\n`);
    await db.insert(acceptGateRuns).values({
      id, taskId, projectId: "legacy-project", command: "npm run test:accept", cwd: join(repo, "snapshot"),
      status: "failed", exitCode: 1, logPath, startedAt: ctx.createdAt, finishedAt: ctx.createdAt, ...over,
    });
    return (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, id))).at(0)!;
  };

  // ── A：旧代 + 已经撤掉的那两个枚举 ──
  const oldRow = await seed({ failure: "command_missing", missAttribution: "not-mine", diagnosis: OBSOLETE });
  const old = gateView(oldRow);
  assert.equal(old.diagnosis, null, "旧代结论不许再当当前诊断（审查二 F1）");
  assert.equal(old.legacyDiagnosis, OBSOLETE, "原文要留着给人查证，只是降成历史");
  assert.equal(old.failure, null, "撤掉的类别本身就是旧判据的结论，归一成「没有具体分类」");
  assert.equal(old.missAttribution, null, "归因跟那段文字同一次推断出来的，一起作废");
  const oldSummary = summarizeAcceptGate(old);
  assert.match(oldSummary, /未通过/, "摘要照实说未通过");
  assert.equal(/undefined|rc=/.test(oldSummary), false, "不许漏出 undefined，也不许拿旧类别带出 rc");

  const oldPrompt = gateFailureInputFor(old, repo);
  // **日志尾巴要照原样贴**（审查：原始日志可保留供查证），而当初那段结论正是 `appendGateLog`
  // 写进日志里的，所以它必然出现在围栏那一段里。要钉的是「它不再以当前结论的身份出现」，
  // 所以把贴进去的那段日志先剥掉，再核剩下的正文。
  assert.ok(old.logTail.includes(OBSOLETE), "测试自己的前提：旧记录的日志里确实还留着那段话");
  const oldBody = oldPrompt.split(old.logTail.trim()).join("");
  for (const claim of ["一行都没跑到", "找不到它", "不要为这件事改任何代码"]) {
    assert.equal(oldBody.includes(claim), false, `正文里绝不许再出现「${claim}」`);
  }
  assert.match(oldPrompt, /判据已撤回/, "日志里那段还在，所以必须在正文里说破它已经失效");
  assert.match(oldPrompt, /定位到底是哪一条红的/, "照旧让它去定位、去修");

  const oldTimeline = gateHandoffTimeline(old, oldRow.logPath, true);
  assert.match(oldTimeline, /这一次名下那段旧版本的结论已失效/, "时间线是 append-only 的，失效要在这儿说破");
  assert.equal(/它会先核这件事/.test(oldTimeline), false, "旧代归因已作废，不许再说「它会先核归因这件事」");

  // ── B：旧代 + 当代仍然合法的枚举（审查：别只针对一种组合） ──
  const mixed = gateView(await seed({ failure: "exit_code", missAttribution: "mine", diagnosis: OBSOLETE }));
  assert.equal(mixed.failure, "exit_code", "退出码是真实观测，不随代号作废");
  assert.equal(mixed.diagnosis, null, "exit_code/mine 这一组的旧结论同样失效");
  assert.equal(mixed.legacyDiagnosis, OBSOLETE);
  assert.equal(mixed.missAttribution, null, "旧代的 mine 也不许再指认这次改动");
  const mixedPrompt = gateFailureInputFor(mixed, repo);
  assert.equal(mixedPrompt.split(mixed.logTail.trim()).join("").includes("一行都没跑到"), false,
    "exit_code/mine 这一组的正文同样不许带旧断言");
  assert.match(mixedPrompt, /判据已撤回/);

  // ── C：当代行照常承担事实 ──
  const fresh = gateView(await seed({ failure: "exit_code", missAttribution: "unknown", diagnosis: CURRENT,
    diagnosisGeneration: ACCEPT_GATE_DIAGNOSIS_GENERATION }));
  assert.equal(fresh.diagnosis, CURRENT, "当代结论照旧是当前诊断");
  assert.equal(fresh.legacyDiagnosis, null, "当代的不许被摆成历史");
  assert.equal(fresh.missAttribution, "unknown");
  const freshPrompt = gateFailureInputFor(fresh, repo);
  assert.ok(freshPrompt.includes(CURRENT), "当代结论要进正式输入");
  assert.equal(freshPrompt.includes("判据已撤回"), false, "当代那份不该挂失效提醒");
  assert.match(gateHandoffTimeline(fresh, repo, false), /它会先核这件事/);

  // ── D：**代号不匹配**才是判据，不是「非空就算当代」 ──
  // 这一条钉的是下一次撤回能不能自动生效：实现成「有代号就认」的话，今天这批结论会在判据
  // 再改一次之后继续当事实，而那正是这条审查意见本身。
  const forged = gateView({ ...oldRow, diagnosis: CURRENT, missAttribution: "mine",
    diagnosisGeneration: `${ACCEPT_GATE_DIAGNOSIS_GENERATION}-next` });
  assert.equal(forged.diagnosis, null, "别的代号（含将来的代号）一律不承担当前事实");
  assert.equal(forged.legacyDiagnosis, CURRENT);
  assert.equal(forged.missAttribution, null);

  // ── E：跨机那条路 ──
  const exported = await collectGateRuns(taskId);
  const freshExport = exported.find(row => row.diagnosisGeneration === ACCEPT_GATE_DIAGNOSIS_GENERATION);
  assert.ok(freshExport, "导出要把代号带上，不然对端会把一份当代结论当成失效历史");
  assert.equal(exported.filter(row => row.diagnosisGeneration == null).length, 2,
    "上面 seed 的两行旧代记录照实导出成空代号");

  const manifest = (payload: unknown[]) => ({
    task: { id: taskId }, targetProjectId: "legacy-project", files: [], acceptGateRuns: payload,
  } as unknown as HandoffManifest);
  validateGatePayload(manifest(exported));
  assert.throws(() => validateGatePayload(manifest([{ ...freshExport, diagnosisGeneration: 7 }])),
    /diagnosisGeneration/, "代号得是字符串，非法 payload 要拦在导入前");

  // 旧机器导出的 payload 里**没有**这个字段：迁入后按旧代待（保守的那一边）。
  await replaceGateRuns(db, manifest([{ ...freshExport, diagnosisGeneration: undefined },
    { ...exported.find(row => row.id === oldRow.id)! }]));
  const imported = await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId));
  assert.equal(imported.length, 2, "迁入要原样替换这个任务名下的记录");
  for (const row of imported) {
    assert.equal(row.diagnosisGeneration, null, "没带代号的 payload 迁入后就是旧代");
    assert.equal(gateView(row).diagnosis, null, "于是对端读出来也不承担当前事实");
  }

  // 带着代号迁入的那一份照旧是当代（同一条路、同一个闸，只差 payload 里有没有那个字段）。
  await replaceGateRuns(db, manifest([freshExport]));
  const again = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId))).at(0)!;
  assert.equal(again.diagnosisGeneration, ACCEPT_GATE_DIAGNOSIS_GENERATION);
  assert.equal(gateView(again).diagnosis, CURRENT, "代号搬过去了，对端就该照常用它");

  await db.delete(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId));
  console.log("accept gate legacy-diagnosis: 旧代结论失效 / 混合枚举 / 当代照常 / 代号必须匹配 / 跨机搬代号 全部通过");
}
