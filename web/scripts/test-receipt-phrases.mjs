// 「N 条记录」里那几句说人话，每一条带一枚图标（timelineNoticeCopy + noticePhrases）。
import assert from "node:assert/strict";
import { noticeView } from "../src/task-detail/timelineNoticeCopy.ts";

const legacy = (text, tone = "neutral") => noticeView({ text, tone, variant: "note" });
const typed = (notice, text = "原文") => noticeView({ text, tone: "neutral", variant: "note", notice });
const held = "本回合要落的终态被拦下，改为检查点暂停：还有 1 个哨兵没了结（回归测试 未完成）";

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
assert.deepEqual(
  (({ icon, text }) => [icon, text])(typed({ kind: "monitor.handed", via: "pause", monitorWake: { monitors: [] } })),
  ["monitor", "哨兵结果在这一回合里交给了它"],
  "回合里就交到手上的那一句同样是哨兵那一枚",
);
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

console.log("receipt-phrases ok");
