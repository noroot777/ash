import { useEffect, useState } from "react";
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
//
// 多人模式下普通成员的路径是被服务端钳死的（`rootDir/<我的目录名>` 之内，见
// server/src/auth/path-scope.ts），所以那一档把前缀画成改不动的一截、只让人填后面的
// 目录名，并默认跟着项目名走 —— 手机上打一条长路径本来就难，打完再吃一个 403 更难。
// 实例管理员不锁：服务端不钳他，而这一屏没有「换成别的路径」的地方，锁了就没退路。
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

  // 锁前缀的那个目录；null = 不锁（自用模式、或者我是实例管理员）。
  const [home, setHome] = useState<string | null>(null);
  const [tail, setTail] = useState("");
  const [tailTouched, setTailTouched] = useState(false);
  useEffect(() => {
    let alive = true;
    api.me()
      .then((state) => {
        if (!alive) return;
        if (state.mode === "multi" && state.homeDir && state.user?.role !== "admin") setHome(state.homeDir);
      })
      // 问不出身份就按老样子给一个自由输入框：服务端仍会拦，界面不该因为一次网络失败
      // 就把人锁在一个填不出路径的框里。
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // 分隔符从家目录自己的形状认（Windows 的 `D:\ash-root\me`）——手机端没有 /host 那条
  // 端点，而这一段是服务端给的绝对路径，它长什么样就跟着什么样。
  const sep = home?.includes("\\") ? "\\" : "/";
  const prefix = home ? `${home.replace(/[\\/]+$/, "")}${sep}` : "";
  const path = home ? (tail.trim() ? `${prefix}${tail.trim()}` : "") : repoPath.trim();

  const applyName = (value: string) => {
    setName(value);
    if (home && !tailTouched) setTail(value.replace(/[\\/:*?"<>|]+/g, "-").trim());
  };

  const submit = async () => {
    if (!name.trim()) {
      setError("请填写项目名");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createProject({ name: name.trim(), repoPath: path || undefined });
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
          <Input value={name} onChangeText={applyName} placeholder="例如 Frontend" autoFocus />
        </View>

        {home ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: theme.faint, fontSize: 12 }}>仓库目录（放在你自己的目录里）</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text
                numberOfLines={1}
                ellipsizeMode="head"
                style={{ color: theme.muted, fontSize: 13, maxWidth: "45%" }}
              >
                {prefix}
              </Text>
              <Input
                value={tail}
                onChangeText={(value) => { setTail(value.replace(/^[\\/]+/, "")); setTailTouched(true); }}
                placeholder="目录名，默认跟项目名一样"
                autoCapitalize="none"
                autoCorrect={false}
                style={{ flex: 1 }}
              />
            </View>
            {/* 前缀会被压成省略号，完整那条给一行 —— 手机上尤其看不出自己到底建在哪。 */}
            <Text style={{ color: theme.faint, fontSize: 12 }}>
              {path ? `创建在 ${path}` : "留空就先不设目录，之后再补"}
            </Text>
          </View>
        ) : (
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
        )}

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
