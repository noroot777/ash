import { useState, type ReactNode } from "react";
import { View, Text, TextInput, ScrollView, KeyboardAvoidingView, Platform } from "react-native";
import { useRouter } from "expo-router";
import { AGENT_TYPES, type AgentType, type Priority } from "@harness/shared";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { PRIORITIES } from "@/lib/constants";
import { useTheme, radius } from "@/lib/theme";
import { Pill, Button } from "@/components/ui";

const firstLine = (s: string) =>
  s.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 40) ?? "";

export default function NewTask() {
  const router = useRouter();
  const theme = useTheme();
  const projects = useStore((s) => s.projects);
  const storeProjectId = useStore((s) => s.projectId);
  const upsertTask = useStore((s) => s.upsertTask);
  const clearLogs = useStore((s) => s.clearLogs);

  const [projectId, setProjectId] = useState<string | null>(storeProjectId);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [agent, setAgent] = useState<AgentType>("claude");
  const [priority, setPriority] = useState<Priority>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputStyle = {
    color: theme.ink,
    backgroundColor: theme.panel,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
  } as const;

  const submit = async (run: boolean) => {
    if (!projectId) {
      setError("请选择项目");
      return;
    }
    if (!title.trim() && !body.trim()) {
      setError("请填写标题或正文");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const explicit = title.trim();
      const t = await api.createTask({
        projectId,
        title: explicit || firstLine(body) || "新任务",
        body: body.trim(),
        mode: "single",
        agentType: agent,
        priority,
        autoTitle: !explicit, // let the first run name it when no title given
      });
      upsertTask(t);
      if (run) {
        clearLogs(t.id);
        await api.runTask(t.id).catch(() => {});
      }
      router.replace(`/task/${t.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.bg }}
        contentContainerStyle={{ padding: 16, gap: 18 }}
        keyboardShouldPersistTaps="handled"
      >
        <Field label="项目">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {projects.map((p) => (
              <Pill key={p.id} label={p.name} active={p.id === projectId} onPress={() => setProjectId(p.id)} />
            ))}
          </View>
        </Field>

        <Field label="标题（留空则自动命名）">
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="任务标题"
            placeholderTextColor={theme.faint}
            style={inputStyle}
          />
        </Field>

        <Field label="正文 / 指令">
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder="要这个 agent 做什么…"
            placeholderTextColor={theme.faint}
            multiline
            style={[inputStyle, { minHeight: 120, textAlignVertical: "top" }]}
          />
        </Field>

        <Field label="执行 agent">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {AGENT_TYPES.map((a) => (
              <Pill key={a} label={`@${a}`} active={a === agent} onPress={() => setAgent(a)} />
            ))}
          </View>
        </Field>

        <Field label="优先级">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {PRIORITIES.map((p) => (
              <Pill
                key={p.key}
                label={p.label}
                color={p.bars > 0 ? p.color : undefined}
                active={p.key === priority}
                onPress={() => setPriority(p.key)}
              />
            ))}
          </View>
        </Field>

        {error ? <Text style={{ color: theme.danger, fontSize: 13 }}>{error}</Text> : null}

        <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
          <Button label="创建" variant="secondary" onPress={() => submit(false)} disabled={busy} style={{ flex: 1 }} />
          <Button label={busy ? "提交中…" : "创建并运行"} onPress={() => submit(true)} disabled={busy} style={{ flex: 1 }} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.faint, fontSize: 12 }}>{label}</Text>
      {children}
    </View>
  );
}

