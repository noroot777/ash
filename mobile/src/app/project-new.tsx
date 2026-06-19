import { useState } from "react";
import { View, Text, KeyboardAvoidingView, Platform, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import { Button, Input } from "@/components/ui";

// Bottom-sheet form to create a project (name + optional repo path). Opened from
// the `+` chip at the end of the project bar on the task list. On success we push
// the new project into the store and select it, then dismiss.
export default function NewProject() {
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const projects = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);
  const setProjectId = useStore((s) => s.setProjectId);

  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError("请填写项目名");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createProject({ name: name.trim(), repoPath: repoPath.trim() || undefined });
      setProjects([...projects, created]);
      setProjectId(created.id);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.panel }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 18, gap: 18 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={{ color: theme.ink, fontSize: 20, fontWeight: "700", flex: 1 }}>新建项目</Text>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Text style={{ color: theme.muted, fontSize: 22 }}>✕</Text>
          </Pressable>
        </View>

        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.faint, fontSize: 12 }}>项目名</Text>
          <Input value={name} onChangeText={setName} placeholder="例如 Frontend" autoFocus />
        </View>

        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.faint, fontSize: 12 }}>仓库路径（可留空，之后在桌面端补）</Text>
          <Input
            value={repoPath}
            onChangeText={setRepoPath}
            placeholder="~/code/foo"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {error ? <Text style={{ color: theme.danger, fontSize: 13 }}>{error}</Text> : null}

        <Button
          label={busy ? "创建中…" : "创建"}
          onPress={submit}
          disabled={busy}
          style={{ marginTop: 4, marginBottom: insets.bottom + 8 }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
