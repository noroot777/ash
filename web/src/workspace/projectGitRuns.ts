import type { ProjectGitResult, ProjectGitState } from "../lib/api.ts";
import { gitOpLabel } from "./projectGitModel.ts";

// 项目主仓 git 操作的**运行账本**，故意住在 React 树外面。
//
// 浮层是「点别处就收起」的下拉（`useDismissable`），而 fetch / pull / push / checkout 都是
// 秒级往上的活。老实现把操作状态放在浮层自己的 hook 里，这两件事一撞：手滑点到别处 →
// 浮层卸载 → busy、成功消息、错误全跟着组件没了。请求其实还在飞、服务端也照旧在跑，但
// 用户看到的是「整个过程被打断」，重新点开浮层更是一点痕迹都没有。
//
// 所以账本按项目存在这里，谁都能订阅：浮层开着就显示在浮层里，关着的时候由侧栏那颗胶囊
// 转圈、结果补一句 toast。组件的来去与操作的生死彻底解耦。
//
// 存下的那份状态顺带当缓存用：重开浮层先摆出上一次的分支清单，同时在后台拉一趟新的，省掉
// 那一下「空白 → 有内容」的闪。按项目分片，A 的清单不会在 B 底下露脸。整本账随页面重载
// 清空——那时候在飞的请求本来也断了。

export type ProjectGitRun = {
  state: ProjectGitState | null;
  /** 正在跑的操作名（`checkout` / `fetch` / `pull` / `push`），空闲时为 null。 */
  busy: string | null;
  /** 最近一次操作的结果：成功给 message，失败给 error。两者互斥。 */
  message: string | null;
  error: string | null;
  /**
   * 最近一次**读**的失败。跟 `error` 分开存：那个说的是「我让它干的那件事成没成」，这个
   * 说的是「面板上这份状态还可不可信」，清除时机完全不同——发起一次新的写操作就该把旧的
   * 读取错误作废，但写操作自己的失败得留着。
   *
   * 也**必须跟账本里其它状态住在一起**。它原先是 hook 的本地 state，于是「树外的账本」和
   * 「组件里的读取错误」成了两套各说各话的状态：checkout 成功了，账本记着成功消息，本地
   * 那条读取错误却没人清，合并出来 `error` 仍非空——面板照着「有错就不显示成功消息」的
   * 规矩，把一次做成了的操作显示成一直在报错。
   */
  loadError: string | null;
  /** 最近一次落定的是哪一步。浮层已经收起来时，靠它把 toast 说成「拉取失败：…」。 */
  settledKind: string | null;
  /** 落定次数。订阅者拿它判断「这一次的结果我提示过没有」，而不是去比对文案。 */
  settled: number;
};

const IDLE: ProjectGitRun = {
  state: null,
  busy: null,
  message: null,
  error: null,
  loadError: null,
  settledKind: null,
  settled: 0,
};

const runs = new Map<string, ProjectGitRun>();
const listeners = new Map<string, Set<() => void>>();

// 读取世代号。每次写操作**开始和落定各推一次**，于是「跨过一次写的那趟读」必然拿着一个
// 过期的号回来，一眼认得出来。见 `putProjectGitState`。
const epochs = new Map<string, number>();

export function projectGitEpoch(projectId: string): number {
  return epochs.get(projectId) ?? 0;
}

function bumpEpoch(projectId: string) {
  epochs.set(projectId, projectGitEpoch(projectId) + 1);
}

/** 引用稳定：只有 `patch` 换新对象，`useSyncExternalStore` 才不会每帧判定成变了。 */
export function readProjectGitRun(projectId: string | null): ProjectGitRun {
  return (projectId ? runs.get(projectId) : null) ?? IDLE;
}

export function subscribeProjectGitRun(projectId: string | null, listener: () => void): () => void {
  if (!projectId) return () => {};
  let group = listeners.get(projectId);
  if (!group) {
    group = new Set();
    listeners.set(projectId, group);
  }
  group.add(listener);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(projectId);
  };
}

// ── 落定播报 ──────────────────────────────────────────────────────────────
// 上面那份订阅是按项目分片的，只有当前项目的胶囊在听。可「点了别处」最常见的那个别处
// 就是**切到另一个项目**——分片订阅在那一刻整个换了一本，旧项目的 pull 跑完了没人认领。
// 所以落定再单独广播一条，由 WorkspaceShell 那一层接（它不随项目切换卸载）。

export type ProjectGitSettlement = {
  projectId: string;
  kind: string;
  message: string | null;
  error: string | null;
};

const settleListeners = new Set<(settlement: ProjectGitSettlement) => void>();

export function onProjectGitSettled(listener: (settlement: ProjectGitSettlement) => void): () => void {
  settleListeners.add(listener);
  return () => { settleListeners.delete(listener); };
}

// 此刻开着的那个浮层属于谁（全局至多一个）。结果落在它自己身上就不用再弹 toast——浮层里
// 那一格已经写着了，两处同时说是重复。
let openPanel: string | null = null;

export function markProjectGitPanelOpen(projectId: string | null): void {
  openPanel = projectId;
}

export function isProjectGitPanelOpen(projectId: string): boolean {
  return openPanel === projectId;
}

function patch(projectId: string, next: Partial<ProjectGitRun>) {
  runs.set(projectId, { ...readProjectGitRun(projectId), ...next });
  for (const listener of [...(listeners.get(projectId) ?? [])]) listener();
}

/** 落定：先把账本写好（订阅者据此重渲染），再广播给上层去刷新和播报。 */
function settle(projectId: string, kind: string, next: Partial<ProjectGitRun>) {
  bumpEpoch(projectId);
  patch(projectId, { ...next, busy: null, settledKind: kind, settled: readProjectGitRun(projectId).settled + 1 });
  const { message, error } = readProjectGitRun(projectId);
  for (const listener of [...settleListeners]) listener({ projectId, kind, message, error });
}

/**
 * 面板拉到一份新状态。`epoch` 是**发这趟读之前**取的世代号（`projectGitEpoch`）。
 *
 * 两道闸，缺一不可：
 * ① 在途操作期间一律不写——那趟 GET 读到的是 git 干到一半的样子；
 * ② 世代号对不上就丢弃。只看 ①（写入那一刻 busy 空不空）会漏掉最要命的一路：读发出时
 *    还没人写、读在路上时用户切了分支、切完了读才回来——`busy` 早清空了，于是这份**写
 *    之前**的快照被当成最新的写进去，面板从 `feature` 退回 `main`。退回去的不只是显示：
 *    按钮门禁、分支行上的 current、pull/push 的 upstream 和 ahead/behind 全跟着回到旧
 *    仓库状态，用户会照着一份磁盘上已经不成立的判断接着点。
 *
 * scm 面板栽过同一道题（判据见 `test-scm-race.mjs`），这里是同一条规矩：写之前发出的读，
 * 回来晚了也说了不算。
 */
export function putProjectGitState(projectId: string, state: ProjectGitState, epoch: number): void {
  if (readProjectGitRun(projectId).busy) return;
  if (epoch !== projectGitEpoch(projectId)) return;
  // 读回来了就说明状态可信，上一条读取错误跟着作废。
  patch(projectId, { state, loadError: null });
}

/** 这趟读失败了。同样两道闸——过期的读连报错的资格都没有，理由见 `putProjectGitState`。 */
export function putProjectGitLoadError(projectId: string, message: string, epoch: number): void {
  if (readProjectGitRun(projectId).busy) return;
  if (epoch !== projectGitEpoch(projectId)) return;
  patch(projectId, { loadError: message });
}

/**
 * 跑一次写操作。返回「成不成」，供调用点决定要不要接着做别的。
 *
 * 同一个项目**一次只跑一个**：主仓是所有任务共用的那一份，服务端也按仓库排队
 * （`withRepoLock`）。前端再放一个进去，等来的只是排在后面那几秒里一份自相矛盾的界面。
 */
export async function runProjectGit(
  projectId: string,
  kind: string,
  action: () => Promise<ProjectGitResult>,
): Promise<boolean> {
  const running = readProjectGitRun(projectId).busy;
  if (running) {
    patch(projectId, { message: null, error: `正在${gitOpLabel(running)}，等它结束再试` });
    return false;
  }
  // 开始就推一次世代号：此刻还在路上的那些读，全都变成「写之前发出的」，回来一律作废。
  bumpEpoch(projectId);
  // 连上一条读取错误一起清掉：用户已经发起了新动作，旧的「状态读不到」不再是他此刻关心的
  // 事；留着它会在这次操作成功之后接着压住成功消息（合并出来的 `error` 一非空，面板就照
  // 「有错不显示成功」的规矩把做成了的事显示成还在报错）。
  patch(projectId, { busy: kind, message: null, error: null, loadError: null });
  try {
    const result = await action();
    settle(projectId, kind, { state: result.state, message: result.message, error: null });
    return true;
  } catch (reason) {
    settle(projectId, kind, { message: null, error: reason instanceof Error ? reason.message : "操作失败" });
    return false;
  }
}
