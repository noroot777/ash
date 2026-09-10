import { useId, useRef, useState } from "react";
import type { QuestionItem, TaskListItem } from "@ash/shared";
import { Check, PaperPlaneTilt, Question } from "@phosphor-icons/react";
import {
  formatQuestionAnswers, questionItems, questionKey, questionOptionSelected, toggleQuestionOption,
  type QuestionAnswerInput,
} from "@ash/shared/questions";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";
import { MarkdownBody } from "../components/MarkdownBody.tsx";

function AnswerEditor({ value, item, disabled, onChange, onSubmit }: {
  value: string;
  item: QuestionItem;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  useAutoGrowTextarea(input, { value });
  return (
    <div className="task-question-answer">
      {!!item.options?.length && (
        <div className="task-question-options" role="group" aria-label={`${item.question}的建议答案`}>
          {item.options.map((option, index) => {
            const selected = questionOptionSelected(value, option);
            return (
              <button type="button" key={`${index}:${option}`} disabled={disabled} aria-pressed={selected}
                onClick={() => onChange(toggleQuestionOption(value, option))}>
                <span className="task-question-option-mark" aria-hidden="true">{selected && <Check size={12} weight="bold" />}</span>
                <span>{option}</span>
              </button>
            );
          })}
          <small id={hintId}>可多选，也可编辑下方答案</small>
        </div>
      )}
      <textarea ref={input} value={value} rows={2} disabled={disabled}
        aria-label={`答复：${item.question}`} aria-describedby={item.options?.length ? hintId : undefined}
        placeholder={item.options?.length ? "补充或修改你的答案…" : "写下你的答案…"}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmit();
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
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const answered = answers.filter((answer) => answer.trim()).length;
  const settling = task.mode !== "team" && (task.status === "running" || task.status === "queued");
  const unavailable = settling || sending || sent;
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

  return (
    <section className="task-question-card" aria-label="等待答复的问题" aria-busy={sending}>
      <header className="task-question-heading">
        <span className="task-question-icon"><Question size={18} weight="duotone" aria-hidden="true" /></span>
        <b>需要你的答复</b>
        <span className="task-question-status">{sent ? "已发送" : settling ? "正在结束提问…" : "待答复"}</span>
      </header>
      {multi && task.question && <div className="task-question-context"><MarkdownBody text={task.question} /></div>}
      <div className="task-question-items">
        {items.map((item, index) => (
          <section key={index}>
            <div className="task-question-title">
              {multi && <span>{index + 1}</span>}
              <MarkdownBody text={item.question} />
            </div>
            <AnswerEditor value={answers[index] ?? ""} item={item} disabled={unavailable}
              onChange={(value) => setAnswers((current) => current.map((answer, i) => i === index ? value : answer))}
              onSubmit={() => void submit()} />
          </section>
        ))}
      </div>
      {error && <p className="task-question-error" role="alert">{error}</p>}
      <footer>
        <span aria-live="polite">{sent ? "答复已发送" : settling ? "提问结束后即可答复" : multi
          ? `已答 ${answered}/${items.length} 项 · 留空项会标记为未答`
          : "⌘ / Ctrl + Enter 发送"}</span>
        <button type="button" disabled={unavailable || !answered} onClick={() => void submit()}>
          {sent ? <Check size={14} aria-hidden="true" /> : <PaperPlaneTilt size={14} weight="fill" aria-hidden="true" />}
          {sending ? "发送中…" : sent ? "已发送" : "发送答复"}
        </button>
      </footer>
    </section>
  );
}
