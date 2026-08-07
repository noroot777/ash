// 「我是不是那个预览实例」的单点（`HARNESS_PREVIEW=1`，只有 scripts/dev.mjs 起预览时才带）。
//
// 预览跑的是**主库的快照**（见 preview-seed.ts）：库是副本，可以随便点；但库里那一千条
// 任务行带着的 `worktree_path` / 分支名指向的是**真仓库**，那些不是副本。所以这里要区分
// 两类写操作：
//
//   · 只改副本库、或者只动预览自己新建的东西（建任务、跑 agent、开自己的 worktree）
//     —— 随便做，这正是预览存在的意义。
//   · 动**别人仓库**的（合并任务分支、删 worktree、删分支）—— 一律拒绝。点一下是不可逆
//     的，而用户以为自己在沙盒里点着玩，这两件事之间没有任何提示能补救。
//
// 顺带的第二件事：预览实例**不跑调度器**。schedules / scheduled_messages 两张表压根没
// 进快照，加上这条就是双保险——预览绝不会替你到点派活、到点发消息。
export const IS_PREVIEW_INSTANCE = process.env.HARNESS_PREVIEW === "1";

/** 预览横幅里也写着同一句话，这里是给报错用的短版。 */
export function previewRefusal(what: string): string {
  return `预览实例不做「${what}」：这台后端连的是主库的快照，任务行指向的却是真仓库，`
    + `动它等于在你真正的分支上操作。要做这件事请回主界面（localhost:4317）。`;
}

/** 拿不到结构化返回值的调用点用它（抛出来的话会原样冒到 UI 上）。 */
export function assertNotPreviewInstance(what: string): void {
  if (IS_PREVIEW_INSTANCE) throw new Error(previewRefusal(what));
}
