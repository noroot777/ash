// 层级(§3)里**项目**这一层,加上它在磁盘上的两样东西(worktree 目录 / 分支)与分组容器。
//
// 从 index.ts 搬出来的:那份文件是全仓类型的总表,项目这一段已经能自成一块,而根约定
// 钉着「单个代码文件不超过 700 行」。消费方的 import 路径不变 —— index.ts 仍然把这些
// 类型原样再导出(它只能转发**类型**,见 server/CLAUDE.md)。
import type { ProjectRole } from "./multiuser.ts";

export interface Project {
  id: string;
  name: string;
  repoPath: string; // git repo this project's tasks operate on
  // 本项目新建任务默认走哪条起手式；null = 跟随全局默认（见 AppSettings）
  workflowId: string | null;
  createdAt: string;
}

// repoPath is load-bearing (it's the cwd of every run). Health is computed
// server-side and is NEVER persisted — see ProjectView. 🔴 !exists / 🟡 exists
// but not a git repo / 🟢 git repo (with branch + dirty in the full check).
export interface ProjectHealth {
  exists: boolean;
  // 路径存在，但它是个文件（或别的非目录条目）。`exists` 对它只能是 false，于是它跟
  // 「什么都没有」长得一模一样 —— 而两者的下一步完全相反：不存在可以建出来，被文件占着
  // 只能换一条路径。界面照着 `exists` 说「会建出来」，用户按下去却吃一个 409，就是漏了
  // 这个字段。
  occupied?: boolean;
  isRepo: boolean;
  isWorktree?: boolean; // repoPath is itself a linked git worktree (.git is a file, not a dir)
  branch?: string | null; // only in the full check (settings panel / path validation)
  dirty?: boolean; // working tree has uncommitted changes (full check only)
  // 目录里一个条目都没有（full check only；路径不存在时不带这个字段）。给「从 Git 检出
  // 新项目」用：能克隆进去的只有「不存在」和「空目录」两种，界面得在按下按钮之前就分清
  // 它现在是哪一种，而不是等服务端拒绝。
  empty?: boolean;
}

// Wire shape returned by the project endpoints: the persisted row + computed
// health. The web client uses this everywhere; it never inserts a bare Project.
//
// `myRole` 是**拿到这份数据的那个人**在这个项目里的角色,不是项目自己的属性。前端
// 据它决定「项目设置 / 成员管理这些控件给不给看」——后端本来就会 403,但把必然失败的
// 管理入口摆在成员面前,既跟权限表对不上,也让人以为是自己点坏了(第 6 轮审查 P3)。
// 自用模式与实例管理员一律是 "admin",所以这个字段不会让老行为变样。
export interface ProjectView extends Project {
  health: ProjectHealth;
  myRole: ProjectRole;
}

// ── 任务留在磁盘上的工作区(worktree 目录 + ash/<id8> 分支) ──────────────
// 删除任务前先问一次服务端「这两样还在不在」,在的话删除对话框才提示要不要连它们
// 一起删。两个字段各自独立:目录被手删过、分支还留着是常见状态。
export interface TaskWorkspaceLeftover {
  path: string | null; // worktree 目录,不存在为 null
  branch: string | null; // 任务分支 ash/<id8>,本地不存在为 null
}

// 一次清理的逐项结果。git 拒绝(worktree 有未提交改动 / 分支未合并)不是异常,
// 是要如实回给用户、由他决定要不要再来一次 --force / -D 的信息。
export interface TaskWorkspaceDiscardResult {
  path: string | null; // 本次尝试删除的 worktree 目录(没尝试则 null)
  branch: string | null; // 本次尝试删除的分支(没尝试则 null)
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  worktreeError: string | null; // git 原样 stderr
  branchError: string | null;
}

export type GroupMode = "parallel" | "serial";

// Group = transient homogeneous batch container (§3). Not persistent-by-design,
// not schedulable. Controls parallel/serial scheduling.
export interface Group {
  id: string;
  projectId: string;
  name: string;
  mode: GroupMode;
  paused: boolean; // 暂停 = 立刻冻结整组：调度器不再启动"还没开始"的任务，正在运行的也会被停掉（结算为 canceled，可继续）；再次「运行/继续」时恢复，被停的任务从中断处接着跑
  // 内部组（§Team）：非空 = 这个组是某个团队任务(mode:"team")派活时自动建的，
  // 它的成员都是那个任务的执行者。分组管理界面不列它 —— 用户在团队视图里看。
  ownerTaskId?: string | null;
  createdAt: string;
}
