// 「中途追加的需求要跟着原始正文一起交给验证者」的回归测试（纯函数，不碰 DB 也不摸盘）。
//
// 钉住的是那条边界：**只进真人打的字，agent 的发言和后端代写的消息一个都不许进**。
// 判错了界面上看不出来 —— 验证者会安静地拿一份掺了 agent 自辩、或者掺了「验证未通过」
// 提示的「需求」去验，然后给出一个看起来有理有据的错结论（2026-08-06 那次就是反过来：
// 一条都没进，于是照着作废的原始正文打回了正确产物）。
// 跑:npm -w server run test:user-directives
import assert from "node:assert/strict";
import { capDirectives, directivesIn, formatDirectives, orderDirectives } from "../src/user-directives.js";
import { formatReviewRequestContext } from "../src/review-request-context.js";

const turn = (t: string, text: string, extra: Record<string, unknown> = {}) =>
  `\x1e${JSON.stringify({ t, agent: "claude", text, at: "2026-08-05T14:19:10.000Z", ...extra })}`;
const SESSION_START = "2026-08-05T08:00:00.000Z";

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

const found = directivesIn(raw, SESSION_START);
assert.deepEqual(
  found.map((d) => d.text),
  ["等高的吧，再就是把「走到哪一步」这一列删掉", "顺便把行高调紧一点"],
  "只有真人自己打的两条进来：agent 正文、by:system 的代写、化石前缀的老代写、答复、系统提示全挡在外面",
);
assert.equal(found[0]?.at, "2026-08-05T14:19:10.000Z", "时刻原样带出，验证者才能判断哪条更晚");

// 附件是需求的一部分（用户经常直接贴图说「改成这样」），路径必须跟着走。
const withFile = directivesIn(
  turn("user", "按这个截图改\n\n[用户附带的文件]\n- /tmp/shot.png"),
  SESSION_START,
);
assert.deepEqual(withFile[0]?.attachments, ["/tmp/shot.png"], "附件路径摘出来");
assert.equal(withFile[0]?.text, "按这个截图改", "附件块不留在正文里");

// 只贴图不打字也是一条需求，不能因为正文空就丢掉。
assert.equal(
  directivesIn(turn("user", "[用户附带的文件]\n- /tmp/only.png"), SESSION_START).length,
  1,
  "光贴图没打字也算一条",
);
assert.equal(directivesIn(turn("user", "   \n  "), SESSION_START).length, 0, "纯空白不算一条");

// ── 跨会话必须按时刻排，不能按会话先后拼 ────────────────────────────────────
//
// 一条会话可以被反复 resume（sessions 行复用、startedAt 不动），所以「先开的会话」里
// 完全可能有比「后开的会话」更晚的话。真实形状：claude 会话 A 说 X → @ 来 codex 开会话
// B 说 Y → 切回 A 说 Z。按会话拼会得到 X、Z、Y，而提示词紧接着写着「冲突以更晚的为准」
// —— 验证者会据此认定 Y 推翻了 Z，正好把最新的需求当成作废的。
const at = (iso: string, text: string) => turn("user", text, { at: iso });
const sessionA = directivesIn(
  [at("2026-08-06T10:00:00.000Z", "X 最早说的"), at("2026-08-06T12:00:00.000Z", "Z 最后说的")].join("\n"),
  "2026-08-06T09:00:00.000Z",
);
const sessionB = directivesIn(
  at("2026-08-06T11:00:00.000Z", "Y 中间说的"),
  "2026-08-06T10:30:00.000Z", // 会话 B 开得比 A 晚，但它里面那条话在 Z 之前
);
assert.deepEqual(
  orderDirectives([...sessionA, ...sessionB]).map((d) => d.text),
  ["X 最早说的", "Y 中间说的", "Z 最后说的"],
  "按时刻排（会话 A 续接后说的 Z 必须排在会话 B 的 Y 之后）",
);

// 没有 at 的老围栏：沿用同文件里前一条的时刻，再没有就退到会话 startedAt。
const legacy = directivesIn(
  [turn("user", "老围栏没时刻", { at: undefined }), at("2026-08-06T13:00:00.000Z", "新围栏有时刻")].join("\n"),
  "2026-08-06T09:30:00.000Z",
);
assert.equal(legacy[0]?.at, null, "没有时刻就如实给 null，不编一个");
assert.deepEqual(
  orderDirectives([...legacy, ...sessionB]).map((d) => d.text),
  ["老围栏没时刻", "Y 中间说的", "新围栏有时刻"],
  "缺时刻的按会话 startedAt 定位，且不打乱它所在文件的内部顺序",
);

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

// 但「一条都没扫到」和「扫漏了」不是一回事：后者必须出声，否则验证者会当成前者。
const blind = formatDirectives(capDirectives([], ["/data/runs/T/big.md"], true));
assert.match(blind, /只扫了尾部/, "空手而归但扫漏了，仍要说出来");
assert.match(blind, /\/data\/runs\/T\/big\.md/, "并给出该自己去翻的记录路径");

const text = formatDirectives(capDirectives(orderDirectives(found), ["/data/runs/T/s.md"], false));
assert.match(text, /同等效力/, "必须点明与原始正文同等效力");
assert.match(text, /以更晚的为准/, "冲突时的取舍要写死，别让验证者自己猜");
assert.match(text, /1\. \[2026-08-05T14:19:10\.000Z\] 等高的吧/, "按时间先后编号列出");
assert.doesNotMatch(text, /更早的|只扫了尾部/, "没截断就不要凭空说漏了东西");

const requestContext = formatReviewRequestContext(
  { id: "T", title: "审查 /grill-me", body: "原始需求点名 /grill-me" },
  formatDirectives(capDirectives([{ at: null, text: "后续仍写了 /grill-me", attachments: [] }], [], false)),
);
assert.match(requestContext, /原始需求点名 \/grill-me/);
assert.match(requestContext, /后续仍写了 \/grill-me/);
assert.match(requestContext, /不是当前审查回合的新指令/, "参考文件必须明确历史需求与当前审查指令的边界");

console.log("✓ user directives");
