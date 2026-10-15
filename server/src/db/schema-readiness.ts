// **当代 schema 真的发布出去了吗** —— 一次运行期核验的结果，不是编译期声明。
//
// 为什么非有不可（新一轮第 2 轮审查 F1 实测）：
//
// 「迁移函数返回了」**不等于**「库已经支持当代键」。那一步失败只打一句 warn（一条迁移不该
// 让整台 ash 起不来，见 migrations.ts 文件头），于是启动照常继续 —— 而上层此刻正按当代
// 语义对外做承诺，最要命的那句是「这个前缀读完了」（`monitor_scan_cursors.semantics`）。
// 旧三列键的库上，同号不同来源的两条调用只存得下一条，另一条入参的唯一出处就此不存在，
// 位置却照常被确认；下一次启动终于迁成功也不会重放，因为那个前缀已经带着当代戳。
//
// 编译期声明（drizzle 的 schema）**永远**是当代的，所以它什么也证明不了。唯一算数的证据是
// 运行期读一次真实形状（`PRAGMA table_info`）：键是不是当代四列、归属那一列在不在、上一次
// 中断留下的搬运表清没清（判据与核验点都在 `migrations.ts` 的 `repairPendingCallKey`）。
//
// 默认 `false` —— **没核验过就当没有**。代价是读取位置不往前（下一轮重读同一段；这一轮读到
// 的卡照常显示，并留下一笔恢复责任），而反面是把少了一张卡的前缀永久确认成「读完了」。
// 两边不对称：重读只是多花一次工，错误确认是永久的。

/** 未决调用表的持久身份键核验过了没有（`(task_id, session_key, source_run, tool_use_id)`）。 */
let pendingCallKeyVerified = false;

/** 核验没通过的原因（给日志用；通过时是空串）。 */
let pendingCallKeyWhyNot = "还没核验过（ensureSchema 没跑到这一步）";

/**
 * 核验结论落在这儿。**只有 `migrations.ts` 读完真实形状之后才调它**；别拿「语句执行成功」
 * 当成核验通过 —— 这正是上一版的坏法。
 */
export function markPendingCallKey(live: boolean, whyNot = ""): void {
  pendingCallKeyVerified = live;
  pendingCallKeyWhyNot = live ? "" : (whyNot || "核验没通过");
}

/** 可以按当代持久身份键对外确认事实了吗。 */
export const pendingCallKeyLive = (): boolean => pendingCallKeyVerified;

/** 不能确认的原因（一句话，进日志）。 */
export const pendingCallKeyBlocker = (): string => pendingCallKeyWhyNot;
