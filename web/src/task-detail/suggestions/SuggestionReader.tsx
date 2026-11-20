// 读全文的那一屉里，一件可以派出去的活长什么样（从左边出，同子智能体那一屉，components/LeftDrawer.tsx）。
// 抽屉头：「交给 xx · 从哪开工」和标题，一颗「改」；正文：排好版的说明，用户补了话时末尾多一段「你补的话」。
// 按下「改」：标题变成一格输入、正文变成 markdown 原文直接改，再按一次（「改好了」）回到排好版的样子。
//
// 这几个组件是开抽屉那一刻交出去的，之后跟着那一行变，靠按身份订阅 suggestionStore。
import { useEffect, useRef } from "react";
import { MarkdownBody } from "../../components/MarkdownBody.tsx";
import { editOf, editSuggestion, editingOf, setEditing, useSuggestionStore, viewOf } from "./suggestionStore.ts";

export function SuggestionDrawerKind({ id }: { id: string }) {
  useSuggestionStore();
  const view = viewOf(id);
  if (!view) return null;
  return <>{[`交给 ${view.who}`, view.baseLabel].filter(Boolean).join(" · ")}</>;
}

export function SuggestionDrawerTitle({ id }: { id: string }) {
  useSuggestionStore();
  const view = viewOf(id);
  if (!view) return null;
  if (!editingOf(id)) return <>{view.title || "没写标题"}</>;
  return (
    <input className="sg-reading-title" aria-label="任务标题" value={editOf(id).title ?? view.title}
      onChange={(event) => editSuggestion(id, { title: event.target.value })} />
  );
}

export function SuggestionDrawerEdit({ id }: { id: string }) {
  useSuggestionStore();
  const on = editingOf(id);
  return (
    <button type="button" className="sg-reading-edit" aria-pressed={on} onClick={() => setEditing(on ? null : id)}>
      {on ? "改好了" : "改"}
    </button>
  );
}

export function SuggestionDrawerBody({ id }: { id: string }) {
  useSuggestionStore();
  const view = viewOf(id);
  const source = useRef<HTMLTextAreaElement>(null);
  const on = editingOf(id);
  useEffect(() => { if (on) source.current?.focus(); }, [on]);
  // 关上抽屉就不在改了：下次打开先看排好版的那一份。
  useEffect(() => () => setEditing(null), []);
  if (!view) return null;
  if (on) {
    return (
      <textarea ref={source} className="sg-reading-source" aria-label="完整说明" value={editOf(id).body ?? view.body}
        onChange={(event) => editSuggestion(id, { body: event.target.value })} />
    );
  }
  return (
    <div className="sg-reading">
      <MarkdownBody text={view.body} />
      {view.extra.trim() && (
        <div className="sg-reading-extra">
          <h4>你补的话</h4>
          <p>{view.extra.trim()}</p>
        </div>
      )}
    </div>
  );
}
