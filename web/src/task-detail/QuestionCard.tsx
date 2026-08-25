import { useEffect, useRef, useState } from "react";
import type { QuestionItem, TaskListItem } from "@ash/shared";
import { PaperPlaneTilt, Question } from "@phosphor-icons/react";

function AnswerEditor({
  value,
  item,
  disabled,
  onChange,
  onSubmit,
}: {
  value: string;
  item: QuestionItem;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const choose = (option: string) => {
    const next = value.trim() ? `${value.trimEnd()}\n${option}` : option;
    onChange(next);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.length, next.length);
    });
  };
  return (
    <div className="task-question-answer">
      {!!item.options?.length && (
        <div className="task-question-options">
          {item.options.map((option, index) => (
            <button type="button" key={`${index}:${option}`} disabled={disabled} onClick={() => choose(option)}>
              <span>{index + 1}</span>
              <p>{option}</p>
            </button>
          ))}
          <small>候选只会填入输入框，可继续修改或组合多条。</small>
        </div>
      )}
      <textarea
        ref={input}
        value={value}
        rows={2}
        disabled={disabled}
        placeholder="写下答复…"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}

export function QuestionCard({
  task,
  onAnswer,
}: {
  task: TaskListItem;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const multi = task.questionItems ?? [];
  const items: QuestionItem[] = multi.length
    ? multi
    : [{ question: task.question ?? "", options: task.questionOptions ?? undefined }];
  const [answers, setAnswers] = useState(() => items.map(() => ""));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const questionKey = JSON.stringify([task.question, task.questionOptions, task.questionItems]);

  useEffect(() => {
    setAnswers(items.map(() => ""));
    setError(null);
  }, [questionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const text = multi.length
    ? items.map((item, index) => `【${index + 1}】${item.question}\n答：${answers[index]?.trim() || "(未答)"}`).join("\n\n")
    : answers[0]?.trim() ?? "";
  const settling = task.mode !== "team" && (task.status === "running" || task.status === "queued");

  const submit = async () => {
    if (sending || settling || (!multi.length && !text)) return;
    setSending(true);
    setError(null);
    try {
      await onAnswer(text);
      setAnswers(items.map(() => ""));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="task-question-card" aria-label="等待答复的问题">
      <header>
        <span><Question size={14} weight="fill" aria-hidden="true" /></span>
        <div>
          <b>{task.mode === "team" ? "调度者在等你的答复" : "任务提问，队列会在这里等待"}</b>
          {task.question && <p>{task.question}</p>}
        </div>
      </header>
      <div className="task-question-items">
        {items.map((item, index) => (
          <section key={`${index}:${item.question}`}>
            {multi.length > 0 && (
              <div className="task-question-title"><span>{index + 1}</span><p>{item.question}</p></div>
            )}
            <AnswerEditor
              value={answers[index] ?? ""}
              item={item}
              disabled={settling || sending}
              onChange={(value) => setAnswers((current) => current.map((answer, answerIndex) => answerIndex === index ? value : answer))}
              onSubmit={() => void submit()}
            />
          </section>
        ))}
      </div>
      <footer>
        {error ? <span className="is-error">{error}</span> : <span>{multi.length ? "可部分答复，留空项会标记为未答" : "⌘↵ 发送并续跑"}</span>}
        <button type="button" disabled={sending || settling || (!multi.length && !text)} onClick={() => void submit()}>
          <PaperPlaneTilt size={13} weight="fill" aria-hidden="true" />
          {sending ? "发送中…" : "发送答复"}
        </button>
      </footer>
    </section>
  );
}
