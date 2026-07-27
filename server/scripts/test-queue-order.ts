// 队列顺序语义的回归测试(纯函数,不碰 DB):
//   selectNextInQueue —— 谁该被拉起来 / 什么时候一个都不拉
//   isOvertaken / tailOrder —— 重新排队该不该去队尾、去了以后顺序对不对
// 跑:npm -w server run test:queue
import assert from "node:assert/strict";
import { selectNextInQueue, type QueueMember } from "../src/scheduler.js";
import { isOvertaken, tailOrder } from "../src/queues.js";

const m = (id: string, status: string, extra: Partial<QueueMember> = {}): QueueMember => ({
  id,
  status,
  archived: false,
  mode: "single",
  question: null,
  ...extra,
});

// ── selectNextInQueue ────────────────────────────────────────────────────────

// 本次 bug 的回归用例:05 失败后被改回 backlog,位置仍在正在跑的 06 前面。
// 顺序扫描会先命中 05 → 并跑;守卫必须让整条队列按兵不动。
assert.equal(
  selectNextInQueue([m("04", "done"), m("05", "backlog"), m("06", "running")]),
  null,
  "队列里已经有人在跑时,一个都不该启动",
);
assert.equal(
  selectNextInQueue([m("05", "backlog"), m("06", "queued")]),
  null,
  "queued(已拉起还没 spawn)同样算在跑",
);

// 透明跳过:done / canceled / failed 都让位
assert.equal(
  selectNextInQueue([m("01", "done"), m("02", "canceled"), m("03", "failed"), m("04", "backlog")])?.id,
  "04",
);

// 链停:审查门 / 提问暂停
assert.equal(selectNextInQueue([m("01", "awaiting_review"), m("02", "backlog")]), null);
assert.equal(
  selectNextInQueue([m("01", "paused", { question: "选 A 还是 B?" }), m("02", "backlog")]),
  null,
  "提问暂停在等答复,不能被空手叫醒",
);

// 检查点暂停(有 resumePrompt、无 question)该被续跑
assert.equal(selectNextInQueue([m("01", "paused"), m("02", "backlog")])?.id, "01");

// 归档成员仍占位置但不参与调度;团队任务(无终态)防御性跳过
assert.equal(selectNextInQueue([m("01", "backlog", { archived: true }), m("02", "backlog")])?.id, "02");
assert.equal(selectNextInQueue([m("01", "running", { archived: true }), m("02", "backlog")])?.id, "02");
assert.equal(selectNextInQueue([m("01", "backlog", { mode: "team" }), m("02", "backlog")])?.id, "02");

// 全终态 / 空队列 → 没有可启动的
assert.equal(selectNextInQueue([m("01", "done"), m("02", "failed")]), null);
assert.equal(selectNextInQueue([]), null);

// 续聊(follow-up):终态任务被用户追加消息,这一轮 status=running 但队列按
// followUpFrom 那个终态看待它 —— 既不冻住整条线,也不会被当可启动项拉起。
// (实测事故:11:30 给已完成的 01 发了条定时消息,后面刚跑完的 08 就再也推不动 09。)
assert.equal(
  selectNextInQueue([m("01", "running", { followUpFrom: "done" }), m("02", "backlog")])?.id,
  "02",
  "续聊回合不占队列:后面的照常启动",
);
assert.equal(
  selectNextInQueue([m("01", "running", { followUpFrom: "done" }), m("02", "running")]),
  null,
  "续聊之外真有人在跑 → 仍然按兵不动",
);
assert.equal(
  selectNextInQueue([m("01", "running", { followUpFrom: "done" })]),
  null,
  "续聊成员自己不会被当可启动项拉起",
);
assert.equal(
  selectNextInQueue([m("01", "running", { followUpFrom: "failed", question: "选 A 还是 B?" }), m("02", "backlog")])?.id,
  "02",
  "续聊里提问也不挡路(任务本体仍是终态)",
);

// ── isOvertaken ──────────────────────────────────────────────────────────────

const q = (id: string, status: string, startedAt: string | null = null) => ({ id, status, startedAt });

// 05 失败,06 已经跑起来了 → 被越过
assert.equal(
  isOvertaken([q("04", "done", "t1"), q("05", "failed", "t2"), q("06", "running", "t3")], "05"),
  true,
);
// 06 刚被拉起(queued),还没盖 startedAt → 也算越过
assert.equal(isOvertaken([q("05", "failed", "t2"), q("06", "queued")], "05"), true);
// 06 跑完了(done)也算 —— 位置早就名存实亡
assert.equal(isOvertaken([q("05", "failed", "t2"), q("06", "done", "t3")], "05"), true);

// 整组还没启动:后面全是没跑过的 backlog → 原位不动
assert.equal(isOvertaken([q("05", "failed", "t2"), q("06", "backlog"), q("07", "backlog")], "05"), false);
// 它本身就在队尾 → 无所谓越过
assert.equal(isOvertaken([q("04", "done", "t1"), q("05", "failed", "t2")], "05"), false);
// 前面跑过的不算(只看它后面)
assert.equal(isOvertaken([q("04", "done", "t1"), q("05", "failed", "t2"), q("06", "backlog")], "05"), false);
// 不在队列里 → false(调用方会先挡掉)
assert.equal(isOvertaken([q("04", "done", "t1")], "99"), false);

// ── tailOrder ────────────────────────────────────────────────────────────────

assert.deepEqual(tailOrder(["04", "05", "06", "07"], "05"), ["04", "06", "07", "05"], "其余保持相对顺序");
assert.deepEqual(tailOrder(["04", "05"], "05"), ["04", "05"], "已在队尾则不变");
assert.deepEqual(tailOrder(["04", "05"], "99"), ["04", "05"], "不在队列里则原样返回");

console.log("queue order tests passed");
