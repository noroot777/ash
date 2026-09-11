import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { TerminalWindow } from "@phosphor-icons/react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder as editorPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, bracketMatching, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { tags } from "@lezer/highlight";
import { MAX_PREVIEW_SCRIPT_LENGTH } from "@ash/shared/preview";
import "./preview-command-editor.css";

const externalValue = Annotation.define<boolean>();
const wrapStorageKey = "ash:preview-command-wrap";
const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--accent)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--green)" },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: "var(--cyan)" },
  { tag: [tags.standard(tags.variableName), tags.operator], color: "var(--accent)" },
  { tag: [tags.number, tags.bool, tags.attributeName], color: "var(--amber)" },
  { tag: [tags.comment, tags.meta], color: "var(--muted)", fontStyle: "italic" },
]);

export function usePreviewCommandWrapping() {
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

export function PreviewCommandEditor({ label, value, onChange, readOnly, rows, placeholder, wrap, onWrapChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  rows: number;
  placeholder?: string;
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const options = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const [limitReached, setLimitReached] = useState(false);
  onChangeRef.current = onChange;

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
            const allowed = transaction.newDoc.length <= MAX_PREVIEW_SCRIPT_LENGTH
              || transaction.newDoc.length <= transaction.startState.doc.length;
            if (!allowed) setLimitReached(true);
            return allowed;
          }),
          EditorView.updateListener.of((update) => {
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
    return () => { view.current = null; editor.destroy(); };
  }, []);

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

  return <div className="preview-command-editor" data-readonly={readOnly || undefined} style={{ "--command-editor-min-height": `${rows * 21 + 16}px` } as CSSProperties}>
    <div className="preview-command-toolbar">
      <span><TerminalWindow size={14} aria-hidden="true" />Shell{readOnly && <span>只读</span>}</span>
      <label><input type="checkbox" aria-label={`${label} 自动换行`} checked={wrap} onChange={(event) => onWrapChange(event.target.checked)} />自动换行</label>
    </div>
    <div className="preview-command-surface" ref={container} />
    {!readOnly && <div className="preview-command-hint">Tab 缩进 · Esc 后按 Tab 移出</div>}
    {limitReached && <div className="preview-command-limit" role="alert">脚本最多 {MAX_PREVIEW_SCRIPT_LENGTH.toLocaleString()} 个字符，本次输入未添加。</div>}
  </div>;
}
