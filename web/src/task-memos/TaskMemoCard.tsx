// 备忘面板里的一条。两种形态同住一个组件：读（带展开/收起）与改（整条换成输入框）。
//
// **长正文是这一格的主要矛盾**（用户 2026-10-28：「几百字一条的备注应该是有的」）。
// 侧栏默认 340px 宽，几百字铺下来就是二十来行 —— 三五条就把面板顶成一条长卷，谁也找不到
// 自己要的那条。所以读态默认折到 CLAMP_LINES 行，溢出才给「展开」；是不是真溢出要**量**
// （scrollHeight > clientHeight），按字数猜在不同字号/缩放下一定会错，猜短了就出现一颗
// 点了什么都没发生的「展开」。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, PencilSimple, TrashSimple, X } from "@phosphor-icons/react";
import type { TaskMemo } from "@ash/shared/task-memo";
import { TASK_MEMO_MAX_LEN } from "@ash/shared/task-memo";
import { formatInstant } from "../task-detail/utils.ts";

/** 折起来时露几行。再少就看不出这条在说什么，再多就等于没折。 */
const CLAMP_LINES = 7;

export function TaskMemoCard({ memo, busy, highlight, onSave, onDelete }: {
  memo: TaskMemo;
  busy: boolean;
  /** 刚加进来的那条：扫一眼就知道落在哪儿了（切过来的时候列表可能已经有十几条）。 */
  highlight: boolean;
  onSave: (body: string) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memo.body);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const body = useRef<HTMLParagraphElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLElement>(null);

  // 折叠线是按行高算的，所以量要等布局定下来（useLayoutEffect），否则第一帧会先闪一下
  // 没有「展开」的样子。面板宽度可拖，同一条正文在窄栏里溢出、拖宽了就不溢出，所以
  // 跟着尺寸一起重量。
  useLayoutEffect(() => {
    const node = body.current;
    if (!node || editing) return;
    const measure = () => setOverflowing(node.scrollHeight - node.clientHeight > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [editing, expanded, memo.body]);

  useEffect(() => {
    if (!highlight) return;
    card.current?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // 外面（别的标签页、同一条被改过）换了内容时跟上；自己正在编辑就不动，免得把草稿吞掉。
  useEffect(() => {
    if (!editing) setDraft(memo.body);
  }, [editing, memo.body]);

  const startEditing = () => {
    setDraft(memo.body);
    setEditing(true);
    // 光标落到末尾：改备忘九成是往后补一句，不是重写。
    requestAnimationFrame(() => {
      const node = input.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    });
  };

  const save = async () => {
    const text = draft.trim();
    if (!text || text === memo.body) { setEditing(false); return; }
    await onSave(text);
    setEditing(false);
  };

  const edited = memo.updatedAt !== memo.createdAt;

  return (
    <article ref={card} className={`task-memo-card${highlight ? " is-new" : ""}`}>
      <header>
        <time dateTime={memo.updatedAt}>{formatInstant(memo.updatedAt)}</time>
        {edited && <span className="task-memo-card__edited">已编辑</span>}
        {!editing && (
          <div className="task-memo-card__actions">
            <button type="button" aria-label="编辑这条备忘" disabled={busy} onClick={startEditing}>
              <PencilSimple size={13} />
            </button>
            <button type="button" className="is-danger" aria-label="删除这条备忘" disabled={busy} onClick={onDelete}>
              <TrashSimple size={13} />
            </button>
          </div>
        )}
      </header>
      {editing ? (
        <div className="task-memo-card__edit">
          <textarea
            ref={input}
            value={draft}
            maxLength={TASK_MEMO_MAX_LEN}
            rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            // Esc 撤销这次编辑。回车留给换行 —— 备忘天生是多行的东西。
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); setEditing(false); setDraft(memo.body); }
            }}
          />
          <div className="task-memo-card__edit-actions">
            <button type="button" disabled={busy} onClick={() => { setEditing(false); setDraft(memo.body); }}>
              <X size={12} />取消
            </button>
            <button type="button" className="is-primary" disabled={busy || !draft.trim()} onClick={() => void save()}>
              <Check size={12} />保存
            </button>
          </div>
        </div>
      ) : (
        <>
          <p
            ref={body}
            className="task-memo-card__body"
            style={expanded ? undefined : { maxHeight: `calc(${CLAMP_LINES} * 1.75em)` }}
          >
            {memo.body}
          </p>
          {(overflowing || expanded) && (
            <button type="button" className="task-memo-card__more" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收起" : "展开全文"}
            </button>
          )}
        </>
      )}
    </article>
  );
}
