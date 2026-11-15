// 「名下全部停下」在前端的读法（src/lib/dispatchHold.ts）：被谁按住、名下还有没有在动的。
// 判据跟服务端 server/src/task-hold.ts 同一个，服务端那一半的回归在 server 的 test:dispatch-hold。
// 跑：npm -w web run test:dispatch-hold
import assert from "node:assert/strict";
import { dispatchHolderOf, dispatchHoldKey, dispatchHoldPhrase, dispatchedLive } from "../src/lib/dispatchHold.ts";
import { scheduledWaitText } from "../../shared/src/scheduled-message-wait.ts";
import { leavesOnArchive } from "../src/lib/archivedSelection.ts";

const task = (id, extra = {}) => ({
  id, title: `任务 ${id}`, parentId: null, dispatchedBy: null, dispatchHoldAt: null, status: "done", archived: false,
  createdAt: "2026-11-15T00:00:00.000Z", ...extra,
});
const byId = (rows) => new Map(rows.map((row) => [row.id, row]));

// —— 按住它的是往上第一条带停着标记的；自己带着不算（它自己的那颗键在它自己的格头上）。
{
  const rows = [
    task("H", { dispatchHoldAt: "2026-11-15T01:00:00.000Z" }),
    task("A", { dispatchedBy: "H", status: "paused" }),
    task("D", { dispatchedBy: "A", status: "backlog" }),
    task("O"),
  ];
  const map = byId(rows);
  assert.equal(dispatchHolderOf("A", map)?.id, "H");
  assert.equal(dispatchHolderOf("D", map)?.id, "H", "名下再派出的那一层也认得出是 H 按的");
  assert.equal(dispatchHolderOf("H", map), null, "派活的那条自己不被自己按住");
  assert.equal(dispatchHolderOf("O", map), null, "不在名下的不受影响");
  // 中间那条也按了：离得近的那条先说（放开外面那条之后它照样停着）。
  map.set("A", { ...map.get("A"), dispatchHoldAt: "2026-11-15T02:00:00.000Z" });
  assert.equal(dispatchHolderOf("D", map)?.id, "A");
}

// —— 派活的那条不在列表里（被删了）：不再被按住；脏数据成环不死循环。
{
  assert.equal(dispatchHolderOf("A", byId([task("A", { dispatchedBy: "gone" })])), null);
  const loop = byId([task("X", { dispatchedBy: "Y" }), task("Y", { dispatchedBy: "X" })]);
  assert.equal(dispatchHolderOf("X", loop), null);
}

// —— 「全部停下」出不出：名下整棵往下有在跑或排着的才出；团队执行者不算名下。
{
  const rows = [
    task("H"),
    task("A", { dispatchedBy: "H", status: "done" }),
    task("D", { dispatchedBy: "A", status: "paused" }),
    task("W", { dispatchedBy: "H", parentId: "team", status: "running" }),
  ];
  assert.equal(dispatchedLive(rows, "H"), false, "名下都停着或做完了：不出");
  rows[2] = { ...rows[2], status: "running" };
  assert.equal(dispatchedLive(rows, "H"), true, "孙辈在跑也算");
  rows[2] = { ...rows[2], status: "queued" };
  assert.equal(dispatchedLive(rows, "H"), true, "排着的也算");
  assert.equal(dispatchedLive(rows, "D"), false);
}

// —— 格头那颗键：没停着看名下动不动；停完了是接着跑；按了停、没停完（服务端在补停）只给再停一次。
assert.equal(dispatchHoldKey({ dispatchHoldAt: null, dispatchHoldPendingAt: null }, false), null, "没停着、名下也没在动：不出");
assert.equal(dispatchHoldKey({ dispatchHoldAt: null, dispatchHoldPendingAt: null }, true), "hold");
assert.equal(dispatchHoldKey({ dispatchHoldAt: "t", dispatchHoldPendingAt: null }, false), "release", "停完了：接着跑，名下动不动都在");
assert.equal(dispatchHoldKey({ dispatchHoldAt: "t", dispatchHoldPendingAt: "t" }, true), "retry", "没停完：不给接着跑");
assert.equal(dispatchHoldKey({ dispatchHoldAt: "t" }, false), "release", "老服务端不带这一列：按停完了算");

// —— 说法：页面那一行、托盘那一句都说得出是谁按的。
assert.equal(dispatchHoldPhrase({ title: "派活的那条" }), "「派活的那条」名下已全部停下");
assert.equal(dispatchHoldPhrase({ title: "" }), "「未命名任务」名下已全部停下");
assert.equal(scheduledWaitText({ kind: "dispatchHeld", by: { id: "H", title: "派活的那条" } }), "「派活的那条」名下已全部停下，接着跑后发送");
assert.equal(scheduledWaitText({ kind: "groupPaused" }), "分组已暂停，恢复后发送", "分组暂停的那一句不变");

// —— 派活那条归档了：从按停者的链接 / 地址栏打开它照常开着（才按得到「接着跑」）；开着的时候被归档才退出。
{
  const archivedHolder = { id: "H", archived: true };
  let verdict = leavesOnArchive(null, archivedHolder, false);
  assert.equal(verdict.leave, false, "打开时就已归档的照常打开");
  verdict = leavesOnArchive(verdict.seen, archivedHolder, false);
  assert.equal(verdict.leave, false, "列表刷新之后还开着");
  verdict = leavesOnArchive(null, { id: "X", archived: false }, false);
  assert.equal(verdict.leave, false);
  assert.equal(leavesOnArchive(verdict.seen, { id: "X", archived: true }, false).leave, true, "开着的时候被归档了才退出");
  assert.equal(leavesOnArchive(verdict.seen, { id: "X", archived: true }, true).leave, false, "在归档设置里不退");
  assert.equal(leavesOnArchive(verdict.seen, archivedHolder, false).leave, false, "换了一条重新认");
}

console.log("dispatch hold (web): ok");
