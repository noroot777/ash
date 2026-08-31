// 回合折叠的切点。
//
// 折叠把「过程」收起来、只留「结论」，切点是最后一次真正动手的地方。踩过的坑是拿
// **最后一次工具事件**当切点：ash 的 complete_task 在正文写完之后才调，全库 22% 的回合
// 切点是它 —— 于是整篇报告被折进过程，外面只剩收尾那一句。待办清单的 TaskUpdate
// （载荷就是把某条划掉）是同一个毛病的另一副面孔。
import assert from "node:assert/strict";
import { splitTurnSegments, nextProcessFoldOpen } from "../src/task-detail/turnFold.ts";
import { isExecutionChainLive } from "../src/lib/taskAttention.ts";

const segment = (id, { markdown = "", events = [], attachments = [] } = {}) => ({ id, markdown, events, attachments });
const tool = (label) => ({ kind: "tool", label });
const error = (label) => ({ kind: "error", label });
const text = (segments) => segments.map((item) => item.markdown).join("|");
const labels = (segments) => segments.flatMap((item) => item.events).map((event) => event.label).join(",");

// 1. 基本形状：干活 → 说话。事件归过程，正文归结论。
{
  const { process, conclusion } = splitTurnSegments([
    segment("a", { markdown: "先看一圈。" }),
    segment("b", { events: [tool("Bash")], markdown: "改好了。" }),
  ]);
  assert.equal(text(process), "先看一圈。|");
  assert.equal(text(conclusion), "改好了。");
  assert.equal(labels(process), "Bash");
}

// 2. 切点落在一段之内：事件后面紧跟的正文是结论，不能跟着事件一起折没。
{
  const { conclusion } = splitTurnSegments([
    segment("a", { events: [tool("Bash")], markdown: "第 2 轮结论：verify_failed。" }),
  ]);
  assert.equal(text(conclusion), "第 2 轮结论：verify_failed。");
}

// 3. complete_task 不当切点：整篇报告要留在外面，只有收尾那句在它后面。
{
  const { process, conclusion } = splitTurnSegments([
    segment("a", { events: [tool("Bash")], markdown: "排查完成，结论如上：400k 压缩设置生效无误。" }),
    segment("b", { events: [tool("mcp__harness__complete_task")] }),
    segment("c", { markdown: "工作区干净。" }),
  ]);
  assert.equal(text(conclusion), "排查完成，结论如上：400k 压缩设置生效无误。||工作区干净。");
  // 记账那步并进过程块，不留在报告和收尾句中间夹一条「执行过程 · 1 工具」。
  assert.equal(labels(conclusion), "");
  assert.equal(labels(process), "Bash,mcp__harness__complete_task");
}

// 4. 服务名的四种写法都认（claude 的 mcp__x__y、codex 的 x/y，新旧两个服务名）。
for (const label of [
  "mcp__ash__complete_task",
  "mcp__harness__complete_task",
  "ash/report_stage",
  "harness/report_stage",
]) {
  const { conclusion } = splitTurnSegments([
    segment("a", { events: [tool("exec")], markdown: "干完了。" }),
    segment("b", { events: [tool(label)] }),
    segment("c", { markdown: "收尾。" }),
  ]);
  assert.equal(text(conclusion), "干完了。||收尾。", `${label} 应当不算切点`);
}

// 5. 待办记账同样不算数。
{
  const { conclusion } = splitTurnSegments([
    segment("a", { events: [tool("Edit")], markdown: "三处都改了。" }),
    segment("b", { events: [tool("TaskUpdate")] }),
    segment("c", { markdown: "全部完成。" }),
  ]);
  assert.equal(text(conclusion), "三处都改了。||全部完成。");
}

// 6. 同一个 ash MCP 里「拿它干活」的调用照旧算切点 —— 判据是有没有改变现场，
//    不是它属不属于本项目的 MCP。
{
  const { process, conclusion } = splitTurnSegments([
    segment("a", { markdown: "先拆一下。" }),
    segment("b", { events: [tool("mcp__harness__dispatch")], markdown: "已派 3 个执行者。" }),
  ]);
  assert.equal(text(process), "先拆一下。|");
  assert.equal(text(conclusion), "已派 3 个执行者。");
}

// 7. 折完一个字不剩就不折：跑完工具没再说话的回合维持原样。
{
  const segments = [segment("a", { markdown: "开始。" }), segment("b", { events: [tool("Bash")] })];
  const { process, conclusion } = splitTurnSegments(segments);
  assert.equal(process.length, 0);
  assert.equal(conclusion, segments);
}

// 8. 通篇只有记账（答个问题就 complete_task）：没有动手过，不折。
{
  const segments = [
    segment("a", { markdown: "答案是 B。" }),
    segment("b", { events: [tool("mcp__harness__complete_task")] }),
  ];
  const { process, conclusion } = splitTurnSegments(segments);
  assert.equal(process.length, 0);
  assert.equal(conclusion, segments);
}

// 9. 一个事件都没有的回合原样返回。
{
  const segments = [segment("a", { markdown: "只是聊两句。" })];
  assert.equal(splitTurnSegments(segments).conclusion, segments);
}

// 10. 附件跟着结论走：截图是回答的一部分，不该被折进过程。
{
  const { conclusion } = splitTurnSegments([
    segment("a", { events: [tool("Bash")], attachments: ["shot.png"], markdown: "复现如图。" }),
  ]);
  assert.deepEqual(conclusion[0].attachments, ["shot.png"]);
}

// 11. 结算补的那条异常不当切点。未确认完成时 server 在正文写完之后才写 settled.note
//     （.md 里是一段引用，trace 里是一条 error），拿它当切点就把整篇回答折进过程，
//     外面只剩那句失败提示 —— 现场原状：15 次工具 + 长篇回答，用户只能看到红字。
{
  const { process, conclusion } = splitTurnSegments([
    segment("a", { events: [tool("Bash")], markdown: "答（只回答，未改代码）：会覆盖，而且只有一个槽。" }),
    segment("b", { events: [error("回合正常结束,但本回合内没有收到 complete_task 的完成确认")], markdown: "> 回合正常结束,但……" }),
  ]);
  assert.equal(text(conclusion), "答（只回答，未改代码）：会覆盖，而且只有一个槽。|> 回合正常结束,但……");
  assert.equal(labels(conclusion), "");
  // 异常并进过程块末尾：折叠条照旧标红（hasExecutionError 看的就是这份 events）。
  assert.equal(labels(process), "Bash,回合正常结束,但本回合内没有收到 complete_task 的完成确认");
}

// 12. 失败回合一个字都没说（只有失败说明那段引用）：照样折，工具收进去、说明留在外面。
{
  const { process, conclusion } = splitTurnSegments([
    segment("a", { events: [tool("Bash")] }),
    segment("b", { events: [error("执行异常结束")], markdown: "> 执行异常结束 · exit 1" }),
  ]);
  assert.equal(text(conclusion), "|> 执行异常结束 · exit 1");
  assert.equal(labels(process), "Bash,执行异常结束");
}

// 13. 通篇只有异常（连工具都没跑成）：没有动手过，不折。
{
  const segments = [
    segment("a", { markdown: "刚要开工。" }),
    segment("b", { events: [error("执行异常结束")] }),
  ];
  const { process, conclusion } = splitTurnSegments(segments);
  assert.equal(process.length, 0);
  assert.equal(conclusion, segments);
}

// 14. 自动开合的时机（渲染结果由 test:turn-fold-dom 钉住，这里钉判据本身）。
{
  const open = (running, taskLive, touched = false) => nextProcessFoldOpen({ running, taskLive, touched });
  // 在飞就摊开。
  assert.equal(open(true, true), true);
  // 最后一步确认执行完了：这一下才收。
  assert.equal(open(false, false), false);
  // 回合收口但任务还在跑（换轮、就地验证、endedAt 落下来那一瞬）：什么都不做。跟着它
  // 折，用户会在跑的中途被反复折叠，正读着的那段过程说没就没了。
  assert.equal(open(false, true), null);
  // 用户自己动过折角之后，两个方向都不再自动。
  assert.equal(open(true, true, true), null);
  assert.equal(open(false, false, true), null);
}

// 15. 「执行链路还没停」这一问必须走仓库已有的那份口径（taskAttention 的
//     isExecutionChainLive，两个会话流用的就是它），别在折叠这儿另起一套。两个现场：
//     审查门（awaiting_review）和「调度台 idle、执行者还在干活」的团队 —— 都还没走到
//     「最后一步确认执行完了」，回合收口了也不许折。
{
  const lead = { id: "lead", mode: "team", parentId: null, status: "idle" };
  const worker = (status) => ({ id: `w-${status}`, mode: "single", parentId: "lead", status });
  const single = (status) => ({ id: "t", mode: "single", parentId: null, status });
  // 单飞卡在审查门上：链路还没停。
  assert.equal(isExecutionChainLive(single("awaiting_review")), true);
  assert.equal(isExecutionChainLive(single("running")), true);
  assert.equal(nextProcessFoldOpen({ running: false, taskLive: true, touched: false }), null);
  // 停在检查点 / 等人答话也是活在半路：ask_question 和 pause_task 都落 paused，那不是
  // 完成确认，后面还要 resume 接着跑。跟同文件 awaitsYourWord 是同一句话。
  assert.equal(isExecutionChainLive(single("paused")), true);
  assert.equal(isExecutionChainLive({ ...single("running"), question: "选 A 还是 B？" }), true);
  assert.equal(isExecutionChainLive({ ...single("failed"), question: "选 A 还是 B？" }), true);
  // 团队：调度台派完活就落回 idle，得连执行者一起看。paused 的执行者也算这一队没落地
  //（跟 shared 的 isTeamSettled 同一个口径）。
  assert.equal(isExecutionChainLive(lead, [worker("running")]), true);
  assert.equal(isExecutionChainLive(lead, [worker("queued")]), true);
  assert.equal(isExecutionChainLive(lead, [worker("paused")]), true);
  // 全队收工了才是真停下来 —— 这一下才折。
  assert.equal(isExecutionChainLive(lead, [worker("done")]), false);
  assert.equal(isExecutionChainLive(single("done")), false);
  assert.equal(isExecutionChainLive(single("failed")), false);
  assert.equal(nextProcessFoldOpen({ running: false, taskLive: false, touched: false }), false);
}

console.log("turn fold tests passed");