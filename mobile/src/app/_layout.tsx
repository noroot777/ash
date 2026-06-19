import { useEffect, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { loadBaseURL } from "@/lib/config";
import { connectSSE } from "@/lib/sse";
import { refreshAll } from "@/lib/data";
import { useStore } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import { ConnDot } from "@/components/ui";

// Header actions for the task list: live-connection dot, new-task, settings.
function ListHeaderRight() {
  const router = useRouter();
  const theme = useTheme();
  const connected = useStore((s) => s.connected);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
      <ConnDot connected={connected} />
      <Pressable onPress={() => router.push("/new")} hitSlop={10}>
        <Text style={{ color: theme.accent, fontSize: 26, fontWeight: "300", marginTop: -2 }}>＋</Text>
      </Pressable>
      <Pressable onPress={() => router.push("/settings")} hitSlop={10}>
        <Text style={{ color: theme.muted, fontSize: 18 }}>⚙︎</Text>
      </Pressable>
    </View>
  );
}

export default function RootLayout() {
  const theme = useTheme();
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    (async () => {
      const b = await loadBaseURL();
      if (b) {
        // Backfill on every (re)connect — we may have missed events while offline.
        connectSSE(() => {
          refreshAll().catch(() => {});
        });
        await refreshAll().catch(() => {});
      }
      setBooted(true);
    })();
  }, []);

  if (!booted) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <StatusBar style="auto" />
        <Text style={{ color: theme.faint, fontSize: 14 }}>Ash…</Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.panel },
          headerTitleStyle: { color: theme.ink },
          headerTintColor: theme.accent,
          contentStyle: { backgroundColor: theme.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: "任务", headerRight: () => <ListHeaderRight /> }} />
        <Stack.Screen name="settings" options={{ title: "设置" }} />
        <Stack.Screen name="new" options={{ title: "新建任务" }} />
        <Stack.Screen name="task/[id]" options={{ title: "" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
