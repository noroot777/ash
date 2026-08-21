// 首轮输出里认标题（server/src/auto-title.ts）。
//
// 用例全部照抄 2026-08-21 从库里捞出来的现场：15 个「该被智能体改名却没改成」的单飞
// 任务，逐条读了 data/runs/<taskId>/<sess>.md 的开头。老实现只认简体、只看第一行，
// 12/15 栽在这两条上。这份测试把那 12 条钉住，同时钉住三件不能退让的事：
//   ① 没命中时正文一个字都不能少（标题解析是顺带的，吞正文是重罪）；
//   ② 扫描窗口有上限——正文在结论出来之前不往前端流，无限缓冲等于界面卡住；
//   ③ 命中时标题行要摘干净，不能在正文顶上留个空洞。
//
// 跑法：npm -w server run test:auto-title
import { cleanTitle, parseTitleLine, scanForTitle } from "../src/auto-title.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

const title = (buf: string) => {
  const s = scanForTitle(buf, false);
  return s.kind === "resolved" ? s.title : "(还在攒)";
};
const body = (buf: string) => {
  const s = scanForTitle(buf, false);
  return s.kind === "resolved" ? s.text : "(还在攒)";
};

// ── 单行识别：繁体是头号杀手（9/15） ─────────────────────────────────────────
check("简体", parseTitleLine("标题：合并清理自动验收"), "合并清理自动验收");
check("繁体標題", parseTitleLine("標題：模型胶囊改三段式"), "模型胶囊改三段式");
check("繁体標題（题也繁）", parseTitleLine("標題：验收区按钮位置调整"), "验收区按钮位置调整");
check("半角冒号", parseTitleLine("标题: 新建任务目录选择器"), "新建任务目录选择器");
check("加粗包裹", parseTitleLine("**标题：解释不可运行与审查者模型**"), "解释不可运行与审查者模型");
check("标题里有半角标点也留着", parseTitleLine("標題：删除 ssh 执行器并前置接力按钮"), "删除 ssh 执行器并前置接力按钮");
check("不是标题行", parseTitleLine("I'll look at the image first."), null);
check("只是提到标题两个字", parseTitleLine("我把标题改短了一点"), null);
check("冒号后面空的不算", parseTitleLine("标题："), null);
check("超长截到 30", cleanTitle("一".repeat(40)).length, 30);

// ── 现场一：繁体 + 标题就在第一行（Y-JQb31EliC4 / CkJma6cwpjV0 等 9 例） ────
const traditional = "標題：模型胶囊改三段式\n\nI'll start by reading the reference image.\n";
check("繁体命中", title(traditional), "模型胶囊改三段式");
check("繁体命中后正文不带标题行", body(traditional), "I'll start by reading the reference image.\n");

// ── 现场二：先寒暄一句，标题在第 3 行（NtIurpV7-uMT / 3QbB-TkjAxKw） ────────
const chatty = "I'll look at the image first.\n\n标题：调整任务卡副标题样式\n\n改完了。\n";
check("寒暄之后的标题也认", title(chatty), "调整任务卡副标题样式");
check("摘掉标题行不留空洞", body(chatty), "I'll look at the image first.\n\n改完了。\n");

// ── 现场三：codex 重连诊断（12cTzubGoOQT）。那是 ash 自己注入的引用块，不该吃额度 ──
const diagnostics =
  "> **执行诊断**\n> Reconnecting... 1/5\n\n> **执行诊断**\n> Reconnecting... 2/5\n\n标题：用脚本重启 ash\n\n好的。\n";
check("引用块不计入行数预算", title(diagnostics), "用脚本重启 ash");

// ── 窗口上限：越过就放弃，正文原样放行 ───────────────────────────────────────
const late = "a\nb\nc\nd\ne\nf\n标题：太晚了\n";
check("超过 5 个正文行就不再找", title(late), null);
check("放弃时正文一个字不少", body(late), late);
// 行数没超但攒得太长：不能为了等标题把一整屏正文扣在手里。
const long = `${"x".repeat(400)}\n${"y".repeat(400)}\n${"z".repeat(400)}\n`;
check("超过字数上限也放弃", title(long), null);
check("超长时正文一个字不少", body(long), long);

// ── 缓冲语义：结论没出来之前不能吐正文，也不能拿半行去匹配 ───────────────────
check("首行还没写完就等着", scanForTitle("标题：还没", false).kind, "buffer");
check("第一行写完了就有结论", scanForTitle("标题：写完了\n", false).kind, "resolved");
// 窗口没走完就还有机会——寒暄那一例正是靠这个才等到第 3 行的标题。
check("一行不像标题也不急着放弃", scanForTitle("我看一下。\n", false).kind, "buffer");
check("流结束时半行也要给结论", scanForTitle("标题：没有换行", true), {
  kind: "resolved", title: "没有换行", text: "",
});
check("流结束时认不出来就原样吐出", scanForTitle("干完了。", true), {
  kind: "resolved", title: null, text: "干完了。",
});
check("空缓冲不炸", scanForTitle("", true), { kind: "resolved", title: null, text: "" });

// ── 没有标题行的两例（401 / 秒停）：救不回来，但正文必须完好 ─────────────────
const failed = "Failed to authenticate. API Error: 401 OAuth authentication is currently not supported.\n";
check("认证失败那轮解析不出标题", scanForTitle(failed, true), {
  kind: "resolved", title: null, text: failed,
});

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
