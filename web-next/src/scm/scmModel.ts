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

export type ScmActionKind = "stage" | "unstage" | "discard" | "commit";

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
  | { kind: "commit"; message: string; stagePaths?: string[]; amend?: boolean };

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

async function runOne(taskId: string, action: ScmAction, force: boolean) {
  switch (action.kind) {
    case "stage": {
      const result = await api.scmStage(taskId, action.paths, force);
      return { status: result.status, message: `已暂存 ${result.affected} 个文件` };
    }
    case "unstage": {
      const result = await api.scmUnstage(taskId, action.paths, force);
      return { status: result.status, message: `已取消暂存 ${result.affected} 个文件` };
    }
    case "discard": {
      const result = await api.scmDiscard(taskId, action.paths, action.deleteUntracked, force);
      return { status: result.status, message: `已丢弃 ${result.affected} 个文件的改动` };
    }
    case "commit": {
      const result = await api.scmCommit(taskId, action.message, {
        stagePaths: action.stagePaths,
        amend: action.amend,
        force,
      });
      return { status: result.status, message: `已提交 ${result.sha.slice(0, 7)}：${result.subject}` };
    }
  }
}

/** 部分生效的那次操作，留在面板上直到用户自己关掉——见 `run` 的注释。 */
export type ScmPartialNotice = ScmWritePartial & { action: ScmActionKind };

export function useScmWorkspace(taskId: string) {
  const [overview, setOverview] = useState<ScmOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<ScmPartialNotice | null>(null);
  // 写操作进行中不轮询：中途插进来的 GET 会拿到写到一半的状态，把刚点掉的条目闪回来。
  const busyRef = useRef(false);
  busyRef.current = busy;

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setOverview(await api.taskScm(taskId));
      setError(null);
    } catch (reason) {
      setError(messageOf(reason));
      if (!quiet) setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setOverview(null);
    setError(null);
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
   * 但「部分生效」这一种在抛出去之前先落一份 `partial`：一句 toast 飘过去就没了，而
   * 已经被删掉的文件是找不回来的，用户得能在刷完屏之后还看得见「上次那下只做了一半、
   * 是哪几个」。横幅由他自己关掉，不随下一次轮询消失。
   */
  const run = useCallback(async (action: ScmAction, force = false): Promise<ScmActionOutcome> => {
    setBusy(true);
    try {
      const result = await runOne(taskId, action, force);
      // 写操作自带刷新后的状态，直接就地更新：少一次往返，也不会出现「按钮已响应、
      // 列表还是旧的」那一帧。commits 不跟着变的只有提交，所以那一种额外补一次拉取。
      setOverview((current) => (current ? { ...current, status: result.status } : current));
      if (action.kind === "commit") void refresh(true);
      setError(null);
      setPartial(null);
      return { ok: true, message: result.message };
    } catch (reason) {
      if (isNeedsForce(reason)) return { ok: false, needsForce: true, error: messageOf(reason) };
      const body = partialOf(reason);
      if (body?.partial) {
        setPartial({ ...body.partial, action: action.kind });
        // 已经生效的那部分必须立刻反映到列表上，否则界面停在旧状态，用户会以为整次都没做。
        if (body.status) setOverview((current) => (current ? { ...current, status: body.status! } : current));
        else void refresh(true);
      }
      throw reason;
    } finally {
      setBusy(false);
    }
  }, [refresh, taskId]);

  const dismissPartial = useCallback(() => setPartial(null), []);

  return { overview, error, loading, busy, partial, refresh, run, dismissPartial };
}

/**
 * 分组里这些条目要送到后端的全部路径，按显示顺序。
 *
 * **重命名会展开成两条**（新路径 + 原路径）：`git mv old new` 在索引里是「删 old + 加
 * new」两条记录，status 才把它们合成一条 R 显示。只送 new 去取消暂存，索引里那条 old
 * 的删除会原地留下——界面报「已取消暂存」，用户下一次提交却只提交了一个删除。
 *
 * 「用户丢掉的正是他看见的那些」这条边界不受影响：origPath 本来就是那一行上写着的
 * `← old.txt`，是同一个改动的另一半，不是额外的文件。
 */
export function pathsOf(changes: readonly ScmChange[]): string[] {
  return changes.flatMap((change) => (change.origPath ? [change.path, change.origPath] : [change.path]));
}
