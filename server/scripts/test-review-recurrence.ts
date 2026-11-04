// 同类问题熔断（review-recurrence.ts）：承接声明的校验、谱系计数、熔断指令只在触发轮出现、
// 熔断状态刷新后可见，以及熔断路径上选择题的硬格式校验（choice-question-check.ts）。
//
// 集成那几段走的是真实链路：派审任务书（落下这一轮实际发出去的清单编号）→ report_stage 的业务入口
// （承接在这里校验落库）→ 审查回合收流结算 → 收尾排空把修复交接放进待发送队列。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createWriteStream, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentEvent } from "@ash/shared";
import type { AgentExecutor, RunHandle } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-recurrence-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_LAX_DONE;

try {
  const { parseCarries, lineageLengths, recurrenceLabel, recurrenceListMarkdown, recurrenceRepairNote,
    RECURRENCE_LIST_FILE, RECURRENCE_NOTE_CAP, RECURRENCE_THRESHOLD } = await import("../src/review-recurrence.js");
  const { carryRecurrenceBreaker, recurrenceBreakerArmed } = await import("../src/review-recurrence-gate.js");
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const { checkChoiceQuestion, sentenceCount } = await import("../src/choice-question-check.js");

  // ① 承接校验：匹配的计入；没填、填错、对不上的一律忽略，且从不抛错。
  {
    const sent = new Set(["1.1.1", "1.1.2", "2.3.1"]);
    assert.deepEqual(parseCarries({ "1": "1.1.1", "2": "[2.3.1]" }, 2, sent),
      [{ finding: 1, from: "1.1.1" }, { finding: 2, from: "2.3.1" }], "字段说明教的写法、照抄行首方括号都认");
    assert.deepEqual(parseCarries([{ finding: 1, from: "1.1.2" }], 1, sent), [{ finding: 1, from: "1.1.2" }]);
    assert.deepEqual(parseCarries('{"1":"1.1.1"}', 1, sent), [{ finding: 1, from: "1.1.1" }], "被序列化成字符串也认");
    for (const raw of [undefined, null, "", "不是 JSON", 42, { "1": "9.9.9" }, { "3": "1.1.1" }, { "0": "1.1.1" },
      { "第1条": "1.1.1" }, { "1": 111 }, [{ finding: "x", from: "1.1.1" }], ["1.1.1"]]) {
      assert.deepEqual(parseCarries(raw, 2, sent), [], `读不懂的一律按没填算：${JSON.stringify(raw)}`);
    }
    assert.deepEqual(parseCarries({ "1": "9.9.9", "2": "1.1.2" }, 2, sent), [{ finding: 2, from: "1.1.2" }],
      "一条对不上不连累同一份里对得上的那条");
    assert.deepEqual(parseCarries({ "1": "1.1.1" }, 0, sent), [], "这份报告一条发现都没抽到时，「本轮第 1 条」不存在");
  }

  // ② 谱系计数：按承接链传递、只认紧挨着的上一轮、跨链照算。
  {
    const vf = "verify_failed";
    const chain = lineageLengths([
      { key: "a1", refBase: "1.1", conclusion: vf, carries: [] },
      { key: "a2", refBase: "1.2", conclusion: vf, carries: [{ finding: 1, from: "1.1.2" }] },
      { key: "a3", refBase: "1.3", conclusion: vf, carries: [{ finding: 2, from: "1.2.1" }] },
      // 跨链：第 2 条审查链的第 1 轮承接第 1 条链的最后一轮。
      { key: "b1", refBase: "2.1", conclusion: vf, carries: [{ finding: 1, from: "1.3.2" }] },
    ]);
    assert.equal(chain.get("a1"), undefined);
    assert.deepEqual(chain.get("a2"), { length: 2, findings: [{ finding: 1, length: 2 }] }, `连续 ${RECURRENCE_THRESHOLD} 轮就触发`);
    assert.deepEqual(chain.get("a3"), { length: 3, findings: [{ finding: 2, length: 3 }] },
      "第 N 轮 F2 承接 N-1 轮 F1，N-1 轮 F1 承接 N-2 轮 F2：同一谱系");
    assert.deepEqual(chain.get("b1"), { length: 4, findings: [{ finding: 1, length: 4 }] }, "用户另开的审查链照样接着算");

    // 两条谱系深度不同：A 连着三轮、B 连着两轮，两条都够阈值，都要进触发集合（第 1 轮审查 R1）。
    const mixed = lineageLengths([
      { key: "m1", refBase: "1.1", conclusion: vf, carries: [] },
      { key: "m2", refBase: "1.2", conclusion: vf, carries: [{ finding: 1, from: "1.1.1" }] },
      { key: "m3", refBase: "1.3", conclusion: vf, carries: [{ finding: 1, from: "1.2.1" }, { finding: 2, from: "1.2.2" }] },
    ]);
    assert.deepEqual(mixed.get("m3"), { length: 3, findings: [{ finding: 1, length: 3 }, { finding: 2, length: 2 }] },
      "每一条够阈值的都在，不只是最长的那条");
    assert.ok(recurrenceRepairNote(mixed.get("m3")!).text.includes("报告第 1、2 条"), "修复交接点名两条");

    const broken = lineageLengths([
      { key: "a1", refBase: "1.1", conclusion: vf, carries: [] },
      { key: "a2", refBase: "1.2", conclusion: "verified", carries: [] },
      { key: "a3", refBase: "1.3", conclusion: vf, carries: [{ finding: 1, from: "1.1.1" }] },
    ]);
    assert.equal(broken.size, 0, "中间断一轮（承接的不是紧挨着的上一轮）不触发");
    const gap = lineageLengths([
      { key: "a1", refBase: "1.1", conclusion: vf, carries: [] },
      { key: "a2", refBase: "1.2", conclusion: vf, carries: [] },
      { key: "a3", refBase: "1.3", conclusion: vf, carries: [{ finding: 1, from: "1.2.1" }] },
    ]);
    assert.deepEqual(gap.get("a3"), { length: 2, findings: [{ finding: 1, length: 2 }] }, "上一轮那条自己没有承接：谱系从它算起");
    assert.equal(lineageLengths([
      { key: "a1", refBase: "1.1", conclusion: vf, carries: [] },
      { key: "a2", refBase: "1.2", conclusion: "verified", carries: [{ finding: 1, from: "1.1.1" }] },
    ]).size, 0, "通过的那一轮不算「被标为拦验收」");
  }

  // ②' 熔断指令有上界：条序压成区间；压不住就只报条数、指向外置清单，一条都不截（第 1 轮审查 R4）。
  {
    const of = (findings: number[]) => ({ length: 2, findings: findings.map((finding) => ({ finding, length: 2 })) });
    const ranged = recurrenceRepairNote(of([1, 2, 3, 5, 7, 8]));
    assert.ok(ranged.text.includes("报告第 1–3、5、7、8 条") && !ranged.listed, ranged.text);
    const many = of(Array.from({ length: 40 }, (_, index) => index * 2 + 1));
    const listed = recurrenceRepairNote(many);
    assert.ok(listed.listed && listed.text.includes(RECURRENCE_LIST_FILE), listed.text);
    for (const found of [of([1]), of([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]), many,
      { length: 123, findings: Array.from({ length: 999 }, (_, index) => ({ finding: index * 2 + 1, length: 123 })) }]) {
      assert.ok(bytes(recurrenceRepairNote(found).text) <= RECURRENCE_NOTE_CAP,
        `熔断指令 ${bytes(recurrenceRepairNote(found).text)}B 超过 ${RECURRENCE_NOTE_CAP}B`);
    }
    const list = recurrenceListMarkdown(many, ["第一条现象"]);
    assert.ok(list.includes("报告第 1 条（连续 2 轮）：第一条现象") && list.includes("报告第 79 条"), "清单里每一条都在");
  }

  // ③ 选择题硬格式：含路径 / 标识符 / 分支 / commit / 轮次的被拒并说明；合规的放行。
  {
    const good = {
      question: "这类问题按点修了两次都没收口，需要你定方案。现有做法在三个系统上各要一套判断。",
      options: [
        "统一改成由服务端判断：选它你会多等一天，但以后不会再冒同类问题",
        "保留现在的做法，只补齐剩下的系统：今天就能验收，代价是以后新增系统还得再补",
      ],
    };
    assert.deepEqual(checkChoiceQuestion(good), [], "合规的放行");
    assert.equal(sentenceCount("一句。两句！三句？"), 3);
    const cases: Array<[string, Partial<typeof good>, RegExp]> = [
      ["路径", { question: "要改 server/src/review-history.ts 的判断。" }, /路径或分支名「server\/src\/review-history.ts」/],
      ["文件名", { question: "要改 review-history.ts 的判断。" }, /文件路径/],
      ["驼峰标识符", { options: ["改 parseCarries：你会少一轮", good.options[1]!] }, /代码标识符「parseCarries」/],
      ["蛇形标识符", { options: ["加一列 history_refs：会多一次迁移", good.options[1]!] }, /代码标识符「history_refs」/],
      ["分支名", { options: ["合进 ash/FVo81m14：会快一点", good.options[1]!] }, /分支名/],
      ["commit", { question: "回到 773f06a2 那一版。" }, /commit「773f06a2」/],
      ["轮次", { question: "第 3 轮审查又报了这条。" }, /第 N 轮/],
      ["背景超过两句", { question: "第一句。第二句。第三句。" }, /3 句/],
      ["选项太少", { options: ["只有一个：会怎样"] }, /1 个选项/],
      ["选项太多", { options: ["一会", "二会", "三会", "四会", "五会"] }, /5 个选项/],
      ["没有后果句", { options: ["统一改成服务端判断", good.options[1]!] }, /第 1 个没有后果句/],
      // 第 1 轮审查 R2：中文目录、混排目录、前导下划线标识符、中文文件名。
      ["中文绝对路径", { question: "需要修改 /用户/配置/入口 后再继续。" }, /文件路径「\/用户\/配置\/入口」/],
      ["混排相对路径", { question: "需要修改 src/配置 后再继续。" }, /文件路径「src\/配置」/],
      ["前导下划线", { question: "需要修改 _repair_mode 后再继续。" }, /代码标识符「_repair_mode」/],
      ["双下划线", { options: ["改 __init__：会快", good.options[1]!] }, /代码标识符「__init__」/],
      ["中文文件名", { options: ["改 配置.json：会快", good.options[1]!] }, /文件路径「配置\.json」/],
      ["家目录", { question: "放到 ~/code 下面。" }, /文件路径「~\/code」/],
      // 第 2 轮审查 F3：紧贴中文的绝对路径、`../` 路径、单字目录。
      ["紧贴中文的绝对路径", { question: "请修改/用户/配置后再继续。" }, /文件路径「\/用户\/配置/],
      ["上级目录路径", { question: "路径为../用户/配置，请选择。" }, /文件路径「\.\.\/用户\/配置」/],
      ["单字目录", { question: "需要修改 src/配 后再继续。" }, /文件路径「src\/配」/],
    ];
    for (const [what, patch, expected] of cases) {
      const problems = checkChoiceQuestion({ ...good, ...patch });
      assert.ok(problems.some((problem) => expected.test(problem)), `${what} 应被拒：${problems.join(" | ")}`);
    }
    assert.deepEqual(checkChoiceQuestion({ ...good, question: "macOS 和 iPhone 上表现不一样，需要你定。" }), [],
      "产品名不算代码标识符");
    for (const question of ["要不要启用/禁用自动审查？", "A/B 两种方案选哪个？", "A/B测试要不要做？", "有 50/50 的把握。"]) {
      assert.deepEqual(checkChoiceQuestion({ ...good, question }), [], `口语里的斜杠不算路径：${question}`);
    }
    assert.ok(checkChoiceQuestion({ question: "两件事要定。", options: [],
      items: [{ question: "先定哪个系统。", options: ["先做 macOS：会快"] }] }).some((p) => /第 1 个问题的选项有 1 个选项/.test(p)),
    "多问题时每个子问题各自是一道选择题");
  }

  // ── 集成：真实链路 ──────────────────────────────────────────────────────────────
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, projects, reviewerProfiles, scheduledMessages, sessions, tasks } =
    await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { consumeSingleRun } = await import("../src/single-run.js");
  const { freeWorkflowState, reportFreeReviewConclusion } = await import("../src/free-workflow.js");
  const { freeManualRepairPrompt, freeReviewPrompt } = await import("../src/free-review-prompts.js");
  const { freeReviewEvidenceDir, freeReviewReportPath } = await import("../src/free-review-files.js");
  const { evidenceState } = await import("../src/regression-evidence-lifecycle.js");
  const { claimOwnTurn, releaseTurn, turnRole } = await import("../src/runs.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { mountTaskQuestionRoutes } = await import("../src/task-question-routes.js");
  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "recurrence", repoPath: root, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "test", type: "codex", model: "test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "reviewer", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });
  const id = "recur";
  await createTasks([{
    id, projectId: "p", title: id, body: "test", mode: "single", status: "done",
    agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
    useWorktree: false, createdAt: at, updatedAt: at,
  }]);
  // 审查回合的 turn **整场只占一次、不放开**：放开的那一刻，结算放进待发送队列的修复交接就会被
  // 投递、真把执行者拉起来（`pending-messages.ts` 的 whenTurnIdle）。这里只验「交接里写了什么」。
  let owner = claimOwnTurn(id, "reviewer");
  assert.ok(owner, "审查回合占得到 turn");
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const report = (lines: string[]) => "## 结论\n\n**能不能验收**：不能。\n\n**必须修的问题**：\n\n" +
    lines.map((line, index) => `### ${index + 1}\n- 你会遇到：${line}\n- 为什么：机制。\n- 建议怎么修：修法。\n`).join("\n");

  /** 开一轮审查（审查回合占着 turn），并按真实派审拼一次任务书 —— 那一刻落下清单编号。 */
  async function openRound(runId: string, round: number, createdAt: string, retryLimit: number) {
    const existing = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId)))[0];
    if (existing) {
      await db.update(freeReviewRuns).set({ currentRound: round, status: "reviewing" }).where(eq(freeReviewRuns.id, runId));
    } else {
      await db.insert(freeReviewRuns).values({
        id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
        executorId: "ex", checkMode: "logic", retryLimit, currentRound: round, status: "reviewing",
        targetKind: "workspace", createdAt, updatedAt: createdAt,
      });
    }
    await db.insert(freeReviewRounds).values({ id: `${runId}-${round}`, runId, round, status: "reviewing", startedAt: at });
    const sessId = `${runId}-${round}-reviewer`;
    await db.insert(sessions).values({
      id: sessId, taskId: id, role: "reviewer", agentType: "codex", executor: "test", cwd: root, startedAt: at, turnStartedAt: at,
    });
    await evidenceState(id, freeReviewEvidenceDir(id, runId, round), await taskRow());
    const run = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId)))[0]!;
    const prompt = await freeReviewPrompt(await taskRow(), run, round, root);
    return { sessId, prompt };
  }

  /** 审查者交卷（报告 + 带承接的结论）后正常退出，走真实收流与结算。 */
  async function finishRound(
    runId: string, round: number, opened: { sessId: string },
    findings: string[], recurs?: unknown,
  ) {
    const { sessId } = opened;
    const path = freeReviewReportPath(id, runId, round);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, report(findings));
    await reportFreeReviewConclusion(id, "verify_failed", { recurs });
    const transcript = sessionTranscriptPath(id, sessId);
    mkdirSync(dirname(transcript), { recursive: true });
    const out = createWriteStream(transcript, { flags: "a" });
    const closed = once(out, "close");
    const handle: RunHandle = {
      sessionId: "", commandLine: "fixture", kill() {},
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { kind: "text", text: "审查完毕。" };
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
    const executor: AgentExecutor = {
      type: "codex", label: "fixture", run: () => handle,
      resumeCommand: () => "", resumeFields: () => ({ resumeCommand: "", resumeEnv: null, resumeArgs: null }),
    };
    await consumeSingleRun({
      taskId: id, sessId, agentType: "codex", ex: executor, cwd: root, handle, out,
      turnStart: at, cliSessionId: "", autoTitle: false, role: "reviewer",
    });
    await closed;
  }
  const repairs = async () => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, id)))
    .filter((row) => row.origin?.startsWith("review-settlement:"));
  const timeline = () => readdirSync(dirname(sessionTranscriptPath(id, "x")))
    .filter((name) => name.endsWith(".md") || name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(dirname(sessionTranscriptPath(id, "x")), name), "utf8")).join("\n");
  const label = (length: number) => recurrenceLabel(length);

  // 第 1 条链第 1 轮：没有历史，清单为空、也就没有可引用的编号；照常修复，交接里没有熔断指令。
  const first = await openRound("run-a", 1, "2026-11-01T00:00:00.000Z", 3);
  assert.ok(!first.prompt.includes("recurs"), "第一轮没有清单，审查者侧一个字都不多发");
  await finishRound("run-a", 1, first, ["保存后列表没刷新", "切换项目时筛选丢失"], { "1": "1.0.1" });
  assert.equal((await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, "run-a-1")))[0]!.carries, null,
    "引用对不上：按不是复发处理，结论照收");
  assert.equal((await repairs()).length, 1);
  assert.ok(!(await repairs())[0]!.text.includes("已熔断"), "没熔断的那一轮，修复交接里没有熔断指令");
  const { reviewDeliveryFrom } = await import("../src/review-ownership.js");
  // 回合起跑：世代 +1（真实起跑由 turnDirectionStart 推），再按来源决定熔断闸续不续（continueTask 里那一句）。
  let epoch = 0;
  const start = async (source: Parameters<typeof carryRecurrenceBreaker>[1]) => {
    epoch += 1;
    await db.update(tasks).set({ directionEpoch: epoch }).where(eq(tasks.id, id));
    await carryRecurrenceBreaker(id, source);
    return recurrenceBreakerArmed(id, epoch);
  };
  assert.equal(await start({ reviewDelivery: reviewDeliveryFrom((await repairs())[0]!) }), false,
    "没熔断那一轮的修复送进去，提问闸不开");

  // 第 2 轮：清单里带编号；承接第 1 轮第 2 条 → 连续 2 轮 → 熔断。
  const second = await openRound("run-a", 2, "2026-11-01T00:00:00.000Z", 3);
  assert.ok(second.prompt.includes("[1.1.2]") && second.prompt.includes("recurs"), "清单行首有编号，紧跟一句怎么填");
  assert.deepEqual((await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, "run-a-2")))[0]!.historyRefs,
    ["1.1.1", "1.1.2"], "这一轮实际发出去的编号落库");
  await finishRound("run-a", 2, second, ["切换项目后筛选还是丢", "导出按钮无反应"], { "1": "1.1.2", "2": "1.1.9" });
  assert.deepEqual((await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, "run-a-2")))[0]!.carries,
    [{ finding: 1, from: "1.1.2" }], "只落校验通过的那一条");
  const breakerRepair = (await repairs()).at(-1)!;
  assert.equal((await repairs()).length, 2);
  assert.ok(breakerRepair.text.includes(`【${label(2)}】报告第 1 条`), `熔断轮的修复交接带指令：${breakerRepair.text}`);
  assert.ok(breakerRepair.text.includes("ask_question") && breakerRepair.text.includes("dispute_review"),
    "二选一的出路在，驳回的权利也照旧在");
  assert.ok(timeline().includes(label(2)), "时间线上留了一条");
  // 熔断交接开跑那一刻，这个世代记到那一轮上。
  assert.equal(await start({ reviewDelivery: reviewDeliveryFrom(breakerRepair) }), true, "熔断交接送进去：提问闸开");
  assert.equal((await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, "run-a-2")))[0]!.breakerEpoch,
    epoch, "从投递收据反查到熔断那一轮");
  const breakerEpoch = epoch;

  // 刷新后可见：重新读状态接口，审查记录那一轮带着熔断状态，没熔断的轮次没有。
  const state = await freeWorkflowState(id);
  const rounds = state.reviews.find((run) => run.id === "run-a")!.rounds;
  assert.equal(rounds.find((round) => round.round === 2)?.recurrence, 2);
  assert.equal(rounds.find((round) => round.round === 1)?.recurrence, undefined);

  // 熔断路径上的 ask_question：不合格的被退回并说明，合格的放行（过了格式闸才轮到回合身份那几道）。
  // 提问来自执行者回合，所以先把审查回合放开 —— 放开之前把待发送的修复交接清掉（内容上面已经验过），
  // 否则那一刻它就会被投递、真把执行者拉起来。
  {
    await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, id));
    releaseTurn(id, owner!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(turnRole(id), null, "没有别的回合趁机占上");
    const api = new Hono();
    mountTaskQuestionRoutes(api);
    // 执行者回合的身份（每次起跑换一组 token，世代由 start 推）。
    const enter = async () => db.update(tasks).set({
      status: "running", activeTurnToken: `turn-${epoch}`, activeDirectionToken: `dir-${epoch}`, activeDirectionVersion: 1,
      question: null, questionOptions: null, questionItems: null,
    }).where(eq(tasks.id, id));
    await enter();
    assert.equal((await taskRow()).directionEpoch, breakerEpoch);
    const ask = async (body: unknown) => {
      const { activeTurnToken, activeDirectionToken } = await taskRow();
      return api.request(`/tasks/${id}/ask`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(activeTurnToken ? { "x-ash-turn-token": activeTurnToken } : {}),
          ...(activeDirectionToken ? { "x-ash-direction-token": activeDirectionToken } : {}),
        },
        body: JSON.stringify(body),
      });
    };
    const bad = await ask({ question: "第 2 轮又报了 parseCarries 的问题。", options: ["改掉"] });
    assert.equal(bad.status, 400);
    const error = ((await bad.json()) as { error: string }).error;
    assert.match(error, /第 N 轮/);
    assert.match(error, /parseCarries/);
    assert.match(error, /后果句/);
    const fine = await ask({
      question: "这类问题按点修了两次都没收口，需要你定方案。",
      options: ["统一改成服务端判断：选它你会多等一天", "只补齐剩下的地方：今天就能验收，代价是以后还得补"],
    });
    assert.notEqual(fine.status, 400, "合规的选择题不被格式闸拦");
    // 第 2 轮审查 F2：同一份修复停在检查点、被续跑 / 哨兵 / 重试叫醒 —— 世代换了，闸照样开。
    const badQuestion = { question: "第 2 轮 parseCarries 需要你决定。", options: ["改掉"] };
    // 中间夹一次原生命令（`/compact`）：它不改方向，之后的检查点续跑照样接得回来（第 2 次审查第 1 轮 F1）。
    for (const source of [{ system: "run" }, { monitorWake: { monitorId: "m" } }, { native: true }, { system: "run" }, { system: "retry" }]) {
      assert.equal(await start(source), true, `系统续跑继承熔断修复：${JSON.stringify(source)}`);
      await enter();
      assert.equal((await ask(badQuestion)).status, 400, `续跑之后不合格的题照样退回：${JSON.stringify(source)}`);
    }
    // 第 1 轮审查 R3：用户裁定之后让它干别的（新消息 / 答复 / 改派）—— 新方向，普通澄清题不再被逼成选择题；
    // 之后的系统续跑接的是这个新方向，也不把闸续回来。
    assert.equal(await start({}), false, "用户的新方向：闸落下");
    await enter();
    const ordinary = await ask({ question: "你希望新页面展示哪些内容？" });
    assert.notEqual(ordinary.status, 400, `换了方向，熔断提问闸落下：${await ordinary.clone().text()}`);
    assert.equal(await start({ system: "run" }), false, "新方向之后的续跑不把闸续回来");
    await db.update(tasks).set({ status: "done", question: null, questionOptions: null, questionItems: null,
      activeTurnToken: null, activeDirectionToken: null, activeDirectionVersion: 0 }).where(eq(tasks.id, id));
    owner = claimOwnTurn(id, "reviewer");
    assert.ok(owner, "审查回合重新占得到 turn");
  }

  // 用户另开一条审查链（「再审一轮」）：清单跨链，承接第 1 条链第 2 轮第 1 条 → 第 3 轮未收口。
  // 这条链轮数为 0，没有自动修复；手动「按意见修复」那条交接同样带指令。
  const third = await openRound("run-b", 1, "2026-11-02T00:00:00.000Z", 0);
  assert.ok(third.prompt.includes("[1.2.1]"), "跨链的条目照样带编号");
  await finishRound("run-b", 1, third, ["切换项目后筛选仍然丢失"], [{ finding: 1, from: "1.2.1" }]);
  assert.equal((await repairs()).length, 0, "轮数用完：不自动投递修复");
  assert.ok(timeline().includes(label(3)), "跨链熔断同样写进时间线");
  const runB = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "run-b")))[0]!;
  assert.ok((await freeManualRepairPrompt(id, runB)).includes(`【${label(3)}】`), "手动修复交接也带熔断指令");
  const manualA = await freeManualRepairPrompt(id,
    (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "run-a")))[0]!, { round: 1 });
  assert.ok(!manualA.includes("已熔断"), "修的是没熔断的那一轮时不带");
  assert.equal((await freeWorkflowState(id)).reviews.find((run) => run.id === "run-b")!.rounds[0]!.recurrence, 3);
  // 手动修复点名哪一轮，提问闸就认哪一轮：和交接里带不带指令是同一个判据。
  assert.equal(await start({ recurrenceRound: { runId: "run-a", round: 1 } }), false, "修没熔断的历史轮：闸不开");
  assert.equal(await start({ recurrenceRound: { runId: "run-b", round: 1 } }), true, "修熔断的那一轮：闸开");
  assert.equal(await start({}), false, "下一轮审查起跑（不是修复交接、也不是系统续跑）：闸落下");

  // 触发条目多到指令里放不下：完整清单落到报告同目录，指令只报条数，整段仍在上限内（第 1 轮审查 R4）。
  {
    const total = 41;
    const findings = Array.from({ length: total }, (_, index) => `第 ${index + 1} 处现象`);
    const carried = Array.from({ length: 20 }, (_, index) => index * 2 + 1);
    for (const round of [1, 2]) {
      const path = freeReviewReportPath(id, "run-c", round);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, report(findings));
    }
    await db.insert(freeReviewRuns).values({
      id: "run-c", taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 0, currentRound: 2, status: "failed",
      targetKind: "workspace", createdAt: "2026-11-03T00:00:00.000Z", updatedAt: at,
    });
    await db.insert(freeReviewRounds).values([1, 2].map((round) => ({
      id: `run-c-${round}`, runId: "run-c", round, status: "failed", conclusion: "verify_failed", startedAt: at,
      carries: round === 2 ? carried.map((finding) => ({ finding, from: `3.1.${finding}` })) : null,
    })));
    const runC = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "run-c")))[0]!;
    const prompt = await freeManualRepairPrompt(id, runC);
    const start = prompt.indexOf(`\n\n【${label(2)}】`);
    const note = prompt.slice(start, prompt.indexOf("\n", start + 4) + 1);
    assert.ok(note.includes(`这 ${carried.length} 条`) && note.includes(RECURRENCE_LIST_FILE), note);
    assert.ok(bytes(note) <= RECURRENCE_NOTE_CAP, `真实投递里的熔断指令 ${bytes(note)}B`);
    const listPath = join(freeReviewEvidenceDir(id, "run-c", 2), RECURRENCE_LIST_FILE);
    const list = readFileSync(listPath, "utf8");
    for (const finding of carried) assert.ok(list.includes(`报告第 ${finding} 条（连续 2 轮）：第 ${finding} 处现象`), list);

    // 第 2 轮审查 F1：清单那个位置已经被换成指向证据根外的符号链接 / 硬链接 —— 重新生成替换的是
    // 目录项本身，根外那份一个字节不动。
    const outside = mkdtempSync(join(tmpdir(), "ash-recurrence-outside-"));
    try {
      for (const link of ["symlink", "hardlink"] as const) {
        const victim = join(outside, `${link}.txt`);
        writeFileSync(victim, "根外文件");
        rmSync(listPath, { force: true });
        if (link === "symlink") symlinkSync(victim, listPath); else linkSync(victim, listPath);
        await freeManualRepairPrompt(id, runC);
        assert.equal(readFileSync(victim, "utf8"), "根外文件", `${link}：根外文件没被覆盖`);
        assert.ok(lstatSync(listPath).isFile() && !lstatSync(listPath).isSymbolicLink(), `${link}：清单换成了普通文件`);
        assert.ok(readFileSync(listPath, "utf8").includes("报告第 39 条"), `${link}：清单内容完整`);
      }
      // 同名位置被一个目录占着：挪开再写，指令照常在上限内（第 2 次审查第 1 轮 F2 的复现形状）。
      rmSync(listPath, { force: true });
      mkdirSync(listPath);
      const displaced = await freeManualRepairPrompt(id, runC);
      const noteAt = displaced.indexOf(`\n\n【${label(2)}】`);
      assert.ok(bytes(displaced.slice(noteAt, displaced.indexOf("\n", noteAt + 4) + 1)) <= RECURRENCE_NOTE_CAP);
      assert.ok(lstatSync(listPath).isFile() && readFileSync(listPath, "utf8").includes("报告第 39 条"), "占位目录挪开后清单写成");
      // 祖先目录被换成链接：安全写入拒绝落盘。**不改成整串内联**（那会超过 300B），这一次交接不发、
      // 时间线上说清原因（自动修复由收尾对账重试，手动修复再点一次）。
      const roundDir = freeReviewEvidenceDir(id, "run-c", 2);
      const moved = join(outside, "round-2");
      renameSync(roundDir, moved);
      symlinkSync(moved, roundDir);
      rmSync(join(moved, RECURRENCE_LIST_FILE), { force: true });
      await assert.rejects(freeManualRepairPrompt(id, runC), /写不进证据目录/, "清单落不了盘：交接不发，而不是超长内联");
      assert.ok(timeline().includes("同类问题熔断的完整清单写不进证据目录"), "时间线上留了原因");
      assert.ok(!readdirSync(moved).includes(RECURRENCE_LIST_FILE), "没有顺着祖先链接写到根外");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }

  console.log("✓ 同类问题熔断：承接只认发出去的编号、错填按没填；谱系按紧邻轮次传递且跨链；熔断指令只在触发轮出现并留痕；熔断提问过硬格式校验");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
