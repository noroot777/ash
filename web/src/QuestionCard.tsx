import { useEffect, useRef, useState } from "react";
import type { Task } from "@harness/shared";
import { MAX_QUESTION_ITEMS } from "@harness/shared";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import { api } from "./api";
import { StatusIcon } from "./StatusIcon";
import { toast } from "./toast";
import { Kbd, submitShortcutLabel, submitShortcutTitle } from "./ui";

// ask_question 的答复卡片由单任务与 /team 调度台共用。多问题只改变网页如何组织
// 输入：提交时仍合成一段无歧义文本走原来的 /answer，不新增结构化答复协议。
export function QuestionCard({ task }: { task: Task }) {
  const shortcut = submitShortcutLabel();
  const items = task.questionItems ?? [];
  const isMulti = items.length > 0;
  const isLead = task.mode === "team";
  const settling = !isLead && (task.status === "running" || task.status === "queued");
  const [draft, setDraft] = useState("");
  const [itemDrafts, setItemDrafts] = useState<string[]>(() => items.map(() => ""));
  const [sending, setSending] = useState(false);
  const questionKey = JSON.stringify({
    question: task.question,
    questionOptions: task.questionOptions,
    questionItems: task.questionItems,
  });

  useEffect(() => {
    setDraft("");
    setItemDrafts(items.map(() => ""));
  }, [questionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const answerText = isMulti
    ? items
        .map((item, i) => `【${i + 1}】${item.question}\n答：${itemDrafts[i]?.trim() || "(未答)"}`)
        .join("\n\n")
    : draft.trim();

  const send = async () => {
    // 多问题允许部分答复，连一题都没答时也明确提交每题“(未答)”；单问题仍要求非空。
    if (sending || settling || (!isMulti && !answerText)) return;
    setSending(true);
    try {
      await api.answerTask(task.id, answerText);
      toast(isLead ? "已答复，调度者收到了" : "已答复，任务正在带着答案续跑");
      setDraft("");
      setItemDrafts(items.map(() => ""));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-cyan-500/40 bg-cyan-500/[0.06]">
      <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-cyan-700">
        <StatusIcon status="paused" size={11} awaitingAnswer />
        <span>{isLead ? "调度者在问你话，等待答复" : "任务提问，等待答复（队列陪等，不会自动续跑）"}</span>
        {isMulti && (
          <span className="ml-auto text-[10px] font-normal text-cyan-800/70">
            {items.length}/{MAX_QUESTION_ITEMS} 个问题
          </span>
        )}
      </div>

      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words px-2.5 pb-1 text-[12px] leading-snug text-ink">
        {task.question}
      </pre>

      {isMulti ? (
        <div className="border-t border-cyan-500/20">
          {items.map((item, i) => (
            <section key={`${i}-${item.question}`} className="border-b border-cyan-500/20 px-2.5 py-2 last:border-b-0">
              <div className="mb-1.5 flex items-start gap-2 text-[12px] leading-snug text-ink">
                <span className="shrink-0 rounded bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-cyan-800">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{item.question}</span>
              </div>
              <AnswerEditor
                value={itemDrafts[i] ?? ""}
                options={item.options ?? []}
                disabled={settling || sending}
                placeholder={settling ? "提问回合还没结束，稍候片刻再答…" : "选择建议或写下这一题的答复（可留空）"}
                ariaLabel={`问题 ${i + 1} 的答复`}
                onChange={(next) =>
                  setItemDrafts((current) => {
                    const copy = [...current];
                    copy[i] = next;
                    return copy;
                  })
                }
                onSubmit={() => void send()}
              />
            </section>
          ))}
          <div className="flex items-center justify-between gap-3 border-t border-cyan-500/20 px-2.5 py-1.5">
            <span className="text-[10px] font-medium text-cyan-800/80">可以部分答复；留空的问题会明确写为“(未答)”</span>
            <SendButton
              busy={sending}
              disabled={settling || sending}
              title="把各题答案编号合并后发送"
              onClick={() => void send()}
            />
          </div>
        </div>
      ) : (
        <div className="border-t border-cyan-500/20 px-2 py-1.5">
          <AnswerEditor
            value={draft}
            options={task.questionOptions ?? []}
            disabled={settling || sending}
            placeholder={
              settling
                ? "提问回合还没结束，稍候片刻再答…"
                : (task.questionOptions?.length ?? 0) > 0
                  ? `选择上方建议，或自己写答复（${shortcut} 发送）`
                  : isLead
                    ? `写下答复，发送后直接进同一个常驻会话（${shortcut} 发送）`
                    : `写下答复，发送后会直接唤醒 agent 带着答案继续（${shortcut} 发送）`
            }
            ariaLabel="问题答复"
            onChange={setDraft}
            onSubmit={() => void send()}
          />
          <div className="mt-1.5 flex justify-end">
            <SendButton
              busy={sending}
              disabled={settling || sending || !draft.trim()}
              title="发送输入框中的答复"
              onClick={() => void send()}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function AnswerEditor({
  value,
  options,
  disabled,
  placeholder,
  ariaLabel,
  onChange,
  onSubmit,
}: {
  value: string;
  options: string[];
  disabled: boolean;
  placeholder: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const optionsKey = JSON.stringify(options);

  useEffect(() => setSelectedOption(null), [optionsKey]);

  const chooseOption = (index: number, option: string) => {
    // 候选是建议答案，不是单选：空输入直接填入，已有任何内容就换行追加。
    const next = value.trim() ? `${value.trimEnd()}\n${option}` : option;
    onChange(next);
    setSelectedOption(index);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.length, next.length);
    });
  };

  return (
    <div>
      {options.length > 0 && (
        <div className="mb-1.5 flex flex-col gap-1">
          {options.map((option, i) => {
            const selected = selectedOption === i;
            return (
              <button
                key={`${i}-${option}`}
                type="button"
                onClick={() => chooseOption(i, option)}
                disabled={disabled}
                aria-pressed={selected}
                title="填入输入框；已有内容时换行追加，不会立即发送"
                className={`flex w-full items-start gap-1.5 rounded-md border px-2 py-1 text-left text-[12px] leading-snug text-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  selected
                    ? "border-cyan-600 bg-cyan-500/20 ring-1 ring-cyan-500/25"
                    : "border-cyan-500/30 bg-cyan-500/[0.07] hover:border-cyan-500/60 hover:bg-cyan-500/15"
                }`}
              >
                <span className={`mt-px shrink-0 font-mono text-[10px] ${selected ? "font-semibold text-cyan-800" : "text-cyan-700"}`}>
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{option}</span>
                {selected && <span className="shrink-0 text-[10px] font-medium text-cyan-800">已填入</span>}
              </button>
            );
          })}
          {!disabled && <span className="text-[10px] font-medium text-cyan-800/80">选择只会填入输入框，可继续修改或组合多条建议</span>}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next);
          if (selectedOption !== null && !next.includes(options[selectedOption])) setSelectedOption(null);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
        rows={2}
        placeholder={placeholder}
        disabled={disabled}
        className="block w-full resize-y rounded-md border border-cyan-500/20 bg-transparent px-1.5 py-1 text-[12px] leading-snug text-ink outline-none placeholder:text-faint focus:border-cyan-500/50 disabled:opacity-50"
      />
    </div>
  );
}

function SendButton({
  busy,
  disabled,
  title,
  onClick,
}: {
  busy: boolean;
  disabled: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={submitShortcutTitle(title)}
      className="flex shrink-0 items-center gap-1 rounded-md border border-cyan-500 bg-cyan-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-cyan-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <PaperPlaneTilt size={13} weight="fill" />
      {busy ? "发送中…" : "发送答复"} <Kbd className="border-white/20 bg-white/10" />
    </button>
  );
}
