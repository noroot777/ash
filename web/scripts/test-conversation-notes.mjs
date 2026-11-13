// 会话流里的系统旁注：分类只管语气，结构由 continuation 决定。
//   1) 时间线通告一律是 note（不切段），只有回合边界才是 boundary（保留横线）
//   2) 旁注不打断同一会话的连续发言 —— 这正是「预约个审查就把会话劈成上下两段」的病根
//   3) 真人插话、回合边界、换会话，这三种才重新报身份
import assert from "node:assert/strict";
import {
  NEUTRAL_SESSION_NOTES,
  SESSION_DROP_PERSISTENCE_FAILED_NOTE,
  SESSION_LOST_NOTE,
  SESSION_POISONED_NOTE,
  normalizeSessionNoteText,
} from "@ash/shared/session-notes";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { isWorkspaceRecoveryNote, noteTone, verifyNoteOf } from "../src/task-detail/conversationNotes.ts";
import { conversationFeedRows } from "../src/task-detail/conversationReviewLanes.ts";
import { conversationSystemRows } from "../src/task-detail/conversationSystemRows.ts";
import { isConflictHandoff, isReviewSystemPrompt } from "../src/task-detail/systemNoticeModel.ts";
import { noticeView } from "../src/task-detail/timelineNoticeCopy.ts";
import { laneVerdictView } from "../src/task-detail/turnFootnote.ts";

// —— 语气分类：办成了的事不报红，没办成的才报红 ——
assert.equal(noteTone("自由工作流第 2 轮审查通过（5.5审查）。"), "neutral");
assert.equal(noteTone("验收阶段更新：验收完成（accepted）"), "neutral");
assert.equal(noteTone("已预约完成后审查：5.5审查 · 逻辑检查 · 自动复审 1 轮。"), "neutral");
assert.equal(noteTone("自由工作流合并&清理完成：已安全合并 ash/x → main"), "neutral");
assert.equal(noteTone("第 3 轮验证开始：就在这个任务的工作目录里跑。"), "neutral");
assert.equal(noteTone("自由工作流第 1 轮审查未通过，意见已发回会话；修复完成后自动复审。"), "error");
assert.equal(noteTone("完成后审查启动失败：审查者不可用"), "error");
assert.equal(noteTone("已取消完成后审查预约。"), "error");
assert.equal(noteTone("合并清理警告：worktree 未能删除"), "error");
assert.equal(
  isWorkspaceRecoveryNote("〔系统〕原工作目录(worktree 与分支)已不存在，已重建为空目录并提醒 agent 重新确认现状"),
  true,
  "已知的 worktree 重建回执应拿到专用单行样式",
);
assert.equal(isWorkspaceRecoveryNote("合并清理警告：worktree 未能删除"), false, "普通 worktree 旁注不能误判为恢复回执");
// —— 没有类型的老记录：认几个固定说法，再按起头表认要你知道的那几句；其余一律是回执 ——
const legacy = (text, tone = "neutral") => noticeView({ text, tone, variant: "note" });
assert.equal(legacy("开始验收：准备安全合并。").tier, "receipt");
assert.deepEqual(
  [legacy("验收完成：目标分支 main。").tier, legacy("验收完成：目标分支 main。").text],
  ["milestone", "已验收，合并到 main"],
);
assert.equal(legacy("本回合没有交卷：产物仍保留。", "notice").tier, "alert");
assert.deepEqual([legacy("验收未完成：合并发生冲突。", "error").tier, legacy("验收未完成：合并发生冲突。", "error").tone], ["alert", "warn"]);
// 图二：原文里带「失败」「错误」的多半只是引了一段描述或命令，不能据此升成常显的一句。
for (const tone of ["neutral", "error"]) {
  assert.equal(legacy("哨兵已起：等回归跑完，失败就报错误（npm test || echo FAILED）", tone).tier, "receipt", "哨兵已起是回执");
  assert.equal(legacy("哨兵结束：等回归跑完，失败就报错误", tone).tier, "receipt", "哨兵结束是回执");
}
// 终态被拦下改落暂停：不管走时间线那一条（带不带类型）还是带 level:"notice" 的结算说明，都是回执。
const held = "本回合要落的终态被拦下，改为检查点暂停：还有 1 个哨兵没了结（回归测试 未完成）";
assert.equal(legacy(held, "error").tier, "receipt");
assert.equal(legacy(held, "notice").tier, "receipt");
assert.equal(noticeView({ text: held, tone: "neutral", variant: "note", notice: { kind: "receipt" } }).tier, "receipt");
assert.equal(legacy("分组被暂停,本回合被中止 —— 任务落为已暂停", "notice").tier, "receipt", "你自己停的不用再告诉你");
assert.equal(legacy("本回合被 ash 主动终止:上游连不上", "notice").tier, "alert", "被 ash 判失败的结算说明要你知道");
assert.equal(legacy("预览没起来（`npm run dev`）\n端口被占用").tier, "alert", "照 alertLine 调用点的起头认");
assert.equal(legacy("预约审查仍在等待：回合还没结束。", "error").tier, "receipt", "表里没有的起头一律是回执");
assert.equal(legacy("〔系统〕已预约完成后审查：5.5审查。").tier, "receipt", "老记录的〔系统〕前缀是回执");
assert.equal(legacy("〔系统〕已预约完成后审查：5.5审查。").text.startsWith("〔系统〕"), false, "前缀不进摆出来的那句");
// 起头表对齐服务端每一处 alertLine，起头是拼出来的（门禁摘要、预览回收没成、带标签起头的……）也认得出。
for (const text of [
  "验收没有执行：点验收时看到的那一版之后，任务又跑出了新的结果。看过最新的再验收。",
  "这一下没有执行：点的是这条线上一段的卡，它已经离开了那一道「等我点头」。看过它现在停在哪一站再点。",
  "验收前置命令接管降级：临时进程信息不可读",
  "验收前置命令 `npm test` 未通过：命令退出码非 0（rc=1）。",
  "这条命令点名要跑的 「test:e2e」 在被测快照里解析不出来（起跑前核过）：多半就是它起不来。",
  "这一轮没能起跑：worktree 建不出来\n\n你刚发的这条消息**没有送达** agent，原文如下，修好后可以重发：\n\n继续",
  "〔系统〕任务登记的基线分支 feat/x 已不存在，本次工作目录改按仓库当前 main 新建，任务登记的基线未改动",
  "预览异常：端口被占用",
  "预览清理暂缓：EACCES",
  "预览停止记录暂时无法读写（EACCES）；请检查任务记录目录权限或磁盘状态后重试。（任务已归档）",
  "重跑上一回合未能启动：回合被其它执行抢占，请再试一次。",
  "重跑上一回合启动失败：spawn ENOENT；可以再试一次。",
  "这条线停在「自动验证」这一站：自动复审轮数已经用完，等你处理后再手动派一轮。",
  "更新基线发生冲突或 rebase 失败；原子分支和工作区未修改，请在子任务中处理后重新验证",
  "合并已完成：成果已合入 main（提交 abc）。清理尚未完成。为避免删除正在使用或尚未结算的 worktree，清理已暂缓。x 阶段停在 merged，稍后可重新验收继续清理。",
  "合并已完成，结果已保留。预览停止记录暂时无法读写；请检查任务记录目录权限或磁盘状态后重试。验收收尾暂缓，处理后可再次验收。",
  "以下团队执行者的独立验证尚未执行：A 本次验收未执行，需明确确认仍要验收。",
  "自由工作流第 2 轮审查的任务书被协议层明确拒收，审查者一个字都没收到，这一轮按未完成收尾；重跑这一轮即可重新投递。",
  "执行者这一回合结束时没有调用 debate_reply 交卷；辩论已中止；驳回仍在等你裁定，也可以再开一轮辩论。",
  "〔系统〕定时消息未发送，已取消（原定 2026-11-13 10:00）：任务已归档",
  "哨兵没能开工：回归测试。命令解析失败",
  "升级迁移：上一版「合并&清理」失败；请从验收页重新验收或人工处理。",
  // 成败在引文紧后面的那两种：命令里引了「通过」也不改变真的那个。
  "验收前置命令 `printf '` 通过（rc=0）'` 未通过：命令退出码非 0（rc=1）。",
  "验收前置命令 `sleep 999` 被打断：ash 重启,这次没跑完。 命令跑了 30 分钟才退出",
  "跑了一条命令：`npm test`（没通过）\n输出里有一行：`（没通过）",
  "这条线卡在「自定义」这一站，停下等你处理。",
  "「自定义」已经打回重做 3 次仍没过，按线上写的上限停下等你处理。",
  "门禁交接：投递没有回执。看一眼会话里有没有这条修复要求，没有的话在验收台上点「再交一次」（日志 /tmp/g.log）。",
  "哨兵「回归」存着一条这一版读不出来的结束条件「[DONE]」（结束条件不是正则，是字样）。它不会提前收工，只会盯到到期——要让它早点收工，用改得对的条件另起一个。",
]) assert.equal(legacy(text).tier, "alert", `漏认了一句要你知道的：${text.slice(0, 24)}…`);
// 只认整条记录的外层写法：回执里引了别人的话（哨兵的描述、命令），不让引文决定它摆在哪儿。
for (const text of [
  "哨兵已起：检查条目太多放不进指令时的恢复行为（node replay.mjs）",
  "哨兵结束：处理未发送，已取消，exit=0",
  "哨兵已起：复现「辩论已中止；驳回仍在等你裁定，也可以再开一轮辩论。」",
  "哨兵已起：盯「预览没起来」那条路（npm run e2e）",
  "门禁交接：修复输入已持久入队，按原审查权限等待投递（日志 /tmp/x.log）。",
  "升级迁移：上一版「合并&清理」已记录合并完成，验收标记已补上（合并区间无从考证，未伪造）。",
  "验收前置命令 `npm test` 通过（rc=0）。",
  // 成功的命令里恰好引了一句像失败的字（第 2 轮审查实测）：成败只认格式规定的那个位置。
  "验收前置命令 `printf '%s\\n' '` 未通过：只是文字'` 通过（rc=0）。",
  "验收前置命令 `printf '` 未通过：命令退出码非 0（rc=1）'` 通过（rc=0）。",
  // 开头跟提醒共用、只有结尾分得开的那几句回执。
  "以下团队执行者的独立验证尚未执行：A、B 本次验收已显式确认继续，未将验证记为已执行或通过。",
  "独立验证尚未执行：工作流中有 1 个自动验证步骤没有已执行的验证轮记录。 本次验收已显式确认继续，未将验证记为已执行或通过。",
  "这条线卡在「自定义：这一站，停下等你处理。」这一站；线上写的是「问我一句」，已经把问题挂给你了。",
  "「已经打回重做 3 次仍没过」写的是「打回给 AI 重做」，但工作区刚随验收清掉了，没法再打回；改成问你一句。",
]) {
  assert.equal(legacy(text, "error").tier, "receipt", `回执被引文升了档：${text.slice(0, 24)}…`);
  assert.equal(legacy(text, "notice").tier, "receipt", `结算说明那一路同样不升：${text.slice(0, 24)}…`);
}

// —— 有类型的：写结果不写机制，细节留在原文里点开再看 ——
const typed = (notice, text = "原文") => noticeView({ text, tone: "neutral", variant: "note", notice });
assert.deepEqual(
  [typed({ kind: "accept.done", target: "main" }, "验收完成：目标分支 main（worktree 已删除）。").text, typed({ kind: "accept.done", target: "main" }).tier],
  ["已验收，合并到 main", "milestone"],
);
assert.equal(typed({ kind: "accept.done", target: "main", noCommit: true }).text, "已验收，合并到 main，等你提交");
assert.equal(typed({ kind: "accept.done", target: null, tag: "v1.2" }).text, "已验收，打上标签 v1.2");
assert.equal(typed({ kind: "monitor.released", description: "回归测试", finished: true }).text, "不再等哨兵「回归测试」了，它已经跑完");
assert.equal(typed({ kind: "monitor.released", description: "回归测试", finished: true }).tier, "receipt");

// —— 「N 条记录」里那几句说人话，每一条带一枚图标（哨兵 = 检查器哨兵格那一枚）——
// 哨兵起停、被哨兵拦下没收成工、预约的审查还在等：原文是写给 agent 的（「开始盯」「终态」「检查点」），
// 摆给人看换成说结果的一句；带不带类型（老记录只有原文）摆出来是同一句。
assert.deepEqual(
  (({ icon, text }) => [icon, text])(typed({ kind: "monitor.started", description: "回归测试" })),
  ["monitor", "派了哨兵在后台等：回归测试"],
);
assert.equal(typed({ kind: "monitor.finished", description: "回归测试" }).text, "哨兵等完了：回归测试");
assert.deepEqual(
  (({ tier, icon, text, detail }) => [tier, icon, text, detail])(typed({ kind: "complete.held", after: "pending" }, held)),
  ["receipt", "monitor", "哨兵的结果还没收到，先不收工，暂停等它", held],
  "原文点开再看",
);
assert.equal(typed({ kind: "complete.held", after: "new-monitor" }).text, "收工之后又派了哨兵，先暂停等它回来");
for (const tone of ["neutral", "notice", "error"]) {
  assert.deepEqual(
    (({ icon, text }) => [icon, text])(legacy(held, tone)),
    ["monitor", "哨兵的结果还没收到，先不收工，暂停等它"],
    "老记录里的「终态被拦下」照样说成人话",
  );
}
assert.equal(legacy("哨兵已起：等回归跑完（npm test）").text, "派了哨兵在后台等：等回归跑完");
assert.equal(legacy("已撤掉本回合的完成确认：挂上哨兵「回归」之后，这一轮改为检查点暂停 —— 任务一落 done ……").text, "收工之后又派了哨兵，先暂停等它回来");
assert.deepEqual(
  (({ icon, text }) => [icon, text])(typed({ kind: "review.waiting", why: "monitor" }, "预约审查仍在等待：这一轮挂着 1 个哨兵在盯着。预约已保留。")),
  ["review", "预约的审查先不开始：哨兵还没把结果带回来"],
);
assert.equal(legacy("预约审查仍在等待：任务正在等你答复。预约已保留，后续执行回合正常结束后自动开始。").text, "预约的审查先不开始：任务在等你答复");
assert.equal(legacy("预约审查仍在等待：说不清的原因。预约已保留，后续执行回合正常结束后自动开始。").text, "预约的审查先不开始：说不清的原因", "认不出是哪一种就照登原因");
// 没有专门说法的：图标按句子的主语认，引在后面的描述不算。
assert.equal(legacy("预览已回收（任务结束）：http://localhost:5174").icon, "preview");
assert.equal(legacy("验收前置命令开跑：`npm test`（独立快照 abc）").icon, "gate", "「验收前置命令」不认成验收");
assert.equal(legacy("合入目标由 main 更改为 feat/x；开工提交未变").icon, "accept");
assert.equal(legacy("子分支基线已更新到 main@abc").icon, "branch");
assert.equal(legacy("本次审查改用 codex（审查者的配置未改动）").icon, "review");
assert.equal(legacy("一句说不出是哪类事的话").icon, "info");
assert.equal(legacy("本回合没有交卷：产物仍保留。", "notice").icon, "alert", "要你知道的那一档认不出主语时是警示那一枚");
assert.equal(typed({ kind: "review.reserved", reviewer: "5.5审查", updated: false }).text, "审查已预约，这一轮跑完自动开始");
assert.deepEqual(
  (({ tier, tone, text }) => [tier, tone, text])(typed({ kind: "review.verdict", source: "free", round: 2, verdict: "failed", findings: 2 })),
  ["milestone", "bad", "第 2 轮审查未通过，2 条意见"],
);
assert.equal(typed({ kind: "review.verdict", source: "free", round: 3, verdict: "passed" }).text, "第 3 轮审查通过");
assert.equal(typed({ kind: "review.verdict", source: "free", round: 1, verdict: "aborted" }).tier, "alert", "没能开始的一轮是出了岔子");
assert.deepEqual(
  (({ dispute, text, detail }) => [dispute, text, detail])(typed({ kind: "review.dispute", round: 1 }, "执行者不认这一轮审查意见（第 1 轮 · x）。")),
  [true, "第 1 轮审查意见被驳回，等你裁定", "执行者不认这一轮审查意见（第 1 轮 · x）。"],
  "等你裁定是尾注里的一句，理由点开再看",
);
assert.equal(typed({ kind: "accept.done", target: "feat/ui-revamp" }).mono, "feat/ui-revamp", "分支名换成等宽字");
assert.equal(typed({ kind: "alert" }, "预览没起来：端口被占用。").tier, "alert");
// 你那条斜杠命令的回答是你要看的东西：不收进回合记录。
const scopes = typed({ kind: "command.output", command: "/goal --scopes" }, "/goal --scopes\n已保存的目标作用域（ash 快照，不启动模型）：\n- codex：让 test/auth 全过");
assert.deepEqual(
  [scopes.tier, scopes.text, scopes.meta],
  ["reply", "已保存的目标作用域（ash 快照，不启动模型）：\n- codex：让 test/auth 全过", "/goal --scopes"],
  "命令的回答整段常显，命令本身写在指到才出的那半句里",
);
assert.equal(typed({ kind: "command.output", command: "/goal clear" }, "已清除。\n命令：/goal clear").text, "已清除。");
const longRaw = "验收暂缓：这一轮的回归测试还在跑，等它跑完、结果交回任务之后再来合并；你也可以先去改动工作区看看改了什么。";
assert.deepEqual(
  [typed({ kind: "receipt" }, longRaw).text, typed({ kind: "receipt" }, longRaw).detail],
  ["验收暂缓", longRaw],
  "长原文只留标题，原文点开再看",
);
assert.equal(typed({ kind: "receipt" }, "开始验收：准备安全合并。").detail, null, "短的整句照登，没有可展开的");
assert.equal(isConflictHandoff("【验收未通过 · 需要你解冲突】\n请处理"), true);
assert.equal(isConflictHandoff("【自动验证未通过 · 第 1 轮】\n请处理"), false);
assert.equal(isReviewSystemPrompt("【自由工作流审查未通过 · 第 1 轮】\n请处理"), true);
assert.equal(isReviewSystemPrompt("【验收未通过 · 需要你解冲突】\n请处理"), false);

// —— 回执记在它所属的那一回合上，不在会话里占行；要你知道的是那一回合的尾注 ——
const ev = (id, text, notice, tone = "neutral") => ({ kind: "item", item: { kind: "event", id, text, variant: "note", tone, ...(notice ? { notice } : {}) } });
const agent = (id) => ({ kind: "item", item: { kind: "agent", id, segments: [] } });
const user = (id) => ({ kind: "item", item: { kind: "user", id, text: "你说的", attachments: [] } });
const rowIds = (display) => display.rows.map((row) => row.kind === "item" ? row.item.id : row.id);
const sentence = (footnote) => footnote?.parts.map((part) => part.view.text).join(" · ");
const attached = conversationSystemRows([
  user("u0"),
  ev("r0", "意见已交给执行者", { kind: "review.repair", source: "free", round: 1 }),
  agent("a1"),
  ev("r1", "开始盯", { kind: "monitor.started", description: "回归测试" }),
  ev("m1", "验收完成", { kind: "accept.done", target: "main" }),
  ev("r2", "已预约", { kind: "review.reserved", reviewer: "x", updated: false }),
  user("u1"),
  ev("r3", "不再等", { kind: "monitor.released", description: "回归测试", finished: true }),
  agent("a2"),
  user("u2"),
  ev("r4", "孤零零的一条", { kind: "receipt" }),
]);
assert.deepEqual(
  rowIds(attached),
  ["u0", "a1", "u1", "a2", "u2", "footnote:r4"],
  "会话里只剩你说的、它说的；找不到回合的回执原处留一颗「N 条记录」",
);
assert.deepEqual(attached.receipts.get("a1")?.map((r) => r.id), ["r0", "r1", "m1", "r2"], "段里还没回合的回执等第一回合来认，之后的记在最近那一回合上；尾注那一句也在记录里");
assert.deepEqual(attached.receipts.get("a2")?.map((r) => r.id), ["r3"]);
assert.equal(sentence(attached.footnotes.get("a1")), "已验收，合并到 main");
assert.equal(attached.footnotes.get("a1")?.live, false, "后面有你的话，它就是过去的事");

// 图三：审查通过以后验收。收了口的审查轮不再把段切开，是被审那一回合之后单独一行的审查结论；
// 结论之后才发生的那几句贴在它下面，不回到回合的尾注里。每一句（连同结论）都在那一回合的记录里。
const lane = (id, round, conclusion, extra = {}) => ({
  kind: "review-lane", id, source: "free", round, totalRounds: null, title: `第 ${round} 轮审查`,
  items: [{ kind: "event", id: `${id}:end`, text: `自由工作流第 ${round} 轮审查${conclusion === "verified" ? "通过" : "未通过"}`, at: `2026-11-13T0${round}:00:00.000Z`, variant: "note", tone: "neutral", notice: { kind: "review.verdict", source: "free", round, verdict: conclusion === "verified" ? "passed" : "failed" } }],
  reviewerLabel: "5.5审查", reviewerModel: null, reviewerEffort: null, note: null,
  startedAt: null, endedAt: `2026-11-13T0${round}:00:00.000Z`, conclusion, complete: true,
  reportAvailable: false, report: null, runId: null, defaultCollapsed: true, findings: null, ...extra,
});
const figure3 = conversationSystemRows([
  user("u0"),
  agent("a1"),
  lane("l4", 4, "verify_failed"),
  ev("rep", "意见已交给执行者", { kind: "review.repair", source: "free", round: 4 }),
  agent("a2"),
  lane("l5", 5, "verified"),
  ev("gate", "验收暂缓：回归还在跑", { kind: "alert" }),
  ev("s1", "验收阶段更新：已合并", { kind: "stage", stage: "merged" }),
  ev("acc", "验收完成：目标分支 feat/ui-revamp", { kind: "accept.done", target: "feat/ui-revamp" }),
  ev("s2", "验收阶段更新：已验收", { kind: "stage", stage: "accepted" }),
]);
const verdictRow = (display, id) => display.rows.find((row) => row.kind === "verdict" && row.lane.id === id);
assert.deepEqual(rowIds(figure3), ["u0", "a1", "verdict:l4", "a2", "verdict:l5"], "结论夹在被审回合和下一回合之间；验收那几步不占行，末尾没有单挂的「N 条记录」");
assert.equal(figure3.footnotes.get("a2"), undefined, "被审回合下面不再说审查结论，结论之后的验收也不挂回它");
assert.equal(sentence(verdictRow(figure3, "l5").footnote), "已验收，合并到 feat/ui-revamp", "贴在结论下面；验收成了，之前的验收暂缓退回记录");
assert.deepEqual(figure3.receipts.get("a2")?.map((r) => r.id), ["l5:end", "gate", "s1", "acc", "s2"], "结论和贴在它下面的每一句也在记录里");
assert.deepEqual([verdictRow(figure3, "l5").live, verdictRow(figure3, "l5").footnote.live], [true, true], "最后一件事、后面没有你的话：它是现在的事");
assert.equal(figure3.footnotes.get("a1"), undefined);
assert.equal(verdictRow(figure3, "l4").live, false, "后面又起了回合，未通过就是过去的事，点熄掉");
assert.equal(sentence(verdictRow(figure3, "l4").footnote), "", "意见已交给执行者是回执，不贴在结论下面");

// 同一回合上重审过的只留最近那一次结论；它是最后一件事时「未通过」字前带点。被盖过的那一行撤掉，
// 贴在它下面的那几句发生在新结论之前，回到回合的尾注。
const rerun = conversationSystemRows([
  agent("a1"), lane("l1", 1, "verify_failed"), ev("x1", "预览没起来", { kind: "alert" }), lane("l2", 2, "verify_failed"),
]);
assert.deepEqual(rowIds(rerun), ["a1", "verdict:l2"]);
assert.deepEqual([verdictRow(rerun, "l2").live, verdictRow(rerun, "l2").lane.conclusion], [true, "verify_failed"]);
assert.equal(sentence(rerun.footnotes.get("a1")), "预览没起来");
assert.equal(rerun.footnotes.get("a1")?.live, false, "结论排在它后面，回合下面那句就不是现在的事");
// 被盖过的那一轮在记录里还认得出是哪一轮：记录带着它，点开能去那一轮或者就地摊开。
assert.deepEqual(rerun.receipts.get("a1")?.map((r) => r.lane?.id ?? r.id), ["l1", "x1", "l2"]);

// 派审没能开始：收口以后照样说「没能开始」、红点，不说成「没有给出结论」。
const verdictView = (display) => laneVerdictView(display.rows.find((row) => row.kind === "verdict").lane);
const abortedLane = conversationFeedRows([
  { kind: "agent", id: "a1", segments: [] },
  { kind: "event", id: "s1", text: "自由工作流第 1 轮审查开始", variant: "note", tone: "neutral", at: "2026-11-13T01:00:00.000Z", notice: { kind: "review.start", source: "free", round: 1 } },
  { kind: "event", id: "e1", text: "自由工作流第 1 轮审查启动失败：审查者不可用", variant: "note", tone: "error", at: "2026-11-13T01:01:00.000Z", notice: { kind: "review.verdict", source: "free", round: 1, verdict: "aborted" } },
]);
const aborted = conversationSystemRows(abortedLane.map((row) => row.kind === "review-lane" ? row : { kind: "item", item: row.item }));
assert.deepEqual(
  (({ text, tone, tier }) => [text, tone, tier])(verdictView(aborted)),
  ["第 1 轮审查没能开始", "bad", "alert"],
);
const legacyAborted = conversationSystemRows(conversationFeedRows([
  { kind: "agent", id: "a1", segments: [] },
  { kind: "event", id: "s1", text: "自由工作流第 1 轮审查开始（5.5审查）。", variant: "note", tone: "neutral", at: "2026-11-13T01:00:00.000Z" },
  { kind: "event", id: "e1", text: "自由工作流第 1 轮审查启动失败：审查者不可用", variant: "note", tone: "error", at: "2026-11-13T01:01:00.000Z" },
]).map((row) => row.kind === "review-lane" ? row : { kind: "item", item: row.item }));
assert.equal(verdictView(legacyAborted).text, "第 1 轮审查没能开始", "没有类型的老记录同样认得出没能开始");

// 结论之前的（这一轮异常结束）留在回合下面；前面没有回合可挂的结论照样单独一行，删除在原处那份记录里。
const failedThenReviewed = conversationSystemRows(
  [agent("a1"), lane("l1", 1, "verified")],
  { failures: new Map([["a1", { text: "执行异常结束 · exit 1", at: "2026-11-13T00:30:00.000Z" }]]) },
);
assert.equal(sentence(failedThenReviewed.footnotes.get("a1")), "这一轮异常结束");
assert.equal(sentence(verdictRow(failedThenReviewed, "l1").footnote), "");
const noTurn = conversationSystemRows([user("u0"), lane("l1", 1, "verified"), ev("acc", "验收完成", { kind: "accept.done", target: "main" })]);
assert.deepEqual(rowIds(noTurn), ["u0", "verdict:l1", "footnote:l1:end"]);
assert.deepEqual(noTurn.rows[2].receipts.map((r) => r.id), ["l1:end", "acc"]);
assert.equal(sentence(verdictRow(noTurn, "l1").footnote), "已验收，合并到 main");

// 一轮异常结束是那一回合尾注里的一句；明面的话同一回合只留最近一句。
const crashed = conversationSystemRows(
  [agent("a1"), ev("x1", "预览没起来", { kind: "alert" }), ev("x2", "验收暂缓：回归还在跑", { kind: "alert" })],
  { failures: new Map([["a1", { text: "执行异常结束 · exit 1", at: "2026-11-13T01:00:00.000Z" }]]) },
);
assert.equal(sentence(crashed.footnotes.get("a1")), "这一轮异常结束 · 验收暂缓：回归还在跑");
// 刷新以后补出来的那一句跟直播那一路一样：有时刻，也在这一回合的记录里（排在最前，它是这一回合自己的收场）。
assert.equal(crashed.footnotes.get("a1")?.parts[0].at, "2026-11-13T01:00:00.000Z");
assert.deepEqual(crashed.receipts.get("a1")?.map((r) => [r.id, r.at]), [
  ["failure:a1", "2026-11-13T01:00:00.000Z"], ["x1", undefined], ["x2", undefined],
]);

// 图二：没有类型的老记录夹在两个回合之间，一条都不占行。
const figure2 = conversationSystemRows([
  agent("a1"),
  ev("o1", "哨兵已起：等回归跑完（npm test || echo 失败）", undefined, "error"),
  ev("o2", "哨兵结束：等回归跑完，失败就报错误", undefined, "error"),
  ev("o3", "本回合要落的终态被拦下，改为检查点暂停：还有 1 个哨兵没了结", undefined, "notice"),
  ev("o4", "本回合要落的终态被拦下，改为检查点暂停：还有 1 个哨兵没了结", undefined, "error"),
  agent("a2"),
]);
assert.deepEqual(rowIds(figure2), ["a1", "a2"]);
assert.deepEqual(figure2.receipts.get("a1")?.map((r) => r.id), ["o1", "o2", "o3", "o4"]);
assert.equal(figure2.footnotes.get("a1"), undefined, "没有要你知道的，就没有尾注");

// 前面确实没有回合可挂（任务没跑过就验收）：留在原处一句小灰字，它的记录跟着。
const orphan = conversationSystemRows([user("u0"), ev("acc", "验收完成", { kind: "accept.done", target: "main" }), ev("s", "阶段", { kind: "stage", stage: "accepted" })]);
assert.deepEqual(rowIds(orphan), ["u0", "footnote:acc"]);
assert.deepEqual(orphan.rows[1].receipts.map((r) => r.id), ["acc", "s"]);
assert.deepEqual([sentence(orphan.rows[1].footnote), orphan.rows[1].footnote.live], ["已验收，合并到 main", true]);

const oneLog = conversationSystemRows([ev("first", "第一条", { kind: "receipt" })]);
const growingLog = conversationSystemRows([ev("first", "第一条", { kind: "receipt" }), ev("second", "第二条", { kind: "receipt" })]);
assert.equal(oneLog.rows[0].id, growingLog.rows[0].id, "同一组追加回执时 React key 必须稳定，展开态不能被冲掉");

// —— 会话轮换旁注：中性事实，不是本回合失败 ——
// 这几句会出现在一个 exit 0 的成功回合、甚至用户自己点的「停止全组」上。判据不是「文案
// 里恰好没踩到关键词」（`SESSION_POISONED_NOTE` 讲的就是 Codex 报了问题），而是
// @ash/shared/session-notes 那份服务端也在用的同一源文本。
for (const note of NEUTRAL_SESSION_NOTES) {
  assert.equal(noteTone(note), "neutral", `会话轮换旁注被判成执行异常：${note.slice(0, 24)}…`);
  // 旁注是纯文本一行小字（ConversationFeed 的 <p>{item.text}</p>），Markdown 不会被解析：
  // 文案里写 `**全新会话**`，用户看到的就是两侧的星号。
  assert.doesNotMatch(note, /\*\*|`|^[-*] /m, `会话轮换旁注带了 Markdown 标记：${note.slice(0, 24)}…`);
}
// 「中性事实 + 真失败」拼起来的收尾句仍然要红 —— 摘掉中性部分再判，就是为了这个。
assert.equal(
  noteTone(`更正上面那条：CLI 会话接不回了。${SESSION_POISONED_NOTE}`),
  "neutral",
  "用户主动停止后的会话更正不该显示成执行异常",
);
assert.equal(
  noteTone("更正上面那条：CLI 会话接不回了。ash 已停止本次进程继续使用这条失效的 CLI 会话；但恢复字段写入数据库失败，下一次重新开台时可能再次尝试旧会话。"),
  "error",
  "拼在中性文案后面的真失败被一起洗白了",
);

// —— 升级前已经落盘的旧版文案：一字不改地照抄用户 .md 里的原文 ——
// 只改常量只对「以后写的数据」有效；用户抱怨的那条记录刷新后还在，必须一并归一。
const LEGACY_POISONED =
  "Codex 已在本轮 stderr 中报告这条 thread 的回合关联、world-state 或 rollout 落盘异常；"
  + "即使进程 exit 0 且发出 turn.completed，也不能再把它当作可恢复会话；"
  + "会话轮换不改变本回合真实的退出原因。"
  + "ash 已清掉这条会话的恢复字段：下一次运行会从任务正文自动开启一条**全新会话**，"
  + "旧对话与执行记录仍保留，但之前的上下文不会带过去。";
const LEGACY_LOST =
  "上一轮记下的 CLI 会话 id 在 CLI 那边已经不存在了（多半是第一次起跑就失败、"
  + "会话压根没建起来，也可能是 CLI 的会话记录被清过或换了机器/目录）。"
  + "ash 已经把这个失效的 id 清掉：再点一次运行会开一条**全新会话**，"
  + "之前的上下文不会带过来，任务正文和历史记录都还在。";
for (const legacy of [LEGACY_POISONED, LEGACY_LOST]) {
  assert.equal(noteTone(legacy), "neutral", "升级前落盘的轮换旁注刷新后仍是红的");
  assert.doesNotMatch(
    normalizeSessionNoteText(legacy),
    /\*\*/,
    "升级前落盘的轮换旁注刷新后仍把 Markdown 星号露给用户",
  );
}
assert.equal(
  normalizeSessionNoteText("前言。" + LEGACY_POISONED + "后话。"),
  "前言。" + SESSION_POISONED_NOTE + "后话。",
  "旧文案要就地换成当前文案，前后文原样保留",
);
assert.equal(normalizeSessionNoteText("跟轮换无关的一句话"), "跟轮换无关的一句话", "认不出来的文本必须原样返回");

const session = {
  id: "s1",
  taskId: "t1",
  agentType: "codex",
  executor: "codex@cpa",
  role: "main",
  startedAt: "2026-08-10T03:23:00.000Z",
  endedAt: "2026-08-10T14:04:00.000Z",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
};
const turn = (kind, text, at) => `${JSON.stringify({ t: kind, text, at })}`;

// 图二那一段：一轮说完话 → 预约了完成后审查 → 同一个会话接着说。
const output = [
  "第一回合说的话。",
  turn("system", "已预约完成后审查：5.5审查 · 逻辑检查 · 自动复审 1 轮。", "2026-08-10T03:27:00.000Z"),
  "第二回合说的话。",
].join("\n");

const items = buildConversationItems([{ session, output, trace: [] }], [session], []);
assert.deepEqual(items.map((item) => item.kind), ["agent", "event", "agent"]);

const [first, note, second] = items;
assert.equal(note.variant, "note", "时间线通告是旁注，不是回合边界");
assert.equal(note.tone, "neutral");
assert.equal(first.continuation, false, "会话第一段照常报身份");
assert.equal(second.continuation, true, "旁注隔开的下半截接着上一段排版，不重报头像和执行器名");
// 两截仍是各自独立的回合：用时和用量还挂在各自那条上，合并卡片会把这些抹平。
assert.equal(first.sessionId, second.sessionId);
assert.notEqual(first.id, second.id);

// —— 真人插话是真断点：后面那截要重新报身份 ——
const withReply = [
  "第一回合说的话。",
  turn("system", "验收阶段更新：验收完成（accepted）", "2026-08-10T03:27:00.000Z"),
  turn("user", "再改一处", "2026-08-10T03:28:00.000Z"),
  "第二回合说的话。",
].join("\n");
const replied = buildConversationItems([{ session, output: withReply, trace: [] }], [session], []);
assert.deepEqual(replied.map((item) => item.kind), ["agent", "event", "user", "agent"]);
assert.equal(replied.at(-1).continuation, false, "真人插话之后必须重新报身份");

// —— 回合边界事件（直播态的「本轮执行结束」）保留横线，并且打断续接 ——
const live = buildConversationItems([{ session, output: "第一回合说的话。", trace: [] }], [session], [
  {
    kind: "server",
    id: "live:done",
    event: { type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex", event: { kind: "done", exitStatus: 0 } },
  },
  {
    kind: "server",
    id: "live:text",
    event: { type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex", event: { kind: "text", text: "又被叫醒了。" } },
  },
]);
const boundary = live.find((item) => item.kind === "event");
assert.equal(boundary.variant, "boundary", "回合边界仍是整宽分隔线");
assert.equal(live.at(-1).continuation, false, "回合结束之后是新的一段，要重新报身份");

// —— 实时旁注跟落盘 sentinel 共用时间，且不能把当前回合的工具/统计拆到旁注后面 ——
const liveNoteAt = "2026-08-10T03:27:00.000Z";
const activeSession = {
  ...session,
  turnStartedAt: session.startedAt,
  endedAt: null,
  cliSessionId: "cli-s1",
};
const beforeNoteTrace = {
  at: "2026-08-10T03:24:00.000Z",
  turnStartedAt: session.startedAt,
  event: { kind: "text", text: "第一回合说的话。" },
};
const afterNoteTool = {
  at: "2026-08-10T03:28:00.000Z",
  turnStartedAt: session.startedAt,
  event: { kind: "tool", name: "exec", detail: "检查布局" },
};
const liveNote = buildConversationItems([{ session: activeSession, output: "第一回合说的话。", trace: [beforeNoteTrace] }], [activeSession], [
  {
    kind: "server",
    id: "live:note",
    event: { type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex", event: { kind: "system", text: "已预约完成后审查。", at: liveNoteAt } },
  },
  {
    kind: "server",
    id: "live:tool",
    event: { type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex", event: { kind: "tool", name: "exec", detail: "检查布局" } },
  },
]);
const persistedNote = buildConversationItems([{
  session: activeSession,
  output: ["第一回合说的话。", turn("system", "已预约完成后审查。", liveNoteAt)].join("\n"),
  trace: [beforeNoteTrace, afterNoteTool],
}], [activeSession], []);
const shape = (rows) => rows.map((item) => item.kind === "agent" ? {
  kind: item.kind,
  tools: item.segments.flatMap((segment) => segment.events.map((event) => event.label)),
  showSessionMeta: item.showSessionMeta,
  endedAt: item.endedAt,
} : { kind: item.kind, at: item.at });
assert.deepEqual(shape(liveNote), shape(persistedNote), "实时旁注前后的工具与统计条位置必须和刷新后同构");
assert.deepEqual(liveNote.map((item) => item.kind), ["agent", "event"]);
assert.equal(liveNote[0].showSessionMeta, true, "会话统计条应留在旁注之前的当前回合上");
assert.equal(liveNote[0].endedAt, null, "旁注不能把仍在运行的当前回合提前截断");
assert.equal(liveNote[1].at, liveNoteAt, "实时旁注应直接带落盘时的精确时间");

// —— 原生引导：同一个 turnStartedAt 横跨 user sentinel，刷新后仍须 agent → user → agent ——
const steerAt = "2026-08-10T03:30:00.000Z";
const steeredOutput = [
  "旧方向回复。",
  turn("user", "改按新方向", steerAt),
  "新方向回复。",
].join("\n");
const steeredTrace = [
  {
    at: "2026-08-10T03:24:00.000Z",
    turnStartedAt: session.startedAt,
    event: { kind: "tool", name: "exec", detail: "旧方向工具" },
  },
  {
    at: "2026-08-10T03:25:00.000Z",
    turnStartedAt: session.startedAt,
    event: { kind: "text", text: "旧方向回复。" },
  },
  {
    at: "2026-08-10T03:31:00.000Z",
    turnStartedAt: session.startedAt,
    event: { kind: "tool", name: "edit", detail: "新方向工具" },
  },
  {
    at: "2026-08-10T03:32:00.000Z",
    turnStartedAt: session.startedAt,
    event: { kind: "text", text: "新方向回复。" },
  },
];
const steered = buildConversationItems([{
  session: activeSession,
  output: steeredOutput,
  trace: steeredTrace,
}], [activeSession], []);
assert.deepEqual(steered.map((item) => item.kind), ["agent", "user", "agent"]);
assert.equal(steered.filter((item) => item.kind === "agent" && item.markdown.includes("新方向回复。")).length, 1,
  "引导后的回答只能出现一次");
assert.equal(steered.some((item) => item.id.startsWith("persisted:trace:")), false,
  "同回合引导后的执行 trace 不得掉进孤立兜底气泡");
assert.deepEqual(
  steered.filter((item) => item.kind === "agent").map((item) =>
    item.segments.flatMap((segment) => segment.events.map((event) => event.label))),
  [["exec"], ["edit"]],
  "用户消息前后的工具必须留在各自可见位置",
);

// —— 会话轮换（Codex thread 被判 poisoned）是旁注，不是这一轮的失败 ——
// 服务端把 `scope:"session"` 转成持久 system 注记（server/src/session-notice.ts），
// 所以落盘路和直播路都得渲染成 note；一个 exit 0、正文完整的回合不许出现红色「异常」。
const rotationSession = { ...session, agentType: "codex", endedAt: null, turnStartedAt: session.startedAt };
const diagnosis = "Codex 会话诊断：session=poisoned_session";
const rotationNote = SESSION_POISONED_NOTE;
// 轮换说明自己带着「异常」二字(它在转述 Codex 报的 rollout 异常),不专门认出来就会被
// FAILED_HINTS 染红 —— 只断言 variant 会漏掉这一整层(自由工作流第 2 轮审查)。
assert.equal(noteTone(SESSION_POISONED_NOTE), "neutral", "poisoned 轮换说明不许被关键词染红");
assert.equal(noteTone(SESSION_LOST_NOTE), "neutral", "会话失效轮换说明不许被关键词染红");
assert.equal(noteTone(`更正上面那条:CLI 会话接不回了。${SESSION_POISONED_NOTE}`), "neutral", "收尾更正说的是同一件事");
// 这条不是轮换而是真出了问题:恢复字段没写进库,下一次可能再撞旧会话。该红就红。
assert.equal(noteTone(SESSION_DROP_PERSISTENCE_FAILED_NOTE), "error", "清理写库失败仍必须报红");
// 旁注三处渲染点(ConversationFeed、team/TeamFeed、duet 的 duet-turn-notice)都是纯文本,
// 措辞里带 `**` 用户就会看到字面量的星号(自由工作流第 1 轮审查)。哪天真上了受控的
// inline Markdown 渲染,记得三处一起上,再来改这条断言。
for (const [name, text] of Object.entries({ SESSION_LOST_NOTE, SESSION_POISONED_NOTE, SESSION_DROP_PERSISTENCE_FAILED_NOTE })) {
  assert.doesNotMatch(text, /\*\*|`|^#|\[.+\]\(/m, `${name} 是纯文本旁注，不能带 Markdown 标记`);
}
const rotationLive = buildConversationItems(
  [{ session: rotationSession, output: "这一轮正文已经完整产出。", trace: [] }],
  [rotationSession],
  [diagnosis, rotationNote].map((text, index) => ({
    kind: "server",
    id: `live:rotation:${index}`,
    event: {
      type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex",
      event: { kind: "system", text, at: `2026-08-10T03:2${5 + index}:00.000Z` },
    },
  })).concat([{
    kind: "server",
    id: "live:rotation:done",
    event: {
      type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex",
      event: { kind: "done", exitStatus: 0 },
    },
  }]),
);
const rotationAux = rotationLive.flatMap((item) => item.kind === "agent"
  ? item.segments.flatMap((segment) => segment.events.filter((e) => e.kind === "error"))
  : []);
assert.deepEqual(rotationAux, [], "会话轮换不该在气泡里留下红色「异常」");
const rotationNotes = rotationLive.filter((item) => item.kind === "event" && item.variant === "note");
assert.deepEqual(
  rotationNotes.map((item) => [item.tone, item.text]),
  [["neutral", diagnosis], ["neutral", rotationNote]],
  "轮换诊断与说明都渲染成中性旁注（只判 variant 会漏掉颜色）",
);
assert.equal(rotationLive.at(-1).text, "本轮执行结束", "exit 0 仍是正常收尾");

// 落盘后同构：.md 里的 system 回合行走 persisted 那条路，措辞与结构必须一致。
const rotationPersisted = buildConversationItems([{
  session: rotationSession,
  output: [
    "这一轮正文已经完整产出。",
    turn("system", diagnosis, "2026-08-10T03:25:00.000Z"),
    turn("system", rotationNote, "2026-08-10T03:26:00.000Z"),
  ].join("\n"),
  trace: [],
}], [rotationSession], []);
assert.deepEqual(
  rotationPersisted.filter((item) => item.kind === "event").map((item) => [item.variant, item.tone, item.text]),
  [["note", "neutral", diagnosis], ["note", "neutral", rotationNote]],
  "刷新之后轮换说明仍是中性旁注",
);

// 团队「停止全组」的收尾更正：轮换不该在这条路上又变回红色（第 2 轮审查 P1 第二层）。
const haltCorrection = `更正上面那条:CLI 会话接不回了。${SESSION_POISONED_NOTE}`;
const halted = buildConversationItems([{
  session: rotationSession,
  output: [
    "这一轮正文已经完整产出。",
    turn("system", "〔系统〕你按了「停止全组」:调度台进程与所有在跑的执行者都已停止,执行者可从中断处恢复。调度者这条 CLI 会话已经作废,再说一句话会开一条全新会话(之前的上下文不带过去)。", "2026-08-10T03:27:00.000Z"),
    turn("system", haltCorrection, "2026-08-10T03:28:00.000Z"),
  ].join("\n"),
  trace: [],
}], [rotationSession], []);
assert.deepEqual(
  halted.filter((item) => item.kind === "event").map((item) => [item.variant, item.tone]),
  [["note", "neutral"], ["note", "neutral"]],
  "停止全组之后的轮换说明不许报红",
);
assert.deepEqual(
  halted.flatMap((item) => item.kind === "agent"
    ? item.segments.flatMap((segment) => segment.events.filter((e) => e.kind === "error"))
    : []),
  [],
  "停止全组不该给健康回合挂上「执行过程 · 1 异常」",
);

// 兜底：万一还有哪条直播路径漏转，模型自己也不许把 session-scope error 渲染成异常。
const rawScoped = buildConversationItems(
  [{ session: rotationSession, output: "这一轮正文已经完整产出。", trace: [] }],
  [rotationSession],
  [{
    kind: "server",
    id: "live:scoped-error",
    event: {
      type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex",
      event: { kind: "error", message: diagnosis, scope: "session" },
    },
  }],
);
assert.deepEqual(
  rawScoped.flatMap((item) => item.kind === "agent"
    ? item.segments.flatMap((segment) => segment.events.filter((e) => e.kind === "error"))
    : []),
  [],
  "带 scope:\"session\" 的 error 不能落进气泡的异常折叠块",
);
assert.equal(rawScoped.find((item) => item.kind === "event")?.variant, "note");
assert.equal(rawScoped.find((item) => item.kind === "event")?.tone, "neutral");

// —— 辩论旁注不是审查轮的起止 ——
// 「开始辩论第 1 轮审查意见：…」里带着「第 1 轮审查」四个字，被 VERIFY_NOTE 读成一轮
// **就地验证**的开始（前缀「自由工作流」没在，所以还退化成了「验证」），当场开出一张
// 「第 1 轮验证」的卡；而服务端从不为它写就地验证的收尾旁注，那张卡永远停在「进行中」，
// 还吞掉了第 1 段辩论发言（用户 2026-09-24 截图）。四句原文照抄 free-review-debate.ts。
const DEBATE_NOTES = [
  "开始辩论第 1 轮审查意见：3 个来回，审查者（顶级审查）先答辩，最后由它收尾给出立场；结论仍由你裁定。",
  "辩论第 1/7 段：轮到审查者发言（顶级审查）。",
  "辩论第 3 段没能起跑（执行器不可用）；辩论已中止；驳回仍在等你裁定，也可以再开一轮辩论。",
  "辩论结束，审查者收尾立场：维持原意见。这只是它自己的立场，结论仍由你裁定：采纳执行者，或维持审查意见让它照改。",
];
for (const note of DEBATE_NOTES) {
  assert.equal(verifyNoteOf(note), null, `辩论旁注被当成了审查轮的起止：${note.slice(0, 26)}…`);
}
// 真正的审查起止不能被上面那条判据误伤。
assert.deepEqual(verifyNoteOf("自由工作流第 1 轮审查开始：顶级审查 · 逻辑检查。"), { kind: "free", round: 1, phase: "start" });
assert.deepEqual(verifyNoteOf("自由工作流第 1 轮审查未通过，意见已发回会话；修复回合正常结束后自动复审。"), { kind: "free", round: 1, phase: "end" });
assert.deepEqual(verifyNoteOf("第 3 轮验证开始：就在这个任务的工作目录里跑。"), { kind: "inline", round: 3, phase: "start" });

// 端到端：一整条辩论走完，时间线上只该留下那一轮真审查的卡，不该多出一张永远「进行中」的。
const debateSession = {
  id: "s-debate", taskId: "t1", agentType: "claude", role: "main",
  executor: "claude@ccb", startedAt: "2026-09-24T12:00:00.000Z", endedAt: "2026-09-24T15:00:00.000Z",
};
const timeline = [
  "自由工作流第 1 轮审查开始：顶级审查 · 逻辑检查。",
  "自由工作流第 1 轮审查未通过，意见已发回会话；修复回合正常结束后自动复审。",
  ...DEBATE_NOTES.slice(0, 2),
  DEBATE_NOTES[3],
].map((text, index) => `\x1e${JSON.stringify({ t: "system", text, at: `2026-09-24T12:${String(index * 5).padStart(2, "0")}:00.000Z` })}`);
// 审查段的起止按类型认，原文换了说法也不走样；结论与意见条数从类型上拿。
const typedTimeline = [
  [{ kind: "review.start", source: "free", round: 4, reviewer: "顶级审查" }, "派审：换了一种说法"],
  [{ kind: "review.verdict", source: "free", round: 4, verdict: "failed", reviewer: "顶级审查", findings: 3 }, "也换了一种说法"],
].map(([notice, text], index) => `\x1e${JSON.stringify({ t: "system", text, notice, at: `2026-09-24T13:0${index}:00.000Z` })}`);
const typedLanes = conversationFeedRows(
  buildConversationItems([{ session: debateSession, output: typedTimeline.join("\n"), trace: [] }], [debateSession], []),
).filter((row) => row.kind === "review-lane");
assert.equal(typedLanes.length, 1);
assert.deepEqual(
  [typedLanes[0].title, typedLanes[0].complete, typedLanes[0].conclusion, typedLanes[0].findings],
  ["第 4 轮审查", true, "verify_failed", 3],
);

const debateLanes = conversationFeedRows(
  buildConversationItems([{ session: debateSession, output: timeline.join("\n"), trace: [] }], [debateSession], []),
).filter((row) => row.kind === "review-lane");
assert.equal(debateLanes.length, 1, `辩论旁注另开了审查卡：${JSON.stringify(debateLanes.map((lane) => lane.title))}`);
assert.equal(debateLanes[0].title, "第 1 轮审查");
assert.equal(debateLanes[0].complete, true, "唯一那张卡是收了口的；「进行中」说明它等的收尾旁注根本不会来");

console.log("conversation-notes ok");
