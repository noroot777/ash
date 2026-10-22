// 手机端看不看得见「上游在重试 / 已经等了 N 分钟」。跑：cd mobile && npm run test:session-notices
// （mobile 不是 npm workspace 成员，自己一套 node_modules，所以不走 `npm -w`。）
//
// 起因（2026-10-21 第 1 轮审查 F3）：这些提示原先是 `.md` 里的 system 旁注，手机那条「每
// 几秒重拉一次 .md」顺带就看到了。为了让桌面端把它们排在出问题的那一步下面，服务端把它们
// 挪进了 trace —— 而手机压根不读 trace，于是桌面有的东西手机一条都看不到。
//
// 现在它们走 `GET /sessions/:id/notices` 这个窄出口，由 mergeSessionNotices 接回时间线。
// 出口给的只有「此刻还在等」和「这一轮真失败了」两种（server 的 session-waiting.ts 已经筛
// 过），都是此刻的状态，所以这边的位置只能是末尾 —— 第 2 轮审查 F1 打掉的正是「按正文的
// 结束时间猜它属于哪一轮」：`.md` 里
// 只有 agentEnd 一个时间戳，一轮压根没出正文（光调工具、或者就卡在重试上）时猜出来的位置会
// 把提示塞到下一轮的回答后面，又变回用户要治的「堆在会话结尾的一坨」。
import assert from "node:assert/strict";
import { mergeSessionNotices, snapshotToLogLines } from "../src/lib/log.ts";

const sentinel = (obj) => "\x1e" + JSON.stringify(obj);
const TURN_1 = "2026-10-21T02:00:00.000Z";
const TURN_2 = "2026-10-21T02:00:20.000Z";
// 两轮：第一轮在 02:00:10 收口，第二轮还在跑（没有 agentEnd 标）。
const md = [
  "第一轮的回答。",
  sentinel({ t: "agentEnd", at: "2026-10-21T02:00:10.000Z" }),
  sentinel({ t: "user", text: "继续", at: TURN_2 }),
  "第二轮正在说的话。",
].join("\n");

const RETRY = "上游返回 502 server_error，正在重试（第 1/10 次，等 0.6 秒）";
const WAITING = "已经等上游 5 分钟没有响应，本回合仍在等待中";
const lines = mergeSessionNotices(
  snapshotToLogLines(md, "sess-1", "claude"),
  [
    // 故意倒序给进去：出口不保证顺序，这边自己按 at 排。
    { at: "2026-10-21T02:00:30.000Z", turnStartedAt: TURN_2, text: WAITING },
    { at: "2026-10-21T02:00:25.000Z", turnStartedAt: TURN_2, text: RETRY },
  ],
  "sess-1",
);

const shape = lines.map((line) => `${line.kind}:${line.text.slice(0, 6)}`);
assert.deepEqual(
  shape,
  [
    "text:第一轮的回答",
    "user:继续",
    "text:第二轮正在说",
    `system:${RETRY.slice(0, 6)}`, // 两条都还悬着 → 按发生顺序排在末尾
    `system:${WAITING.slice(0, 6)}`,
  ],
  `还悬着的提示没有接在时间线末尾：${JSON.stringify(shape)}`,
);

const notices = lines.filter((line) => line.kind === "system");
assert.ok(notices.every((line) => line.aside === true),
  "提示没标成旁注 —— 它不是 agent 说的话，不标就会把正在流式输出的那颗气泡从中间劈开");
assert.equal(new Set(notices.map((line) => line.sessionId)).size, 2,
  "两条提示共用一个 sessionId，会被归成同一颗气泡");
assert.deepEqual(notices.map((line) => line.at), ["2026-10-21T02:00:25.000Z", "2026-10-21T02:00:30.000Z"],
  "提示丢了自己的时刻，界面上就没法说它是什么时候的事");

// 这一轮压根没出正文（卡在上游重试上，整轮只有工具调用）：手机端只有 `.md`，这一轮在它里面
// 一个字都没有，所以「按正文定位」这条路在这里根本没有落点 —— 第 2 轮审查 F1 说的就是这个。
// 位置只认「服务端说它还悬着」，与正文有没有、什么时候结束无关。
const noText = mergeSessionNotices(
  snapshotToLogLines([
    "上一轮的回答。",
    sentinel({ t: "agentEnd", at: "2026-10-21T02:00:10.000Z" }),
    sentinel({ t: "user", text: "接着查", at: TURN_2 }),
  ].join("\n"), "sess-2", "claude"),
  [{ at: "2026-10-21T02:00:25.000Z", turnStartedAt: TURN_2, text: RETRY }],
  "sess-2",
);
assert.deepEqual(
  noText.map((line) => `${line.kind}:${line.text.slice(0, 6)}`),
  ["text:上一轮的回答", "user:接着查", `system:${RETRY.slice(0, 6)}`],
  "这一轮还没说出正文，提示却被排到了上一轮的回答后面",
);

// 一条都没有时原样返回（绝大多数会话都是这种），别白复制一遍数组。
const plain = snapshotToLogLines(md, "sess-1", "claude");
assert.equal(mergeSessionNotices(plain, [], "sess-1"), plain);

// 正文还一个字都没有、只等到一条重试提示：那正是最该让人看到「它卡在上游」的时候。
assert.deepEqual(
  mergeSessionNotices([], [{ at: "2026-10-21T02:00:05.000Z", turnStartedAt: TURN_1, text: RETRY }], "sess-1")
    .map((line) => `${line.kind}:${line.text}`),
  [`system:${RETRY}`],
  "一条正文都还没有时，提示被整条丢掉了",
);

console.log("mobile session notices ok：还悬着的提示接在时间线末尾，不按正文时间猜归属");
