import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type ScmChange,
  type ScmChangeKind,
  type ScmDiffSource,
  type ScmErrorBody,
  type ScmOverview,
  type ScmStatus,
  type ScmWritePartial,
} from "../lib/api.ts";

// 工作区源代码管理面板的数据层。
//
// 轮询而不是 SSE：改动的来源是**任务目录里的文件系统**，服务端并不知道 agent 什么时候
// 落了一次盘，没有事件可推。5 秒一次是折中——面板要能跟上 agent 的节奏（它经常一分钟内
// 写十几个文件），但每次都要 fork 一个 git 进程，再密就是拿服务端换手感。页面不可见时
// 停掉：后台标签页里刷 git status 纯属浪费。

const POLL_MS = 5000;

/** 中间栏此刻摊开的是哪一份 diff。同一个文件在暂存/未暂存两侧的内容不同，source 是主键的一部分。 */
export type ScmDiffTarget = {
  path: string;
  source: ScmDiffSource;
  origPath: string | null;
};

export type ScmAction =
  | { kind: "stage"; paths: string[] }
  | { kind: "unstage"; paths: string[] }
  | { kind: "discard"; paths: string[]; deleteUntracked: string[] }
  | { kind: "commit"; message: string; stagePaths?: string[]; amend?: boolean }
  | { kind: "push"; remote: string | null };

/** 一次写操作的结果：要么落地了（带一句可以直接 notify 的话），要么被 running 门禁挡下。 */
export type ScmActionOutcome =
  | { ok: true; message: string }
  | { ok: false; needsForce: true; error: string };

export const KIND_LABEL: Record<ScmChangeKind, string> = {
  modified: "已修改",
  added: "已添加",
  deleted: "已删除",
  renamed: "已重命名",
  copied: "已复制",
  typechange: "类型变化",
  unmerged: "冲突",
  untracked: "未跟踪",
};

/** 列表上那个单字母角标。跟 VSCode 一致，扫一眼就知道是哪种改动。 */
export const KIND_BADGE: Record<ScmChangeKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  unmerged: "!",
  untracked: "U",
};

export const CONFLICT_LABEL: Record<string, string> = {
  both_modified: "双方都改了",
  both_added: "双方都新增",
  both_deleted: "双方都删了",
  added_by_us: "我方新增",
  added_by_them: "对方新增",
  deleted_by_us: "我方删除",
  deleted_by_them: "对方删除",
};

export const OPERATION_LABEL: Record<NonNullable<ScmStatus["operation"]>, string> = {
  merge: "合并",
  rebase: "变基",
  "cherry-pick": "拣选",
  revert: "回滚",
};

export function fileName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

export function dirName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** 改动条目在 diff 里对应哪一侧。分组决定，不是文件属性——同一个文件两边都可能有。 */
export function diffSourceOf(group: "merge" | "staged" | "unstaged" | "untracked"): ScmDiffSource {
  if (group === "staged") return "staged";
  if (group === "untracked") return "untracked";
  return "unstaged";
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** 后端在任务运行中挡下写操作时回的 409。认这个标记，而不是认 status——别的 409 不该被当成「再点一次就行」。 */
function isNeedsForce(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 409
    && typeof reason.body === "object" && reason.body !== null
    && "needsForce" in reason.body && reason.body.needsForce === true;
}

/** 批量操作跑到一半失败的 409。同上，认 `partial` 这个标记而不是认状态码。 */
function partialOf(reason: unknown): ScmErrorBody | null {
  if (!(reason instanceof ApiError) || typeof reason.body !== "object" || reason.body === null) return null;
  const body = reason.body as ScmErrorBody;
  return body.partial ? body : null;
}

/**
 * 后端跳过了一部分（目前只有嵌套 Git 仓库）时，把它那句交代接在成功提示后面。
 *
 * 组级操作（「全部暂存」「暂存全部并提交」）会把整份列表原样送上去，其中的嵌套仓一定
 * 不会被处理。只报「已暂存 5 个文件」而用户点的是 6 行，差的那一个就得他自己去数。
 */
function withNote(message: string, note?: string): string {
  return note ? `${message}（${note}）` : message;
}

async function runOne(taskId: string, action: ScmAction, force: boolean) {
  switch (action.kind) {
    case "stage": {
      const result = await api.scmStage(taskId, action.paths, force);
      return { status: result.status, message: withNote(`已暂存 ${result.affected} 个文件`, result.note) };
    }
    case "unstage": {
      const result = await api.scmUnstage(taskId, action.paths, force);
      return { status: result.status, message: withNote(`已取消暂存 ${result.affected} 个文件`, result.note) };
    }
    case "discard": {
      const result = await api.scmDiscard(taskId, action.paths, action.deleteUntracked, force);
      return { status: result.status, message: withNote(`已丢弃 ${result.affected} 个文件的改动`, result.note) };
    }
    case "commit": {
      const result = await api.scmCommit(taskId, action.message, {
        stagePaths: action.stagePaths,
        amend: action.amend,
        force,
      });
      // 提交成功但没读到提交号（后端把这一步降级成了警告），照样是**提交成功**：
      // 报「提交失败」会让用户再提交一次，报得含糊也一样。所以摆事实——提交成功了，
      // 加上那句读不到提交号的实话。
      const done = result.sha ? `已提交 ${result.sha.slice(0, 7)}：${result.subject}` : `已提交：${result.subject}`;
      return {
        status: result.status,
        message: withNote(result.warning ? `${done}（${result.warning}）` : done, result.note),
      };
    }
    case "push": {
      const result = await api.scmPush(taskId, action.remote, force);
      const count = result.pushed && result.pushed > 0 ? ` ${result.pushed} 个提交` : "";
      return {
        status: result.status,
        message: result.published
          ? `已发布分支 ${result.branch} 到 ${result.remote}`
          : `已推送${count}到 ${result.remote}/${result.branch}`,
      };
    }
  }
}

/**
 * 上一次「改到一半停下」的操作，留在面板上直到用户自己关掉——见 `run` 的注释。
 *
 * `message` 直接用后端那句话：横幅要说清楚的是**这次到底发生了什么**（暂存了 200 个第
 * 201 个失败 / 文件全暂存上了但提交没成），只有后端知道，前端按动作名硬拼准会拼错。
 */
export type ScmPartialNotice = ScmWritePartial & { message: string };

/**
 * 「下面这份列表可能不是现在的样子」——写操作要按它冻住。
 *
 * 面板上的每一次点击都是**按列表内容下的判断**：勾这一行去暂存、按那一行去丢弃、看着
 * 「暂存全部并提交（7）」按下提交。列表一旦落后于磁盘，这些判断作用的就是另一批文件：
 * 补刷失败之后 agent 又写了三个文件，此时「暂存全部并提交」会把那三个一起提交进去；
 * 而用户看到的仍是七个。所以状态一旦对不上，就必须**说出来并停掉写操作**，而不是把
 * 一份可能过期的列表当现状继续操作（第 2 轮审查复现：提交成功但补刷失败之后，面板不声
 * 不响地停在提交前的旧列表上，按钮照常可点）。
 */
const STALE_AFTER_WRITE = "这次操作已经落地，但没读到最新的工作区状态；下面这份列表可能是旧的。";
const staleAfterRefresh = (reason: string) => `读不到最新的工作区状态（${reason}）；下面这份列表可能是旧的。`;

export function useScmWorkspace(taskId: string) {
  const [overview, setOverview] = useState<ScmOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<ScmPartialNotice | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  // 写操作进行中不轮询：中途插进来的 GET 会拿到写到一半的状态，把刚点掉的条目闪回来。
  // **必须同步置位**——`setBusy` 要等下一帧才生效，这中间的定时器照样会开一次 GET。
  const busyRef = useRef(false);
  // 读请求的世代号。
  //
  // 「读」和「写」天然会交错：一次 GET 已经在飞（5 秒轮询、用户点的刷新、StrictMode 双
  // 发都算），用户接着点了暂存，写先回来、读后回来——而这次读带的是**写之前**的快照。
  // 无条件采信它，就等于把已经落地的写结果盖回去，或者把「列表可能是旧的」那道冻结拆掉；
  // 用户接着按这份磁盘上已经不成立的列表点丢弃/提交（第 1 轮审查复现两条）。
  //
  // 所以每次读发一个号，落地时对不上就整份丢掉。写操作在**开始时**和**返回后**各作废
  // 一次：前者管住写之前发出的，后者管住写期间发出的——冻结只能被这次写之后发起的那次
  // 成功刷新解除。
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current += 1; }, []);

  const refresh = useCallback(async (quiet = false) => {
    const ticket = ++generation.current;
    const current = () => ticket === generation.current;
    if (!quiet) setLoading(true);
    try {
      const next = await api.taskScm(taskId);
      if (!current()) return;
      setOverview(next);
      setError(null);
      // 读到了 = 列表就是现状，之前那声「可能是旧的」到此为止。
      setStale(null);
    } catch (reason) {
      if (!current()) return;
      setError(messageOf(reason));
      // 静默轮询失败尤其要留痕：屏幕上什么都没变，用户以为自己看的是实时状态。
      setStale(staleAfterRefresh(messageOf(reason)));
      if (!quiet) setOverview(null);
    } finally {
      // 转圈这一格不跟世代走：过期的那次照样得把它收掉，否则面板会一直停在「正在读取」。
      if (!quiet) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setOverview(null);
    setError(null);
    setStale(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible" || busyRef.current) return;
      void refresh(true);
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  /**
   * 跑一次写操作。
   *
   * 被 running 门禁挡下时**不抛错**，而是回一个 `needsForce`：那不是失败，是「这一步
   * 需要用户明知故犯」，调用点据此弹确认框再带 force 重来。其它错误照常抛。
   *
   * 但「改到一半停下」这一种在抛出去之前先落一份 `partial`：一句 toast 飘过去就没了，
   * 而已经被删掉的文件找不回来、已经进了索引的文件会被下一次提交带上，用户得能在刷完屏
   * 之后还看得见「上次那下做到哪儿、是哪几个」。横幅由他自己关掉，不随下一次轮询消失。
   */
  const run = useCallback(async (action: ScmAction, force = false): Promise<ScmActionOutcome> => {
    busyRef.current = true;
    setBusy(true);
    // 写之前发出的那些 GET 一律作废：它们带的是写之前的快照（见 `generation` 注释）。
    invalidate();
    try {
      const result = await runOne(taskId, action, force);
      // 写期间发出的也一样过期——写的结果才是最新的那份。
      invalidate();
      // 写操作自带刷新后的状态，直接就地更新：少一次往返，也不会出现「按钮已响应、
      // 列表还是旧的」那一帧。commits 不跟着变的只有提交，所以那一种额外补一次拉取。
      // 状态没跟回来（后端那次刷新读失败了，但写操作已经生效）就自己补一次——绝不能
      // 因此把成功当失败；补上之前先亮明「这份列表可能是旧的」并冻住写操作，补刷成功
      // 时它自己会撤掉。
      if (result.status) {
        setOverview((current) => (current ? { ...current, status: result.status! } : current));
        setStale(null);
      } else {
        setStale(STALE_AFTER_WRITE);
      }
      if (action.kind === "commit" || action.kind === "push" || !result.status) void refresh(true);
      setError(null);
      setPartial(null);
      return { ok: true, message: result.message };
    } catch (reason) {
      invalidate();
      if (isNeedsForce(reason)) return { ok: false, needsForce: true, error: messageOf(reason) };
      const body = partialOf(reason);
      if (body?.partial) {
        setPartial({ ...body.partial, message: body.error ?? messageOf(reason) });
        // 已经生效的那部分必须立刻反映到列表上，否则界面停在旧状态，用户会以为整次都没做。
        if (body.status) {
          setOverview((current) => (current ? { ...current, status: body.status! } : current));
          setStale(null);
        } else {
          setStale(STALE_AFTER_WRITE);
          void refresh(true);
        }
      }
      throw reason;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [invalidate, refresh, taskId]);

  const dismissPartial = useCallback(() => setPartial(null), []);

  return { overview, error, loading, busy, partial, stale, refresh, run, dismissPartial };
}

/**
 * 分组里这些条目要送到后端的全部路径，按显示顺序。
 *
 * **只有重命名会展开成两条**（新路径 + 原路径）：`git mv old new` 在索引里是「删 old +
 * 加 new」两条记录，status 才把它们合成一条 R 显示。只送 new 去取消暂存，索引里那条 old
 * 的删除会原地留下——界面报「已取消暂存」，用户下一次提交却只提交了一个删除。
 *
 * **复制（C）绝不能跟着展开。** 仓库配了 `status.renames=copies` 时，复制条目的 origPath
 * 是**另一个仍然存在的文件**，不是同一个改动的另一半；连它一起送过去，用户点的是
 * `copy.txt` 的减号，被取消暂存的却还有他精心挑好的 `source.txt`——静默地把别的东西移出
 * 了下一次提交。所以判据是 `kind === "renamed"`，不是「有没有 origPath」。
 *
 * 「用户丢掉的正是他看见的那些」这条边界不受影响：重命名的 origPath 本来就是那一行上
 * 写着的 `← old.txt`。
 */
export function pathsOf(changes: readonly ScmChange[]): string[] {
  return changes.flatMap((change) => (
    change.kind === "renamed" && change.origPath ? [change.path, change.origPath] : [change.path]
  ));
}
