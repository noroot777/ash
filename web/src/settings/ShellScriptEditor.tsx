import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { TerminalWindow } from "@phosphor-icons/react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder as editorPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, bracketMatching, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { tags } from "@lezer/highlight";
import { MAX_PREVIEW_SCRIPT_LENGTH } from "@ash/shared/preview";
import "./shell-script-editor.css";

// 项目里所有「写一段 shell 脚本」的编辑面：预览启动脚本（ProjectPreviewSettings）和常用
// 命令（ProjectCommandsSettings）共用这一个。带行号、语法高亮、Tab 缩进、自动换行开关。
//
// 高度有两档，互不打架：
//   自适应 —— 默认。跟着内容长，下限 minRows（常用命令给 1 行 = 平时就一条命令的样子）、
//             上限 maxRows，超过就在框里滚。量的是 CodeMirror 自己算出来的 contentHeight，
//             所以自动换行折出来的行也算数。
//   手动   —— 用户拖过底边之后，高度就钉在他拖到的位置（存 localStorage，按 heightKey 分开
//             记），双击底边条恢复自适应。拖动优先于自适应：手动调过之后不该再被内容顶动。
const LINE_HEIGHT = 21;
const CONTENT_PADDING = 16;
const MAX_DRAG_HEIGHT = 900;

const externalValue = Annotation.define<boolean>();
const wrapStorageKey = "ash:preview-command-wrap";
const heightStorageKey = "ash:shell-editor-height";
const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--accent)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--green)" },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: "var(--cyan)" },
  { tag: [tags.standard(tags.variableName), tags.operator], color: "var(--accent)" },
  { tag: [tags.number, tags.bool, tags.attributeName], color: "var(--amber)" },
  { tag: [tags.comment, tags.meta], color: "var(--muted)", fontStyle: "italic" },
]);

export function useShellScriptWrapping() {
  const [wrap, setWrap] = useState(() => {
    try { return localStorage.getItem(wrapStorageKey) === "true"; }
    catch { return false; }
  });
  const updateWrap = (next: boolean) => {
    setWrap(next);
    try { localStorage.setItem(wrapStorageKey, String(next)); }
    catch { /* 浏览器禁用存储时，偏好仍在当前设置页生效。 */ }
  };
  return [wrap, updateWrap] as const;
}

function readStoredHeight(key: string | undefined): number | null {
  if (!key) return null;
  try {
    const stored = JSON.parse(localStorage.getItem(heightStorageKey) ?? "{}") as Record<string, unknown>;
    const value = stored[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch { return null; }
}

function writeStoredHeight(key: string | undefined, height: number | null): void {
  if (!key) return;
  try {
    const stored = JSON.parse(localStorage.getItem(heightStorageKey) ?? "{}") as Record<string, unknown>;
    if (height === null) delete stored[key];
    else stored[key] = Math.round(height);
    localStorage.setItem(heightStorageKey, JSON.stringify(stored));
  } catch { /* 禁用存储时高度只在本次会话里有效。 */ }
}

export function ShellScriptEditor({
  label, value, onChange, readOnly, minRows = 1, maxRows = 16, maxLength = MAX_PREVIEW_SCRIPT_LENGTH,
  heightKey, placeholder, wrap, onWrapChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  /** 自适应高度的下限（行）。 */
  minRows?: number;
  /** 自适应高度的上限（行）；再长就在框里滚，手动拖仍可超过。 */
  maxRows?: number;
  maxLength?: number;
  /** 给了就把用户拖出来的高度记在 localStorage 里（同一个框下次打开还是那么高）。 */
  heightKey?: string;
  placeholder?: string;
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const options = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const [limitReached, setLimitReached] = useState(false);
  const [contentHeight, setContentHeight] = useState(minRows * LINE_HEIGHT + CONTENT_PADDING);
  const [dragged, setDragged] = useState<number | null>(() => readStoredHeight(heightKey));
  onChangeRef.current = onChange;

  const minHeight = minRows * LINE_HEIGHT + CONTENT_PADDING;
  const maxHeight = Math.max(minHeight, maxRows * LINE_HEIGHT + CONTENT_PADDING);
  const height = dragged ?? Math.min(Math.max(contentHeight, minHeight), maxHeight);
  const heightRef = useRef(height);
  heightRef.current = height;

  useLayoutEffect(() => {
    const editor = new EditorView({
      parent: container.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
          history(), keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          StreamLanguage.define(shell), syntaxHighlighting(highlighting), bracketMatching(),
          indentUnit.of("  "), EditorState.tabSize.of(2), options.current.of([]),
          EditorState.changeFilter.of((transaction) => {
            const allowed = transaction.newDoc.length <= maxLength
              || transaction.newDoc.length <= transaction.startState.doc.length;
            if (!allowed) setLimitReached(true);
            return allowed;
          }),
          EditorView.updateListener.of((update) => {
            // 内容或排版一变就重新量一次：自动换行、字体加载、外部塞值都会改高度。
            if (update.docChanged || update.geometryChanged) setContentHeight(update.view.contentHeight);
            if (!update.docChanged) return;
            setLimitReached(false);
            if (!update.transactions.some((transaction) => transaction.annotation(externalValue))) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    setContentHeight(editor.contentHeight);
    return () => { view.current = null; editor.destroy(); };
  }, [maxLength]);

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: options.current.reconfigure([
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({
        "aria-label": label, "aria-multiline": "true", "aria-readonly": String(readOnly),
        role: "textbox", tabindex: "0", spellcheck: "false", autocapitalize: "off", autocorrect: "off",
      }),
      wrap ? EditorView.lineWrapping : [],
      placeholder ? editorPlaceholder(placeholder) : [],
    ]) });
  }, [label, readOnly, wrap, placeholder]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: [externalValue.of(true), Transaction.addToHistory.of(false)],
        filter: false,
      });
    }
  }, [value]);

  // ── 底边条 = 拖拽把手 ──────────────────────────────────────────────────
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const clampHeight = useCallback(
    (next: number) => Math.min(Math.max(next, minHeight), Math.max(minHeight, MAX_DRAG_HEIGHT)),
    [minHeight],
  );
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: heightRef.current };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    setDragged(clampHeight(drag.current.startHeight + (event.clientY - drag.current.startY)));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    writeStoredHeight(heightKey, heightRef.current);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" ? LINE_HEIGHT : event.key === "ArrowUp" ? -LINE_HEIGHT : 0;
    if (step) {
      event.preventDefault();
      const next = clampHeight(heightRef.current + step);
      setDragged(next);
      writeStoredHeight(heightKey, next);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDragged(null);
      writeStoredHeight(heightKey, null);
    }
  };
  const resetHeight = () => { setDragged(null); writeStoredHeight(heightKey, null); };

  return <div className="shell-editor" data-readonly={readOnly || undefined} style={{ "--shell-editor-height": `${Math.round(height)}px` } as CSSProperties}>
    <div className="shell-editor__toolbar">
      <span><TerminalWindow size={14} aria-hidden="true" />Shell{readOnly && <span>只读</span>}</span>
      <label><input type="checkbox" aria-label={`${label} 自动换行`} checked={wrap} onChange={(event) => onWrapChange(event.target.checked)} />自动换行</label>
    </div>
    <div className="shell-editor__surface" ref={container} />
    <div
      className="shell-editor__foot"
      role="separator"
      aria-orientation="horizontal"
      aria-label={`${label} 调整高度：上下方向键微调，回车恢复自适应`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={resetHeight}
    >
      <span className="shell-editor__hint">{readOnly ? "拖底边调整高度 · 双击恢复自适应" : "Tab 缩进 · Esc 后按 Tab 移出 · 拖底边调整高度（双击恢复自适应）"}</span>
      <span className="shell-editor__grip" aria-hidden="true" />
    </div>
    {limitReached && <div className="shell-editor__limit" role="alert">脚本最多 {maxLength.toLocaleString()} 个字符，本次输入未添加。</div>}
  </div>;
}
