import { useEffect, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { MAX_QUESTION_ITEMS, type TaskListItem } from "@ash/shared";
import { api } from "@/lib/api";
import { appendQuestionOption, formatQuestionAnswers } from "@/lib/question";
import { fonts, radius, useTheme } from "@/lib/theme";

const QUESTION = "#22D3EE";
const QUESTION_SOFT = "#22D3EE1A";
const QUESTION_BORDER = "#22D3EE66";

// ask_question answers remain one text payload. Multi-question UI only helps the
// user compose that payload without losing the correspondence between questions.
export function QuestionCard({ task }: { task: TaskListItem }) {
  const theme = useTheme();
  const items = task.questionItems ?? [];
  const isMulti = items.length > 0;
  const isLead = task.mode === "team";
  const settling = !isLead && (task.status === "running" || task.status === "queued");
  const [draft, setDraft] = useState("");
  const [itemDrafts, setItemDrafts] = useState<string[]>(() => items.map(() => ""));
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const questionKey = JSON.stringify({
    question: task.question,
    questionOptions: task.questionOptions,
    questionItems: task.questionItems,
  });

  useEffect(() => {
    setDraft("");
    setItemDrafts(items.map(() => ""));
    setSent(false);
  }, [questionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const answerText = isMulti
    ? formatQuestionAnswers(items, itemDrafts)
    : draft.trim();

  const send = async () => {
    // Multi-question answers may intentionally leave every item unanswered; the
    // explicit markers still communicate that choice. A single answer cannot be empty.
    if (sending || sent || settling || (!isMulti && !answerText)) return;
    setSending(true);
    try {
      await api.answer(task.id, answerText);
      // Do not mutate the task locally. The normal 5s task poll is authoritative
      // and removes this card once question is cleared by the server.
      setSent(true);
    } catch (error) {
      Alert.alert("答复失败", error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const disabled = settling || sending || sent;

  return (
    <View
      style={{
        overflow: "hidden",
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: QUESTION_BORDER,
        backgroundColor: theme.panel,
      }}
    >
      <View style={{ flexDirection: "row" }}>
        <View style={{ width: 4, backgroundColor: QUESTION }} />
        <View style={{ flex: 1, paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            <Ionicons name="help-circle-outline" size={17} color={QUESTION} />
            <Text style={{ flex: 1, color: QUESTION, fontSize: 12, fontFamily: fonts.bodySemi }}>
              {isLead ? "调度者在等你答复" : "任务提问，等待答复"}
            </Text>
            {isMulti ? (
              <Text style={{ color: theme.faint, fontSize: 10, fontFamily: fonts.mono }}>
                {items.length}/{MAX_QUESTION_ITEMS} 题
              </Text>
            ) : null}
          </View>

          <Text selectable style={{ color: theme.ink, fontSize: 14, lineHeight: 20, fontFamily: fonts.body }}>
            {task.question}
          </Text>

          {isMulti ? (
            <View style={{ gap: 12 }}>
              {items.map((item, index) => (
                <View
                  key={`${index}-${item.question}`}
                  style={{
                    gap: 8,
                    paddingTop: 10,
                    borderTopWidth: 1,
                    borderTopColor: theme.line,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                    <View
                      style={{
                        minWidth: 24,
                        height: 24,
                        paddingHorizontal: 5,
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: radius.sm,
                        backgroundColor: QUESTION_SOFT,
                      }}
                    >
                      <Text style={{ color: QUESTION, fontSize: 11, fontFamily: fonts.monoMed }}>{index + 1}</Text>
                    </View>
                    <Text style={{ flex: 1, color: theme.ink, fontSize: 14, lineHeight: 20, fontFamily: fonts.body }}>
                      {item.question}
                    </Text>
                  </View>
                  <AnswerEditor
                    value={itemDrafts[index] ?? ""}
                    options={item.options ?? []}
                    disabled={disabled}
                    placeholder={settling ? "提问回合还没结束，稍候再答…" : "选择建议或填写这一题（可留空）"}
                    accessibilityLabel={`问题 ${index + 1} 的答复`}
                    onChange={(next) =>
                      setItemDrafts((current) => {
                        const copy = [...current];
                        copy[index] = next;
                        return copy;
                      })
                    }
                  />
                </View>
              ))}
              <Text style={{ color: theme.faint, fontSize: 11, lineHeight: 16, fontFamily: fonts.body }}>
                可以部分答复；留空的问题会明确写为“(未答)”
              </Text>
            </View>
          ) : (
            <AnswerEditor
              value={draft}
              options={task.questionOptions ?? []}
              disabled={disabled}
              placeholder={
                settling
                  ? "提问回合还没结束，稍候再答…"
                  : (task.questionOptions?.length ?? 0) > 0
                    ? "选择建议，或写下自己的答复"
                    : "写下答复"
              }
              accessibilityLabel="问题答复"
              onChange={setDraft}
            />
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送答复"
            onPress={() => void send()}
            disabled={disabled || (!isMulti && !answerText)}
            style={{
              alignSelf: "flex-end",
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderRadius: radius.md,
              backgroundColor: QUESTION,
              opacity: disabled || (!isMulti && !answerText) ? 0.4 : 1,
            }}
          >
            <Ionicons name={sent ? "checkmark" : "send"} size={14} color="#06202A" />
            <Text style={{ color: "#06202A", fontSize: 13, fontFamily: fonts.bodySemi }}>
              {sent ? "已发送，等待刷新" : sending ? "发送中…" : "发送答复"}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function AnswerEditor({
  value,
  options,
  disabled,
  placeholder,
  accessibilityLabel,
  onChange,
}: {
  value: string;
  options: string[];
  disabled: boolean;
  placeholder: string;
  accessibilityLabel: string;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const optionsKey = JSON.stringify(options);

  useEffect(() => setSelectedOption(null), [optionsKey]);

  const chooseOption = (index: number, option: string) => {
    // Suggestions are editable shortcuts, never one-tap decisions. Preserve any
    // existing answer and append the exact option text on its own line.
    const next = appendQuestionOption(value, option);
    onChange(next);
    setSelectedOption(index);
  };

  return (
    <View style={{ gap: 8 }}>
      {options.length > 0 ? (
        <View style={{ gap: 6 }}>
          {options.map((option, index) => {
            const selected = selectedOption === index;
            return (
              <Pressable
                key={`${index}-${option}`}
                accessibilityRole="button"
                accessibilityState={{ disabled, selected }}
                accessibilityHint="填入答复输入框，不会立即发送"
                disabled={disabled}
                onPress={() => chooseOption(index, option)}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 8,
                  minHeight: 44,
                  paddingHorizontal: 10,
                  paddingVertical: 9,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: selected ? QUESTION : QUESTION_BORDER,
                  backgroundColor: selected ? QUESTION_SOFT : theme.raised,
                  opacity: disabled ? 0.45 : 1,
                }}
              >
                <Text style={{ color: QUESTION, fontSize: 11, lineHeight: 18, fontFamily: fonts.monoMed }}>
                  {index + 1}
                </Text>
                <Text style={{ flex: 1, color: theme.ink, fontSize: 13, lineHeight: 18, fontFamily: fonts.body }}>
                  {option}
                </Text>
                {selected ? <Ionicons name="create-outline" size={14} color={QUESTION} /> : null}
              </Pressable>
            );
          })}
          {!disabled ? (
            <Text style={{ color: theme.faint, fontSize: 10, lineHeight: 15, fontFamily: fonts.body }}>
              点选只会填入输入框，可继续修改或组合多条建议
            </Text>
          ) : null}
        </View>
      ) : null}

      <TextInput
        value={value}
        onChangeText={(next) => {
          onChange(next);
          if (selectedOption !== null && !next.includes(options[selectedOption] ?? "")) setSelectedOption(null);
        }}
        editable={!disabled}
        accessibilityLabel={accessibilityLabel}
        placeholder={placeholder}
        placeholderTextColor={theme.faint}
        multiline
        textAlignVertical="top"
        style={{
          minHeight: 72,
          maxHeight: 150,
          color: theme.ink,
          backgroundColor: theme.bg,
          borderWidth: 1,
          borderColor: theme.line2,
          borderRadius: radius.md,
          paddingHorizontal: 11,
          paddingVertical: 9,
          fontSize: 14,
          lineHeight: 20,
          fontFamily: fonts.body,
          opacity: disabled ? 0.55 : 1,
        }}
      />
    </View>
  );
}
