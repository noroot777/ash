import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type FileSearchHit } from "./api.ts";
import { applyFileMention, fileMentionToken } from "./fileMention.ts";

// 输入框里 `@` 引用工作区文件的那半套逻辑：候选怎么取、菜单键盘怎么走。
// token 怎么认、选中后正文怎么改在 fileMention.ts（纯函数，好单测）。
//
// 三个表面共用同一份（新建任务、单飞任务对话框、团队对话框），因为「@ 出来的路径长什么
// 样」必须处处一致 —— 它最终是原样发给 CLI 的一段文本，某个表面自己加个前缀或少个引号，
// agent 那边就找不着文件，而用户看不出两个输入框有什么不同。
//
// 选中之后 `@相对路径` **原样留在正文里**，不摘走、不转成附件：claude / codex 都认得
// prompt 里的 `@path`，这一句本来就是要让它去读那个文件。

export type FileMentionScope =
  | { kind: "task"; taskId: string }
  | { kind: "project"; projectId: string };

/** useFileMention 的返回形状。菜单组件按它取数，不必反着推 hook 的类型。 */
export type FileMentionState = ReturnType<typeof useFileMention>;

/** 边打边搜的防抖。比按键间隔略长，又短到打完一顿就出结果。 */
const DEBOUNCE_MS = 120;

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
  const [result, setResult] = useState<{ key: string; hits: FileSearchHit[]; failed: boolean }>(
    { key: "", hits: [], failed: false },
  );
  // 搜过的查询记着：删掉一个字母退回上一个查询时不必再跑一趟网络。
  const cache = useRef(new Map<string, FileSearchHit[]>());
  const scopeKey = scope ? `${scope.kind}:${scope.kind === "task" ? scope.taskId : scope.projectId}` : "";
  const token = disabled || dismissed || !scope ? null : fileMentionToken(value);
  // 一次查询的身份：换了工作区，同样的 token 也是另一次查询。
  const key = token === null ? null : `${scopeKey}|${token}`;

  useEffect(() => {
    cache.current.clear();
  }, [scopeKey]);

  useEffect(() => {
    if (key === null || token === null || !scope) return;
    const cached = cache.current.get(key);
    if (cached) {
      setResult({ key, hits: cached, failed: false });
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
          cache.current.set(key, response.hits);
          setResult({ key, hits: response.hits, failed: false });
        },
        () => {
          // 中止不是失败：正在打字，这一趟本来就该作废。
          if (controller.signal.aborted) return;
          setResult({ key, hits: [], failed: true });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  // 「手上这份结果正是这次查询的」才算数，否则一律按「还在搜」处理。
  const settled = key !== null && result.key === key;
  const visible = settled && !result.failed ? result.hits : [];
  const loading = key !== null && !settled;
  const failed = settled && result.failed;
  const selectedIndex = Math.min(index, Math.max(0, visible.length - 1));
  // 搜不到时也留着菜单：它得说出「没有匹配的文件」，否则用户分不清是没匹配还是功能没生效。
  const open = token !== null && (visible.length > 0 || loading || failed);

  const pick = (hit: FileSearchHit) => {
    setValue(applyFileMention(value, hit.path));
    setIndex(0);
    setDismissed(false);
    onPicked?.();
  };

  /** 接在 textarea 的 onChange 里：正文一变就重新判断要不要弹。 */
  const onValueChange = () => {
    setIndex(0);
    setDismissed(false);
  };

  const reset = () => {
    setIndex(0);
    setDismissed(false);
    setResult({ key: "", hits: [], failed: false });
  };

  /** 返回 true = 这个按键已经被菜单吃掉了，调用方不要再处理。 */
  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!open) return false;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visible.length) {
      event.preventDefault();
      setIndex((selectedIndex + (event.key === "ArrowDown" ? 1 : visible.length - 1)) % visible.length);
      return true;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      // 菜单开着时回车一律归菜单，哪怕这会儿还没有候选可选：这时候插进去的换行会把
      // `@token` 顶到非行尾，菜单当场收起，用户还得退回来重敲。等一下再按就是了。
      event.preventDefault();
      if (visible.length) pick(visible[selectedIndex]!);
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

  return { token, hits: visible, loading, failed, open, index: selectedIndex, setIndex, pick, onKeyDown, onValueChange, reset };
}
