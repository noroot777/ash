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

// Header actions for the task list: live-connection dot, settings. (New-task now
// lives in the floating action button on the list itself.)
function ListHeaderRight() {
  const router = useRouter();
  const theme = useTheme();
  const connected = useStore((s) => s.connected);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
      <ConnDot connected={connected} />
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
        <Stack.Screen
          name="new"
          options={{
            title: "新建任务",
            presentation: "formSheet",
            sheetAllowedDetents: [0.85, 1],
            sheetGrabberVisible: true,
            sheetCornerRadius: 20,
          }}
        />
        <Stack.Screen
          name="project-new"
          options={{
            headerShown: false,
            presentation: "formSheet",
            sheetAllowedDetents: [0.45, 0.8],
            sheetGrabberVisible: true,
            sheetCornerRadius: 20,
            contentStyle: { backgroundColor: theme.panel },
          }}
        />
        <Stack.Screen name="task/[id]" options={{ title: "" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
