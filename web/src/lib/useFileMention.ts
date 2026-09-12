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
  const [hits, setHits] = useState<FileSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // 搜过的 token 记着：删掉一个字母退回上一个查询时不必再跑一趟网络。
  const cache = useRef(new Map<string, FileSearchHit[]>());
  const scopeKey = scope ? `${scope.kind}:${scope.kind === "task" ? scope.taskId : scope.projectId}` : "";
  const token = disabled || dismissed || !scope ? null : fileMentionToken(value);

  useEffect(() => {
    cache.current.clear();
  }, [scopeKey]);

  useEffect(() => {
    if (token === null || !scope) {
      setLoading(false);
      return;
    }
    const cached = cache.current.get(token);
    if (cached) {
      setHits(cached);
      setLoading(false);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const request = scope.kind === "task"
        ? api.taskFileSearch(scope.taskId, token, controller.signal)
        : api.projectFileSearch(scope.projectId, token, controller.signal);
      request.then(
        (result) => {
          if (controller.signal.aborted) return;
          cache.current.set(token, result.hits);
          setHits(result.hits);
          setFailed(false);
          setLoading(false);
        },
        () => {
          // 中止不是失败：正在打字，这一趟本来就该作废。
          if (controller.signal.aborted) return;
          setHits([]);
          setFailed(true);
          setLoading(false);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [token, scopeKey]);

  const visible = token === null ? [] : hits;
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
    setHits([]);
    setFailed(false);
  };

  /** 返回 true = 这个按键已经被菜单吃掉了，调用方不要再处理。 */
  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!open) return false;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visible.length) {
      event.preventDefault();
      setIndex((selectedIndex + (event.key === "ArrowDown" ? 1 : visible.length - 1)) % visible.length);
      return true;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && visible.length) {
      event.preventDefault();
      pick(visible[selectedIndex]!);
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
