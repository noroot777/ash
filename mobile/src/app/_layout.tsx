import { useEffect, useState } from "react";
import { AppState, View, Text } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts, SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from "@expo-google-fonts/space-grotesk";
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from "@expo-google-fonts/inter";
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from "@expo-google-fonts/ibm-plex-mono";
import { loadBaseURL } from "@/lib/config";
import { connectSSE } from "@/lib/sse";
import { refreshAll } from "@/lib/data";
import { useTheme, fonts } from "@/lib/theme";

export default function RootLayout() {
  const theme = useTheme();
  const [booted, setBooted] = useState(false);
  const [fontsLoaded] = useFonts({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
  });

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

  // The OS suspends the SSE socket while the app is backgrounded; on return to the
  // foreground we may hold a dead-but-undetected stream. Force a reconnect — which
  // bumps streamEpoch (→ screens reconcile from .md) and runs the onOpen backfill.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") connectSSE(() => { refreshAll().catch(() => {}); });
    });
    return () => sub.remove();
  }, []);

  if (!booted || !fontsLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <StatusBar style="auto" />
        <Text style={{ color: theme.faint, fontSize: 14, fontFamily: fontsLoaded ? fonts.mono : undefined }}>
          Ash…
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.panel },
          headerTitleStyle: { color: theme.ink, fontFamily: fonts.displayMd },
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
