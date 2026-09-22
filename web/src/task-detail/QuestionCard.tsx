import { useEffect, useId, useRef, useState } from "react";
import type { QuestionItem, TaskListItem } from "@ash/shared";
import { CaretDown, CaretLeft, CaretRight, Check, PaperPlaneTilt, Question } from "@phosphor-icons/react";
import {
  formatQuestionAnswers, questionItems, questionKey, questionOptionSelected, toggleQuestionOption,
  type QuestionAnswerInput,
} from "@ash/shared/questions";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";
import { MarkdownBody } from "../components/MarkdownBody.tsx";

/** 背景短就直接摊开：为两行字多设一次「展开」纯属添堵。 */
const CONTEXT_CLAMP_CHARS = 110;

/**
 * 当前这一题。**一次只渲染一题**，靠 key={index} 整个换掉：
 * 挂载时顺手把焦点放进来（有选项落在选项上，数字键立刻能按；没选项直接落输入框），
 * 答案存在父层，所以重挂载不会丢字。
 */
function QuestionStep({ item, value, disabled, autoFocus, onChange, onCommit }: {
  item: QuestionItem;
  value: string;
  disabled: boolean;
  autoFocus: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const list = item.options ?? [];
  useAutoGrowTextarea(input, { value, maxLines: 8 });
  useEffect(() => {
    if (!autoFocus || disabled) return;
    const target = list.length ? options.current?.querySelector("button") : input.current;
    target?.focus();
    // 空依赖是有意的：只在这一题挂载时抢一次焦点。翻页是用户主动的，这时候接管焦点
    // 才不突兀；卡片刚冒出来那一次 autoFocus 是 false，不会把焦点从上文抢走。
  }, []);

  return (
    <div className="task-question-step"
      onKeyDown={(event) => {
        // 数字键选项只在焦点不在输入框时生效，否则打字全成了勾选。
        if (event.target instanceof HTMLTextAreaElement) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const picked = Number(event.key) - 1;
        if (!Number.isInteger(picked) || picked < 0 || picked >= list.length) return;
        event.preventDefault();
        if (!disabled) onChange(toggleQuestionOption(value, list[picked]!));
      }}
    >
      <div className="task-question-title"><MarkdownBody text={item.question} /></div>
      {!!list.length && (
        <div className="task-question-options" ref={options} role="group" aria-label={`${item.question}的建议答案`}>
          {list.map((option, index) => {
            const selected = questionOptionSelected(value, option);
            return (
              <button type="button" key={`${index}:${option}`} disabled={disabled} aria-pressed={selected}
                onClick={() => onChange(toggleQuestionOption(value, option))}>
                <span className="task-question-option-key" aria-hidden="true">
                  {selected ? <Check size={11} weight="bold" /> : index < 9 ? index + 1 : ""}
                </span>
                <span>{option}</span>
              </button>
            );
          })}
        </div>
      )}
      {!!list.length && <small id={hintId} className="task-question-hint">
        可多选，也可编辑下方答案 · 数字键 1–{Math.min(list.length, 9)} 快速勾选
      </small>}
      <textarea ref={input} value={value} rows={1} disabled={disabled}
        aria-label={`答复：${item.question}`} aria-describedby={list.length ? hintId : undefined}
        placeholder={list.length ? "补充或修改…" : "写下你的答案…"}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onCommit();
          }
        }}
      />
    </div>
  );
}

type Props = {
  task: TaskListItem;
  onAnswer: (answer: string, input: QuestionAnswerInput) => Promise<void>;
};

export function QuestionCard(props: Props) {
  return <QuestionForm key={`${props.task.id}:${questionKey(props.task)}`} {...props} />;
}

function QuestionForm({ task, onAnswer }: Props) {
  const items = questionItems(task);
  const multi = !!task.questionItems?.length;
  const [answers, setAnswers] = useState(() => items.map(() => ""));
  const [index, setIndex] = useState(0);
  // 翻过页才抢焦点：卡片刚冒出来时用户多半还在读上文，这时候抢焦点是打扰。
  const [navigated, setNavigated] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const answered = answers.filter((answer) => answer.trim()).length;
  const settling = task.mode !== "team" && (task.status === "running" || task.status === "queued");
  const unavailable = settling || sending || sent;
  const current = Math.min(index, items.length - 1);
  const last = current >= items.length - 1;
  const clampable = multi && !!task.question && task.question.length > CONTEXT_CLAMP_CHARS;

  const go = (next: number) => {
    setNavigated(true);
    setIndex(Math.max(0, Math.min(items.length - 1, next)));
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

  const status = sent ? "已发送" : settling ? "正在结束提问…" : "待答复";
  const hint = sent ? "答复已发送"
    : settling ? "提问结束后即可答复"
    : multi ? `已答 ${answered}/${items.length} · 留空的题会标记为未答`
    : "⌘ / Ctrl + Enter 发送";

  return (
    <section className={`task-question-card${collapsed ? " is-collapsed" : ""}`} aria-label="等待答复的问题" aria-busy={sending}>
      <header className="task-question-heading">
        <span className="task-question-icon"><Question size={16} weight="duotone" aria-hidden="true" /></span>
        <b>需要你的答复</b>
        {multi && !collapsed && (
          <nav className="task-question-progress" aria-label="题目进度">
            {items.map((_item, i) => (
              <button type="button" key={i} disabled={unavailable}
                className={answers[i]?.trim() ? "is-answered" : undefined}
                aria-current={i === current ? "step" : undefined}
                aria-label={`第 ${i + 1} 题${answers[i]?.trim() ? "（已答）" : "（未答）"}`}
                onClick={() => go(i)}>{i + 1}</button>
            ))}
          </nav>
        )}
        <span className="task-question-status">
          {multi && collapsed ? `${answered}/${items.length} · ${status}` : status}
        </span>
        <button type="button" className="task-question-collapse" aria-expanded={!collapsed}
          aria-label={collapsed ? "展开答复卡" : "收起答复卡，先看上文"}
          onClick={() => setCollapsed((value) => !value)}>
          <CaretDown size={13} weight="bold" aria-hidden="true" />
        </button>
      </header>
      {!collapsed && <>
        {multi && task.question && (
          <div className={`task-question-context${clampable && !contextOpen ? " is-clamped" : ""}`}>
            <MarkdownBody text={task.question} />
            {clampable && (
              <button type="button" onClick={() => setContextOpen((value) => !value)}>
                {contextOpen ? "收起背景" : "展开背景"}
              </button>
            )}
          </div>
        )}
        <QuestionStep key={current} item={items[current]!} value={answers[current] ?? ""}
          disabled={unavailable} autoFocus={navigated}
          onChange={(value) => setAnswers((list) => list.map((answer, i) => i === current ? value : answer))}
          onCommit={commit} />
        {error && <p className="task-question-error" role="alert">{error}</p>}
        <footer>
          <span aria-live="polite">{hint}</span>
          {multi && (
            <button type="button" className="task-question-nav" disabled={unavailable || current === 0}
              onClick={() => go(current - 1)}>
              <CaretLeft size={12} weight="bold" aria-hidden="true" />上一题
            </button>
          )}
          {/* 没答到最后一题时「发送」退成次要样式：主按钮留给「下一题」，
              免得顺手一点就把只答了一题的答复发出去。 */}
          <button type="button" className={last ? "task-question-send" : "task-question-nav"}
            disabled={unavailable || !answered} onClick={() => void submit()}>
            {sent ? <Check size={13} aria-hidden="true" /> : <PaperPlaneTilt size={13} weight="fill" aria-hidden="true" />}
            {sending ? "发送中…" : sent ? "已发送" : "发送答复"}
          </button>
          {multi && !last && (
            <button type="button" className="task-question-send" disabled={unavailable} onClick={() => go(current + 1)}>
              下一题<CaretRight size={12} weight="bold" aria-hidden="true" />
            </button>
          )}
        </footer>
      </>}
    </section>
  );
}
