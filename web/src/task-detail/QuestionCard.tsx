// 答题卡：智能体停下来问你的时候，它占住回复框的位置（宿主见 QuestionSlot.tsx）。题目、选项、
// 自己写的那一行、一颗发送键都在这一张卡里——全卡只有一处能打字、一颗发送键。
//
// 卡里不再套框：一块面板，细线分段；选项一行一个，行首一小格是数字（也是快捷键），勾上变成
// 黑底对勾。勾了就是选了，不再把那句话抄进输入框；最后一行只写补充，发出去的是两者拼起来的
// （joinQuestionAnswer，跟从前的答复文本同一种形状）。
import { useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { QuestionItem, TaskListItem } from "@ash/shared";
import { CaretDown, Check } from "@phosphor-icons/react";
import {
  formatQuestionAnswers, joinQuestionAnswer, questionItems, questionKey, type QuestionAnswerInput,
} from "@ash/shared/questions";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";
import { isSendKeyEvent } from "../lib/sendKey.ts";
import { useSendKeyLabels } from "../lib/useComposerSendKey.ts";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";

/** 背景短就直接摊开：为两行字多设一次「点开看全」纯属添堵。 */
const CONTEXT_CLAMP_CHARS = 110;

type Draft = { picked: ReadonlySet<number>; note: string };
const EMPTY: Draft = { picked: new Set(), note: "" };

export type QuestionCardProps = {
  task: TaskListItem;
  /** 问的是派出的那一条（不是这一页的任务）：它的标题，写在题目前面。题目和选项照它的原话。 */
  asker?: string;
  onAnswer: (answer: string, input: QuestionAnswerInput) => Promise<void>;
  /** 收起：只剩题目一行，平常的回复框回到它下面（QuestionSlot 管）。已勾的、已写的都还在。 */
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
};

/**
 * 最后一行那个输入框。单独成一个组件是为了让自动撑高跟着输入框本身挂载：收起时输入框卸掉、展开时
 * 换了一个新节点，撑高的那份记账（上次写的高度、是否被拖过）得跟着重来，不然展开后的新框会被当成
 * 「拖过了」，从此不再长高。
 */
function NoteField({ inputRef, value, disabled, label, placeholder, onChange, onCommit }: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  disabled: boolean;
  label: string;
  placeholder: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  useAutoGrowTextarea(inputRef, { value, maxLines: 6 });
  return (
    <textarea ref={inputRef} value={value} rows={1} disabled={disabled} aria-label={label} placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (!isSendKeyEvent(event)) return;
        event.preventDefault();
        onCommit();
      }}
    />
  );
}

/** 引在收起那一行里的题目：一行纯文字，长了交给样式截。 */
const plain = (text: string) => text.replace(/\s+/g, " ").trim();

export function QuestionCard({ task, asker, onAnswer, collapsed, onCollapsedChange }: QuestionCardProps) {
  const items = questionItems(task);
  const multi = items.length > 1;
  const [drafts, setDrafts] = useState<Draft[]>(() => items.map(() => EMPTY));
  const [index, setIndex] = useState(0);
  const [contextOpen, setContextOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const sendKeys = useSendKeyLabels();
  const sendTip = useHoverTip({ placement: "above" });

  const current = Math.min(index, items.length - 1);
  const item: QuestionItem = items[current]!;
  const options = item.options ?? [];
  const draft = drafts[current] ?? EMPTY;
  const answers = items.map((entry, i) => joinQuestionAnswer(entry.options ?? [], drafts[i]?.picked ?? EMPTY.picked, drafts[i]?.note ?? ""));
  const answered = answers.filter(Boolean).length;
  // 有提问又在跑：要么是提问的那一轮还在收尾，要么是哨兵事件这类后端代写的一轮（真人消息会撤下
  // 旧提问，见 server/src/task-question-supersede.ts）。两种都只能等这一轮结束。团队调度台是常驻
  // 会话，忙着也接得住。
  const settling = task.mode !== "team" && (task.status === "running" || task.status === "queued");
  const unavailable = settling || sending || sent;
  const last = current >= items.length - 1;
  const context = multi ? task.question?.trim() ?? "" : "";
  const clampable = context.length > CONTEXT_CLAMP_CHARS;
  // 最后一格的数字：有选项时它是下一格，按它光标落进去。9 以后没有数字键可按，就不写。
  const noteKey = options.length && options.length < 9 ? options.length + 1 : null;

  const update = (next: (draft: Draft) => Draft) =>
    setDrafts((list) => list.map((entry, i) => i === current ? next(entry ?? EMPTY) : entry));
  const toggle = (option: number) => update((entry) => {
    const picked = new Set(entry.picked);
    if (picked.has(option)) picked.delete(option);
    else picked.add(option);
    return { ...entry, picked };
  });
  // 翻到另一题是你主动的，这时候接管焦点才不突兀：有选项落在第一项上（数字键立刻能按），没有就落进
  // 输入行。卡片刚冒出来那一次不抢——你多半还在读上文。
  const go = (next: number) => {
    setIndex(Math.max(0, Math.min(items.length - 1, next)));
    requestAnimationFrame(() => {
      const target = optionsRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? input.current;
      target?.focus();
    });
  };
  const submit = async () => {
    if (inFlight.current || unavailable || !answered) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      await onAnswer(formatQuestionAnswers(answers), { answers, questionKey: questionKey(task) });
      setSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  const commit = () => { if (last) void submit(); else go(current + 1); };

  // 数字键只在焦点不在输入框时生效，否则打字全成了勾选。
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    if (event.metaKey || event.ctrlKey || event.altKey || !/^[1-9]$/.test(event.key)) return;
    const key = Number(event.key);
    if (key <= options.length) {
      event.preventDefault();
      if (!unavailable) toggle(key - 1);
    } else if (key === noteKey || (!options.length && key === 1)) {
      event.preventDefault();
      input.current?.focus();
    }
  };

  const label = asker ? `「${asker}」在等答复的问题` : "等待答复的问题";
  if (collapsed) {
    return (
      <section className="question-card is-collapsed" aria-label={label}>
        <button type="button" className="question-card-peek" aria-expanded="false" onClick={() => onCollapsedChange(false)}>
          <span>{asker && <b className="question-card-asker">「{asker}」问：</b>}{plain(item.question)}</span>
          <CaretDown size={13} weight="bold" aria-hidden="true" />
        </button>
      </section>
    );
  }

  const sendLabel = sending ? "发送中…" : sent ? "已发送" : last ? "发送答复" : "下一题";
  return (
    <section className="question-card" aria-label={label} aria-busy={sending} onKeyDown={onKeyDown}>
      <header className="question-card-head">
        <div className="question-card-prompt">
          {asker && <p className="question-card-asker">「{asker}」问：</p>}
          {context && (
            <div
              className={`question-card-context${clampable && !contextOpen ? " is-clamped" : ""}`}
              {...(clampable ? {
                role: "button", tabIndex: 0, "aria-expanded": contextOpen,
                onClick: () => setContextOpen((open) => !open),
                onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setContextOpen((open) => !open);
                },
              } : {})}
            >
              <MarkdownBody text={context} />
            </div>
          )}
          <div className="question-card-title"><MarkdownBody text={item.question} /></div>
        </div>
        <div className="question-card-tools">
          {/* 题号就是进度：当前题实心，答过的字是墨色，没答的淡；点一下直接跳过去。 */}
          {multi && (
            <nav className="question-card-steps" aria-label="题目进度">
              {items.map((_entry, i) => (
                <button type="button" key={i} disabled={sending || sent}
                  className={answers[i] ? "is-answered" : undefined}
                  aria-current={i === current ? "step" : undefined}
                  aria-label={`第 ${i + 1} 题${answers[i] ? "（已答）" : "（未答）"}`}
                  onClick={() => go(i)}>{i + 1}</button>
              ))}
            </nav>
          )}
          <button type="button" className="question-card-collapse" aria-expanded="true" aria-label="收起答题卡，先看上文"
            onClick={() => onCollapsedChange(true)}>
            <CaretDown size={13} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </header>
      {!!options.length && (
        <div className="question-card-options" ref={optionsRef} role="group" aria-label={`${plain(item.question)}的建议答案`}>
          {options.map((option, i) => {
            const selected = draft.picked.has(i);
            return (
              <button type="button" key={`${current}:${i}:${option}`} disabled={unavailable} aria-pressed={selected}
                aria-describedby={i === 0 ? hintId : undefined} onClick={() => toggle(i)}>
                <span className="question-card-key" aria-hidden="true">
                  {selected ? <Check size={11} weight="bold" /> : i < 9 ? i + 1 : ""}
                </span>
                <span>{option}</span>
              </button>
            );
          })}
        </div>
      )}
      {/* 读屏看不见行首那一格的意思，照旧念给它听。 */}
      {!!options.length && <small id={hintId} className="task-visually-hidden">
        可多选 · 数字键 1–{Math.min(options.length, 9)} 勾选{noteKey ? `，${noteKey} 写自己的话` : ""}
      </small>}
      <div className="question-card-note">
        {!!options.length && <span className="question-card-key" aria-hidden="true">{noteKey ?? ""}</span>}
        <NoteField inputRef={input} value={draft.note} disabled={unavailable}
          label={`答复：${plain(item.question)}`}
          placeholder={settling ? "这一轮结束后即可答复" : options.length ? "自己写，或者补一句…" : "写下你的答案…"}
          onChange={(note) => update((entry) => ({ ...entry, note }))}
          onCommit={commit}
        />
        <button type="button" className="question-card-send" disabled={unavailable || !answered}
          onClick={commit} aria-describedby={`${task.id}-answer-key`} {...sendTip.anchorProps}>
          {sent && <Check size={13} aria-hidden="true" />}
          {sendLabel}
        </button>
        {/* 键名不常驻；读屏仍从按钮的描述里念到此刻生效的那一档。 */}
        <span id={`${task.id}-answer-key`} className="task-visually-hidden">{sendKeys.send} {last ? "发送" : "下一题"}</span>
        {!unavailable && !!answered && <HoverTip at={sendTip.at}>{last ? "发送答复" : "下一题"}<kbd>{sendKeys.send}</kbd></HoverTip>}
      </div>
      {error && <p className="question-card-error" role="alert">{error}</p>}
    </section>
  );
}
