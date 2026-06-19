import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { loadBaseURL } from "@/lib/config";
import { connectSSE } from "@/lib/sse";
import { refreshAll } from "@/lib/data";
import { useTheme } from "@/lib/theme";

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
        {/* Task list owns its header (left-aligned big title) — hide the native one. */}
        <Stack.Screen name="index" options={{ headerShown: false }} />
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
