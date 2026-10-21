// 手机端看不看得见「上游在重试 / 已经等了 N 分钟」。跑：cd mobile && npm run test:session-notices
// （mobile 不是 npm workspace 成员，自己一套 node_modules，所以不走 `npm -w`。）
//
// 起因（2026-10-21 第 1 轮审查 F3）：这些提示原先是 `.md` 里的 system 旁注，手机那条「每
// 几秒重拉一次 .md」顺带就看到了。为了让桌面端把它们排在出问题的那一步下面，服务端把它们
// 挪进了 trace —— 而手机压根不读 trace，于是桌面有的东西手机一条都看不到。
//
// 现在它们走 `GET /sessions/:id/notices` 这个窄出口，由 mergeSessionNotices 并回时间线。
// 这份用例钉三件事：并回去了、位置按「发生在哪一轮」算、还在跑的那一轮落在末尾。
import assert from "node:assert/strict";
import { mergeSessionNotices, snapshotToLogLines } from "../src/lib/log.ts";

const sentinel = (obj) => "\x1e" + JSON.stringify(obj);
// 两轮：第一轮在 02:00:10 收口，第二轮还在跑（没有 agentEnd 标）。
const md = [
  "第一轮的回答。",
  sentinel({ t: "agentEnd", at: "2026-10-21T02:00:10.000Z" }),
  sentinel({ t: "user", text: "继续", at: "2026-10-21T02:00:20.000Z" }),
  "第二轮正在说的话。",
].join("\n");

const RETRY = "上游返回 502 server_error，正在重试（第 1/10 次，等 0.6 秒）";
const WAITING = "已经等上游 5 分钟没有响应，本回合仍在等待中";
const lines = mergeSessionNotices(
  snapshotToLogLines(md, "sess-1", "claude"),
  [
    // 故意倒序给进去：出口不保证顺序，位置得按 at 自己算。
    { at: "2026-10-21T02:00:30.000Z", text: WAITING },
    { at: "2026-10-21T02:00:05.000Z", text: RETRY },
  ],
  "sess-1",
);

const shape = lines.map((line) => `${line.kind}:${line.text.slice(0, 6)}`);
assert.deepEqual(
  shape,
  [
    "text:第一轮的回答",
    `system:${RETRY.slice(0, 6)}`, // 02:00:05 发生在第一轮里 → 紧跟那一轮
    "user:继续",
    "text:第二轮正在说",
    `system:${WAITING.slice(0, 6)}`, // 02:00:30 在还没收口的第二轮里 → 末尾
  ],
  `提示没有回到它发生的那一轮：${JSON.stringify(shape)}`,
);

const notices = lines.filter((line) => line.kind === "system");
assert.ok(notices.every((line) => line.aside === true),
  "提示没标成旁注 —— 它落在哪一秒纯属偶然，当成回合边界会把正在说的那颗气泡劈成两半");
assert.equal(new Set(notices.map((line) => line.sessionId)).size, 2,
  "两条提示共用一个 sessionId，会被归成同一颗气泡");
assert.deepEqual(notices.map((line) => line.at), ["2026-10-21T02:00:05.000Z", "2026-10-21T02:00:30.000Z"],
  "提示丢了自己的时刻，界面上就没法说它是什么时候的事");

// 一条都没有时原样返回（绝大多数会话都是这种），别白复制一遍数组。
const plain = snapshotToLogLines(md, "sess-1", "claude");
assert.equal(mergeSessionNotices(plain, [], "sess-1"), plain);

// 正文还一个字都没有、只等到一条重试提示：那正是最该让人看到「它卡在上游」的时候。
assert.deepEqual(
  mergeSessionNotices([], [{ at: "2026-10-21T02:00:05.000Z", text: RETRY }], "sess-1")
    .map((line) => `${line.kind}:${line.text}`),
  [`system:${RETRY}`],
  "一条正文都还没有时，提示被整条丢掉了",
);

console.log("mobile session notices ok：提示并回各自那一轮，在跑的那一轮落在末尾");
