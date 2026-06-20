import { useEffect, useState } from "react";
import { AppState, View, Text } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts, SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from "@expo-google-fonts/space-grotesk";
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from "@expo-google-fonts/inter";
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from "@expo-google-fonts/ibm-plex-mono";
import { loadBaseURL, getBaseURL } from "@/lib/config";
import { refreshAll } from "@/lib/data";
import { useTheme, fonts } from "@/lib/theme";
import { GestureHandlerRootView } from "react-native-gesture-handler";

// How often the foregrounded app re-pulls the task list + statuses.
const LIST_POLL_MS = 5000;

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
      await loadBaseURL();
      setBooted(true);
    })();
  }, []);

  // List/status polling — no live connection. While the app is foregrounded we
  // re-pull projects + tasks every few seconds so the list and statuses stay
  // fresh; paused in the background, resumed with an immediate pull on return.
  // (Per-task conversation has its own poll in app/task/[id].tsx.)
  useEffect(() => {
    if (!booted) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => { if (getBaseURL()) refreshAll().catch(() => {}); };
    const start = () => {
      if (timer) return;
      tick();
      timer = setInterval(tick, LIST_POLL_MS);
    };
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    start();
    const sub = AppState.addEventListener("change", (s) => (s === "active" ? start() : stop()));
    return () => {
      stop();
      sub.remove();
    };
  }, [booted]);

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
    <GestureHandlerRootView style={{ flex: 1 }}>
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
    </GestureHandlerRootView>
  );
}
