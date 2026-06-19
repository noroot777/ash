import { useState } from "react";
import { View, Text, TextInput, ScrollView, KeyboardAvoidingView, Platform } from "react-native";
import { useRouter } from "expo-router";
import { getBaseURL, setBaseURL } from "@/lib/config";
import { api } from "@/lib/api";
import { connectSSE } from "@/lib/sse";
import { refreshAll } from "@/lib/data";
import { useTheme, radius } from "@/lib/theme";
import { Button } from "@/components/ui";

type Status = { kind: "idle" | "testing" | "ok" | "fail"; msg?: string };

export default function Settings() {
  const router = useRouter();
  const theme = useTheme();
  const [url, setUrl] = useState(getBaseURL() ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const save = async () => {
    const v = url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(v)) {
      setStatus({ kind: "fail", msg: "地址需以 http:// 或 https:// 开头" });
      return;
    }
    setStatus({ kind: "testing" });
    try {
      await api.health(v); // probe before persisting
      await setBaseURL(v);
      connectSSE(() => {
        refreshAll().catch(() => {});
      });
      await refreshAll();
      setStatus({ kind: "ok", msg: "已连接" });
      if (router.canGoBack()) router.back();
      else router.replace("/");
    } catch (e) {
      setStatus({ kind: "fail", msg: `连接失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const statusColor =
    status.kind === "ok" ? theme.ok : status.kind === "fail" ? theme.danger : theme.muted;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 14 }}>
        <Text style={{ color: theme.muted, fontSize: 13, lineHeight: 19 }}>
          填写 harness 后端地址（经 Tailscale 访问 Mac）。例如 http://100.x.x.x:4317 或
          http://你的主机名:4317。
        </Text>

        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.faint, fontSize: 12 }}>后端地址</Text>
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="http://mac-ts:4317"
            placeholderTextColor={theme.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={{
              color: theme.ink,
              backgroundColor: theme.panel,
              borderWidth: 1,
              borderColor: theme.line,
              borderRadius: radius.md,
              paddingHorizontal: 12,
              paddingVertical: 11,
              fontSize: 15,
            }}
          />
        </View>

        <Button label={status.kind === "testing" ? "测试中…" : "测试并保存"} onPress={save} disabled={status.kind === "testing"} />

        {status.msg ? <Text style={{ color: statusColor, fontSize: 13 }}>{status.msg}</Text> : null}

        <Text style={{ color: theme.faint, fontSize: 12, lineHeight: 18, marginTop: 8 }}>
          安全提示：后端无鉴权，请仅经 Tailscale 内网访问，不要把端口暴露到公网。
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
