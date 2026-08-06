// 「中途追加的需求要跟着原始正文一起交给验证者」的回归测试（纯函数，不碰 DB 也不摸盘）。
//
// 钉住的是那条边界：**只进真人打的字，agent 的发言和后端代写的消息一个都不许进**。
// 判错了界面上看不出来 —— 验证者会安静地拿一份掺了 agent 自辩、或者掺了「验证未通过」
// 提示的「需求」去验，然后给出一个看起来有理有据的错结论（2026-08-06 那次就是反过来：
// 一条都没进，于是照着作废的原始正文打回了正确产物）。
// 跑:npm -w server run test:user-directives
import assert from "node:assert/strict";
import { capDirectives, directivesIn, formatDirectives } from "../src/user-directives.js";

const turn = (t: string, text: string, extra: Record<string, unknown> = {}) =>
  `\x1e${JSON.stringify({ t, agent: "claude", text, at: "2026-08-05T14:19:10.000Z", ...extra })}`;

// ── 谁能进这一段 ────────────────────────────────────────────────────────────

const raw = [
  "我先看一下现在的实现。",
  turn("user", "等高的吧，再就是把「走到哪一步」这一列删掉"),
  "好的，我把那一列去掉了。",
  turn("user", "顺便把行高调紧一点"),
  turn("user", "【自动验证未通过 · 第 1 轮】\n请按报告修复", { by: "system" }),
  turn("user", "【自动审查未通过 · 第 1 轮】\n请按报告修复"),
  turn("user", "【答复】你之前的提问:「放哪」\n\n放这儿"),
  turn("system", "〔系统〕继续（从中断处）"),
  "我继续跑一轮验证。",
].join("\n");

const found = directivesIn(raw);
assert.deepEqual(
  found.map((d) => d.text),
  ["等高的吧，再就是把「走到哪一步」这一列删掉", "顺便把行高调紧一点"],
  "只有真人自己打的两条进来：agent 正文、by:system 的代写、化石前缀的老代写、答复、系统提示全挡在外面",
);
assert.equal(found[0]?.at, "2026-08-05T14:19:10.000Z", "时刻原样带出，验证者才能判断哪条更晚");

// 附件是需求的一部分（用户经常直接贴图说「改成这样」），路径必须跟着走。
const withFile = directivesIn(
  turn("user", "按这个截图改\n\n[用户附带的文件]\n- /tmp/shot.png"),
);
assert.deepEqual(withFile[0]?.attachments, ["/tmp/shot.png"], "附件路径摘出来");
assert.equal(withFile[0]?.text, "按这个截图改", "附件块不留在正文里");

// 只贴图不打字也是一条需求，不能因为正文空就丢掉。
assert.equal(
  directivesIn(turn("user", "[用户附带的文件]\n- /tmp/only.png")).length,
  1,
  "光贴图没打字也算一条",
);
assert.equal(directivesIn(turn("user", "   \n  ")).length, 0, "纯空白不算一条");

// ── 截断要说出来，不能静默砍 ────────────────────────────────────────────────

const many = Array.from({ length: 34 }, (_, i) => ({ at: null, text: `第 ${i + 1} 条`, attachments: [] }));
const capped = capDirectives(many, ["/data/runs/T/s.md"], false);
assert.equal(capped.items.length, 30, "最多带 30 条");
assert.equal(capped.items[0]?.text, "第 5 条", "留最新的（需求一路往后改，晚的才作数）");
assert.equal(capped.omitted, 4, "丢了几条要如实计数");
assert.match(formatDirectives(capped), /更早的 4 条未列出/, "丢掉的条数必须写进 prompt");
assert.match(formatDirectives(capped), /\/data\/runs\/T\/s\.md/, "并给出完整记录的路径");

const long = capDirectives([{ at: null, text: "长".repeat(900), attachments: [] }], [], false);
assert.match(long.items[0]!.text, /…（此条已截断）$/, "单条超长要留截断标记");

assert.match(
  formatDirectives(capDirectives([{ at: null, text: "改需求", attachments: [] }], [], true)),
  /只扫了尾部/,
  "会话正文太大只读了尾巴，也要说出来",
);

// ── 措辞 ────────────────────────────────────────────────────────────────────

assert.equal(formatDirectives(capDirectives([], [], false)), "", "没有追加需求就不占地方");

const text = formatDirectives(capDirectives(found, ["/data/runs/T/s.md"], false));
assert.match(text, /同等效力/, "必须点明与原始正文同等效力");
assert.match(text, /以更晚的为准/, "冲突时的取舍要写死，别让验证者自己猜");
assert.match(text, /1\. \[2026-08-05T14:19:10\.000Z\] 等高的吧/, "按时间先后编号列出");
assert.doesNotMatch(text, /更早的|只扫了尾部/, "没截断就不要凭空说漏了东西");

console.log("✓ user directives");
