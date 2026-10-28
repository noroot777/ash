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

export function TaskMemoCard({ memo, busy, highlight, draft, onDraft, onSave, onDelete }: {
  memo: TaskMemo;
  busy: boolean;
  /** 刚加进来的那条：扫一眼就知道落在哪儿了（切过来的时候列表可能已经有十几条）。 */
  highlight: boolean;
  /**
   * 这条的编辑草稿；null = 读态。**编辑态是受控的**，state 住在 task-memos/taskMemoDrafts.ts
   * —— 放在这里的话，面板被自动切走（任务 status 一变就会）时草稿跟着卸载一起没。
   */
  draft: string | null;
  onDraft: (next: string | null) => void;
  /** 存这条的新正文。**回 false = 没存上** —— 那时必须留在编辑态（见 save）。 */
  onSave: (body: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const editing = draft !== null;
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

  // 光标落到末尾：改备忘九成是往后补一句，不是重写。进编辑态时做一次，**重新挂载时
  // 也做**（面板被自动切走又切回来，草稿还在编辑框里，焦点该跟着回去）。
  useEffect(() => {
    if (!editing) return;
    const node = input.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    // 只在进/出编辑态时跑：打字途中重设选区会把光标踢到末尾。
  }, [editing]);

  // 存上了才退出编辑态。断网 / 503 / 后端拒绝时继续留在框里，草稿一个字不动 ——
  // 这一格的正文动辄几百字，把失败当成功退出去，effect 会立刻用旧正文覆盖掉它们。
  const save = async () => {
    const text = (draft ?? "").trim();
    if (!text || text === memo.body) { onDraft(null); return; }
    if (await onSave(text)) onDraft(null);
  };

  const edited = memo.updatedAt !== memo.createdAt;

  return (
    <article ref={card} className={`task-memo-card${highlight ? " is-new" : ""}`}>
      <header>
        <time dateTime={memo.updatedAt}>{formatInstant(memo.updatedAt)}</time>
        {edited && <span className="task-memo-card__edited">已编辑</span>}
        {!editing && (
          <div className="task-memo-card__actions">
            <button type="button" aria-label="编辑这条备忘" disabled={busy} onClick={() => onDraft(memo.body)}>
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
            value={draft ?? ""}
            maxLength={TASK_MEMO_MAX_LEN}
            rows={Math.min(16, Math.max(4, (draft ?? "").split("\n").length + 1))}
            disabled={busy}
            onChange={(event) => onDraft(event.target.value)}
            // Esc 撤销这次编辑。回车留给换行 —— 备忘天生是多行的东西。
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); onDraft(null); }
            }}
          />
          <div className="task-memo-card__edit-actions">
            <button type="button" disabled={busy} onClick={() => onDraft(null)}>
              <X size={12} />取消
            </button>
            <button type="button" className="is-primary" disabled={busy || !(draft ?? "").trim()} onClick={() => void save()}>
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
