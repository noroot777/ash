// 贴底跟随的判据（纯函数那一半；真实 DOM 那一半在 test-stick-to-bottom-dom.mjs）。
//
// 两个判据各管一头：
// - `stickStateAfterScroll`：这一次滚动之后，接下来还跟不跟。
// - `shouldStickToBottom`：这一次机会要不要真的动 scrollTop。
// - `tailKeyOf`：「末尾多了要看的东西」这个信号怎么算 —— 由拿着会话数据的人算，
//   不让贴底逻辑自己去 DOM 上猜（猜过一版，复制按钮闪一下就把人拽到底了）。
import assert from "node:assert/strict";
import { shouldStickToBottom, stickStateAfterScroll, tailKeyOf } from "../src/lib/useStickToBottom.ts";

// 用户从底部按住滚动条向上拖时，pointerdown 会建立 detaching user intent。
// 随后的 scroll 必须解除贴底；内容 resize/mutation 只能在 stuck=true 时补滚，
// 因而此状态会保持在历史位置，不被下一段流式输出抢回底部。
assert.equal(stickStateAfterScroll({
  stuck: true,
  nearBottom: false,
  programmatic: false,
  userDriven: true,
  detaching: true,
}), false);
assert.equal(stickStateAfterScroll({
  stuck: false,
  nearBottom: false,
  programmatic: false,
  userDriven: false,
  detaching: false,
}), false);

// 贴底的第二道闸:要不要真的动 scrollTop。用户手滚到离底 40px 停住,尾部没来新东西、
// 底边也没往下跑,这时候再 scrollTo 就是把他从停的位置拽到最底 —— 那一跳正是「快到底
// 时画面突然蹦一下」的来源,必须闸住。
const stick = (over) => shouldStickToBottom({ stuck: true, tailAppended: false, previousMax: 5000, currentMax: 5000, distance: 40, ...over });
assert.equal(stick({}), false);
// 来了新内容(底边往下跑了)才跟过去,这是贴底唯一该做的事。
assert.equal(stick({ currentMax: 5200, distance: 240 }), true);
// 容器被回复框挤矮同样让底边往下跑,也要跟。
assert.equal(stick({ currentMax: 5120, distance: 120 }), true);
// 人在上面读历史时一律不跟。
assert.equal(stick({ stuck: false, currentMax: 5200, distance: 900 }), false);
// 已经贴着底了就别再发一次 scrollTo:那会把浏览器正在跑的平滑滚动掐断。
assert.equal(stick({ currentMax: 5200, distance: 0 }), false);
// 群聊/侧聊/助手只留最近 500 条:追加一条的同时最老那条被删掉,总高**纹丝不动**甚至
// 变短。这一帧恰恰最该跟过去,只看总高会把新回复整个漏在屏幕下面(审查 F1)。
assert.equal(stick({ tailAppended: true, distance: 79 }), true);
assert.equal(stick({ tailAppended: true, currentMax: 4977, distance: 56 }), true);
// 尾部来了新东西,但人在上面读历史 —— 仍然不跟。
assert.equal(stick({ stuck: false, tailAppended: true, distance: 79 }), false);
// 往顶上补历史不算尾部来新东西,底边也没往下跑时不跟。
assert.equal(stick({ tailAppended: false, distance: 79 }), false);

/* 尾部指纹:它是「末尾多了要看的东西」的唯一来源,由拿着会话数据的人算。
   界面反馈(复制按钮变「已复制」、账目数字刷新、图标换一张)不碰这三样,
   所以读到一半的人不会被拽到底 —— 这正是审查 F2 复现的那一类。 */
const msg = (id, body, status = "ok") => ({ id, body, status });
const chatKey = (list) => tailKeyOf(list, (m) => `${m.id}:${m.body.length}:${m.status}`);
const base = [msg("m1", "一"), msg("m2", "二")];
// 同一批消息、同样的正文 —— 不管界面怎么闪,指纹必须稳。
assert.equal(chatKey(base), chatKey([msg("m1", "一"), msg("m2", "二")]));
// 来了新回复。
assert.notEqual(chatKey(base), chatKey([...base, msg("m3", "三")]));
// 最后一条在逐字长(流式输出)。
assert.notEqual(chatKey(base), chatKey([msg("m1", "一"), msg("m2", "二三")]));
// 最后一条收口(status 从 running 翻终态)。
assert.notEqual(chatKey(base), chatKey([msg("m1", "一"), msg("m2", "二", "running")]));
// 最近 500 条轮换:追加一条 + 淘汰最老一条,条数和总长都没变,指纹仍然必须变(审查 F1)。
const rolled = [msg("m2", "二"), msg("m3", "三")];
assert.equal(base.length, rolled.length);
assert.notEqual(chatKey(base), chatKey(rolled));
// 空列表不炸,且与「只有一条」区分得开。
assert.equal(chatKey([]), chatKey([]));
assert.notEqual(chatKey([]), chatKey([msg("m1", "")]));

console.log("贴底判据回归验证通过");
