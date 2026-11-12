// 备忘面板里的一条。两种形态同住一个组件：读（带展开/收起）与改（整条换成输入框）。
//
// **长正文是这一格的主要矛盾**（用户 2026-10-28：「几百字一条的备注应该是有的」）。
// 侧栏默认 340px 宽，几百字铺下来就是二十来行 —— 三五条就把面板顶成一条长卷，谁也找不到
// 自己要的那条。所以读态默认折到 CLAMP_LINES 行，溢出才给「展开」；是不是真溢出要**量**
// （scrollHeight > clientHeight），按字数猜在不同字号/缩放下一定会错，猜短了就出现一颗
// 点了什么都没发生的「展开」。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PencilSimple, TrashSimple } from "@phosphor-icons/react";
import { InspButton, InspTool } from "../inspector/parts.tsx";
import type { TaskMemo } from "@ash/shared/task-memo";
import { TASK_MEMO_MAX_LEN } from "@ash/shared/task-memo";
import { isModEnterEvent } from "../lib/sendKey.ts";
import { formatInstant } from "../task-detail/utils.ts";
import { AutoTextarea } from "../components/AutoTextarea.tsx";

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
  /**
   * 存这条的新正文。**退出编辑态不由这里决定** —— 草稿由共享层在写入收尾时按版本清掉
   * （存上了、而且草稿还是提交那一版才清）。所以失败会留在框里，而在这一发飞着的时候
   * 新写的那一版也不会被它顺手清走（第 3 轮 F1）。
   */
  onSave: (body: string) => Promise<void>;
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

  // 存上了才退出编辑态（断网 / 503 / 后端拒绝时继续留在框里，草稿一个字不动 —— 这一格
  // 的正文动辄几百字）。这里只管「没改动就直接退出」那条捷径：不发请求，也就不占在途
  // 位置；真发出去的那一发，退不退出由共享层按草稿版本判（见 onSave）。
  const save = async () => {
    const text = (draft ?? "").trim();
    if (!text || text === memo.body) { onDraft(null); return; }
    await onSave(text);
  };

  const edited = memo.updatedAt !== memo.createdAt;

  return (
    <article ref={card} className={`insp-card task-memo-card${highlight ? " is-new" : ""}`}>
      {editing ? (
        <div className="task-memo-card__edit">
          <AutoTextarea
            ref={input}
            value={draft ?? ""}
            maxLength={TASK_MEMO_MAX_LEN}
            rows={Math.min(16, Math.max(4, (draft ?? "").split("\n").length + 1))}
            disabled={busy}
            aria-label="备忘内容"
            onChange={(event) => onDraft(event.target.value)}
            // Esc 撤销这次编辑，⌘/Ctrl+回车保存。裸回车留给换行 —— 备忘天生是多行的东西。
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); onDraft(null); }
              else if (isModEnterEvent(event)) { event.preventDefault(); if (!busy) void save(); }
            }}
          />
          <div className="task-memo-card__edit-actions">
            <InspButton variant="quiet" size="sm" disabled={busy} onClick={() => onDraft(null)}>取消</InspButton>
            <InspButton
              variant="pri"
              size="sm"
              disabled={busy || !(draft ?? "").trim()}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              onClick={() => void save()}
            >
              保存
            </InspButton>
          </div>
        </div>
      ) : (
        <>
          <p
            ref={body}
            className="task-memo-card__body"
            style={expanded ? undefined : { maxHeight: `calc(${CLAMP_LINES} * 1.6em)` }}
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
      {/* 底下一行：几点写的（改过就带「已编辑」），编辑、删掉两颗指到这张卡才出。 */}
      <footer className="task-memo-card__foot">
        <time dateTime={memo.updatedAt}>{formatInstant(memo.updatedAt)}{edited ? " · 已编辑" : ""}</time>
        {!editing && (
          <span className="task-memo-card__actions">
            <InspTool label="编辑这条备忘" disabled={busy} onClick={() => onDraft(memo.body)}>
              <PencilSimple aria-hidden="true" />
            </InspTool>
            <InspTool label="删除这条备忘" disabled={busy} onClick={onDelete}>
              <TrashSimple aria-hidden="true" />
            </InspTool>
          </span>
        )}
      </footer>
    </article>
  );
}
