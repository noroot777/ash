// 回合折叠的切点。
//
// 折叠把「过程」收起来、只留「结论」，切点是最后一次真正动手的地方。踩过的坑是拿
// **最后一次工具事件**当切点：ash 的 complete_task 在正文写完之后才调，全库 22% 的回合
// 切点是它 —— 于是整篇报告被折进过程，外面只剩收尾那一句。待办清单的 TaskUpdate
// （载荷就是把某条划掉）是同一个毛病的另一副面孔。
import assert from "node:assert/strict";
import { splitTurnSegments } from "../src/task-detail/turnFold.ts";

const segment = (id, { markdown = "", events = [], attachments = [] } = {}) => ({ id, markdown, events, attachments });
const tool = (label) => ({ kind: "tool", label });
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

console.log("turn fold tests passed");
