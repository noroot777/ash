import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type FileSearchHit } from "./api.ts";
import { applyFileMention, fileMentionToken } from "./fileMention.ts";
import {
  browseRows, firstSelectable, searchRows, stepIndex, treeKeyAction, type MentionTreeRow,
} from "./fileMentionTree.ts";

// 输入框里 `@` 引用工作区文件的那半套逻辑：候选怎么取、菜单键盘怎么走。
// token 怎么认、选中后正文怎么改在 fileMention.ts，列表长什么形状在 fileMentionTree.ts
// （都是纯函数，好单测）。
//
// 五个表面共用同一份（新建任务、单飞对话框、团队对话框、派生配置卡、duet 交接），因为
// 「@ 出来的路径长什么样」必须处处一致 —— 它最终是原样发给 CLI 的一段文本，某个表面自己
// 加个前缀或少个引号，agent 那边就找不着文件，而用户看不出两个输入框有什么不同。
//
// 选中之后 `@相对路径` **原样留在正文里**，不摘走、不转成附件：claude / codex 都认得
// prompt 里的 `@path`，这一句本来就是要让它去读那个文件。
//
// 取数分两态，判据是 token 像不像在说「某个目录」：
//   `@` / `@web/src/` → 列那一层，目录能就地展开成树；
//   `@useFile`       → 全局搜，结果按目录归堆。

export type FileMentionScope =
  | { kind: "task"; taskId: string }
  | { kind: "project"; projectId: string };

/** useFileMention 的返回形状。菜单组件按它取数，不必反着推 hook 的类型。 */
export type FileMentionState = ReturnType<typeof useFileMention>;

/** 边打边搜的防抖。比按键间隔略长，又短到打完一顿就出结果。 */
const DEBOUNCE_MS = 120;

/** token 在说哪个目录：空的（刚敲下 `@`）是仓库根，以 `/` 收尾的是那个目录；否则 null。 */
function browseDirOf(token: string | null): string | null {
  if (token === null) return null;
  if (token === "") return "";
  return token.endsWith("/") ? token.replace(/\/+$/, "") : null;
}

export function useFileMention({
  value,
  setValue,
  scope,
  disabled,
  onPicked,
}: {
  value: string;
  setValue: (next: string) => void;
  /** null = 这个表面暂时没有可搜的工作区（项目还没选、任务还没跑过）。 */
  scope: FileMentionScope | null;
  disabled?: boolean;
  /** 选中一条之后的收尾（通常是把焦点还给输入框）。 */
  onPicked?: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // 候选**连着它是哪次查询的结果一起存**。只存 hits 的话，token 变了而新结果还在路上
  // 的那一两百毫秒里，菜单显示的是上一个 token 的候选，回车就把那条插进正文了
  // （敲 `@src/lib/` 看到候选、改成 `@README` 立刻回车 → 插进去的是 apiClient.ts）。
  // 绑上 key 之后「还没到货」和「到的是别人的货」是同一种状态：一律不给选。
  const [result, setResult] = useState<
    { key: string; hits: FileSearchHit[]; more: boolean; failed: boolean }
  >({ key: "", hits: [], more: false, failed: false });
  // 树那一半：每个拉过的目录的直接子项，键是目录路径（根是 `""`）。这份不存 key —— 一层
  // 的内容只跟它自己的路径有关，串不了台。
  const [levels, setLevels] = useState<Map<string, FileSearchHit[]>>(new Map());
  const [levelFailed, setLevelFailed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 搜过的查询记着：删掉一个字母退回上一个查询时不必再跑一趟网络。
  const cache = useRef(new Map<string, { hits: FileSearchHit[]; more: boolean }>());
  const inflight = useRef(new Set<string>());
  const scopeKey = scope ? `${scope.kind}:${scope.kind === "task" ? scope.taskId : scope.projectId}` : "";
  const token = disabled || dismissed || !scope ? null : fileMentionToken(value);
  const browseDir = browseDirOf(token);
  // 一次查询的身份：换了工作区，同样的 token 也是另一次查询。
  const key = token === null || browseDir !== null ? null : `${scopeKey}|${token}`;

  // 换了工作区，手上这些全是别人家的东西。
  useEffect(() => {
    cache.current.clear();
    inflight.current.clear();
    setLevels(new Map());
    setLevelFailed(new Set());
    setExpanded(new Set());
  }, [scopeKey]);

  // ── 搜索态：防抖 + 中止，结果连着 key 一起落地 ──────────────────────────────
  useEffect(() => {
    if (key === null || token === null || !scope) return;
    const cached = cache.current.get(key);
    if (cached) {
      setResult({ key, ...cached, failed: false });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const request = scope.kind === "task"
        ? api.taskFileSearch(scope.taskId, token, controller.signal)
        : api.projectFileSearch(scope.projectId, token, controller.signal);
      request.then(
        (response) => {
          if (controller.signal.aborted) return;
          const settledHits = { hits: response.hits, more: response.more === true };
          cache.current.set(key, settledHits);
          setResult({ key, ...settledHits, failed: false });
        },
        () => {
          // 中止不是失败：正在打字，这一趟本来就该作废。
          if (controller.signal.aborted) return;
          setResult({ key, hits: [], more: false, failed: true });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  // ── 浏览态：缺哪一层拉哪一层（当前这一层，加上展开着的那些） ────────────────
  useEffect(() => {
    if (browseDir === null || !scope) return;
    const under = browseDir ? `${browseDir}/` : "";
    const wanted = [browseDir, ...[...expanded].filter((dir) => dir.startsWith(under))];
    for (const dir of wanted) {
      const mark = `${scopeKey}|dir|${dir}`;
      if (levels.has(dir) || levelFailed.has(dir) || inflight.current.has(mark)) continue;
      inflight.current.add(mark);
      const at = scopeKey;
      const request = scope.kind === "task"
        ? api.taskFileDir(scope.taskId, dir)
        : api.projectFileDir(scope.projectId, dir);
      request.then(
        (response) => {
          inflight.current.delete(mark);
          if (at !== scopeKey) return; // 中途换了工作区，这份是旧的
          setLevels((prev) => new Map(prev).set(dir, response.hits));
        },
        () => {
          inflight.current.delete(mark);
          if (at !== scopeKey) return;
          setLevelFailed((prev) => new Set(prev).add(dir));
        },
      );
    }
  }, [browseDir, scopeKey, expanded, levels, levelFailed]);

  // 「手上这份结果正是这次查询的」才算数，否则一律按「还在搜」处理。
  const settled = browseDir !== null
    ? levels.has(browseDir) || levelFailed.has(browseDir)
    : key !== null && result.key === key;
  const rows: MentionTreeRow[] = browseDir !== null
    ? browseRows(browseDir, levels, expanded)
    : searchRows(settled && !result.failed ? result.hits : []);
  // 「还有更多没列出来」只在这批候选确实是这次查询的结果时才说得准。
  const more = browseDir === null && settled && !result.failed && result.more;
  const loading = token !== null && !settled;
  const failed = settled && (browseDir !== null ? levelFailed.has(browseDir) : result.failed);
  const selectable = (at: number) => !rows[at]?.label;
  const clamped = Math.min(index, Math.max(0, rows.length - 1));
  // 分组标签不能是选中项：初值和越界回落都要落在下一个能选的行上。
  const selectedIndex = selectable(clamped) ? clamped : firstSelectable(rows.length, selectable);
  // 搜不到时也留着菜单：它得说出「没有匹配的文件」，否则用户分不清是没匹配还是功能没生效。
  const open = token !== null && (rows.length > 0 || loading || failed);
  const selected: MentionTreeRow | undefined = rows[selectedIndex];

  const pick = (hit: FileSearchHit) => {
    setValue(applyFileMention(value, hit.path));
    setIndex(0);
    setDismissed(false);
    onPicked?.();
  };

  const setDirOpen = (dir: string, next: boolean) => {
    setExpanded((prev) => {
      const updated = new Set(prev);
      if (next) updated.add(dir);
      else updated.delete(dir);
      return updated;
    });
  };

  /**
   * 一行的默认动作（回车、点一下）。目录**没展开就先展开** —— 在树里，选中一个目录的
   * 意思八成是「进去看看」；已经展开了再按才是「就要它这个路径」。提示行跟着选中项改口，
   * 不用猜。
   */
  const activate = (row: MentionTreeRow) => {
    if (row.expandable && !row.expanded) setDirOpen(row.hit.path, true);
    else pick(row.hit);
  };

  /** 接在 textarea 的 onChange 里：正文一变就重新判断要不要弹。 */
  const onValueChange = () => {
    setIndex(0);
    setDismissed(false);
  };

  const reset = () => {
    setIndex(0);
    setDismissed(false);
    setResult({ key: "", hits: [], more: false, failed: false });
    setExpanded(new Set());
  };

  /**
   * 树的左右键。`at` 是选中项在 `rows` 里的下标（合并列表要先减掉前面那些智能体），
   * `onSelect` 是把新下标落回**那张列表自己的**选中状态 —— 单飞对话框的下标空间跟树
   * 的不一样，不能由这里直接 setIndex。
   */
  const onTreeKey = (
    event: KeyboardEvent,
    at: number = selectedIndex,
    onSelect: (next: number) => void = setIndex,
  ): boolean => {
    const action = treeKeyAction(event.key, rows, at);
    if (!action) return false;
    event.preventDefault();
    if (action.type === "select") onSelect(action.index);
    else setDirOpen(action.dir, action.type === "expand");
    return true;
  };

  /** 返回 true = 这个按键已经被菜单吃掉了，调用方不要再处理。 */
  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!open) return false;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length) {
      event.preventDefault();
      setIndex(stepIndex(rows.length, selectedIndex, event.key === "ArrowDown" ? 1 : -1, selectable));
      return true;
    }
    if (onTreeKey(event)) return true;
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      // 菜单开着时回车一律归菜单，哪怕这会儿还没有候选可选：这时候插进去的换行会把
      // `@token` 顶到非行尾，菜单当场收起，用户还得退回来重敲。等一下再按就是了。
      event.preventDefault();
      if (selected) activate(selected);
      return true;
    }
    if (event.key === "Escape") {
      // 只关菜单：外层多半挂着「Esc 关掉整个面板」，别让它一起吃了。
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      return true;
    }
    return false;
  };

  return {
    token, rows, more, loading, failed, open, browsing: browseDir !== null,
    index: selectedIndex, selected, setIndex,
    pick, activate, onTreeKey, onKeyDown, onValueChange, reset,
  };
}
