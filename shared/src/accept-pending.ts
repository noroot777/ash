// 「合并后不提交」那一档验收完之后，那份改动此刻到底在哪 —— 服务端现场核对的结论，
// 前端照它渲染常驻卡片。服务端与前端共用这一份定义，免得两边各写一套再漂移。
//
// 为什么需要「现场核对」而不是直接读库：验收那一刻改动被合进目标分支的工作区并暂存，
// 之后用户在自己的终端里干了什么 ash 一概管不着 —— 他可能自己提交了、可能
// `git reset --hard` 丢了、也可能又往暂存区里加了别的东西。库里只记得「我们合完没提交」，
// 所以卡片必须每次去看一眼现场。

/** 那份改动此刻的处境。 */
export type PendingMergeKind =
  /** 还躺在目标分支的索引里，内容跟当初合进来的那份逐字节一致 —— 可以替用户落成提交 */
  | "staged"
  /** 索引里有东西，但跟当初那份不一样（有人动过暂存区）—— 不替用户提交 */
  | "foreign"
  /** 已经落成提交（用户自己提交的，或点了「现在提交」） */
  | "committed"
  /** 那份改动已经不在了（被 reset --hard 之类丢掉），来源分支还留着 */
  | "discarded"
  /** 认不出现场：目标分支没检出在项目目录、前进到了认不出的地方、或快照不全 */
  | "unknown";

export type PendingMergeState = {
  taskId: string;
  kind: PendingMergeKind;
  /** 给用户看的那段话：现状 + 下一步。措辞由服务端出，两个前端表面不各写一遍。 */
  message: string;
  /** 项目目录（命令提示里要原样给出 `git -C <这个路径>`） */
  repoPath: string;
  targetBranch: string | null;
  sourceBranch: string | null;
  /** 来源分支还在不在（没提交时它是那份改动唯一的版本库副本） */
  sourceBranchExists: boolean;
  /** 已提交时那个提交（committed 必有；unknown 可能带着一个已不可达的旧记录） */
  commit?: string | null;
  /** 索引里待提交的文件 */
  stagedFiles?: string[];
  /** 目标工作区里另外那些没暂存/没跟踪的东西：它们不会被带进这次提交 */
  dirtyFiles?: string[];
  /** 能不能点「现在提交」 */
  canCommit: boolean;
  /** 能不能点「重新验收」（重新合一次） */
  canRemerge: boolean;
};

export type PendingMergeActionResult = {
  ok: true;
  state: PendingMergeState;
  /** 这次动作真正做了什么，照实说 */
  message: string;
  commit?: string | null;
  /** 清理重跑的结果（分支删没删、为什么留着） */
  notices?: string[];
};
