import { useEffect, useMemo } from "react";
import { View, Text, Pressable, ScrollView, Dimensions, BackHandler, StyleSheet } from "react-native";
import Animated, { useSharedValue, useAnimatedStyle, withTiming, runOnJS, Easing } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useStore } from "@/lib/store";
import { useTheme, radius } from "@/lib/theme";

// Feel knobs — width, left-edge hit-zone, snap threshold, fling velocity. Kept
// together so retuning the drawer's feel is a one-line change.
const PANEL_W = Math.min(296, Dimensions.get("window").width * 0.8);
const EDGE_W = 28; // left-edge zone (px) where a closed drawer starts dragging out
const SETTLE = 0.4; // progress past which we snap open (mirrored for close)
const FLING = 500; // |velocityX| (px/s) that snaps regardless of distance
const ANIM = { duration: 240, easing: Easing.out(Easing.cubic) };

const clamp = (v: number, lo: number, hi: number) => {
  "worklet";
  return Math.min(Math.max(v, lo), hi);
};

// Custom left drawer (reanimated + gesture-handler — no nav dependency, and no
// Modal so the panel can be finger-dragged in from the screen edge). Hosts the
// project list (tap to switch), new-project entry, settings, and live-connection
// status. Opened from the hamburger or by swiping in from the left edge; closed by
// dragging it back, tapping the scrim, or Android hardware back.
export function SideDrawer({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const projects = useStore((s) => s.projects);
  const projectId = useStore((s) => s.projectId);
  const setProjectId = useStore((s) => s.setProjectId);
  const online = useStore((s) => s.online);

  // 0 = fully closed, 1 = fully open. Drives the panel slide + scrim fade; written
  // directly by the gestures (finger-tracking) and by withTiming on tap open/close.
  const progress = useSharedValue(0);

  // Tap-open (hamburger) / tap-close (scrim, project pick) animate via the `open`
  // prop; the gestures settle themselves and only flip `open` to match.
  useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, ANIM);
  }, [open, progress]);

  // Android hardware back closes the drawer rather than leaving the screen
  // (replaces the old Modal onRequestClose).
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [open, setOpen]);

  const close = () => setOpen(false);

  // Swipe in from the left edge to pull the closed drawer out, finger-tracking.
  const edgeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!open)
        .activeOffsetX(8)
        .failOffsetY([-14, 14])
        .onUpdate((e) => {
          progress.value = clamp(e.translationX / PANEL_W, 0, 1);
        })
        .onEnd((e) => {
          const willOpen = progress.value > SETTLE || e.velocityX > FLING;
          progress.value = withTiming(willOpen ? 1 : 0, ANIM);
          if (willOpen) runOnJS(setOpen)(true);
        }),
    [open, progress, setOpen],
  );

  // Drag the open panel left to push it back, finger-tracking.
  const panelGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(open)
        .activeOffsetX([-8, 8])
        .failOffsetY([-14, 14])
        .onUpdate((e) => {
          progress.value = clamp(1 + e.translationX / PANEL_W, 0, 1);
        })
        .onEnd((e) => {
          const willClose = progress.value < 1 - SETTLE || e.velocityX < -FLING;
          progress.value = withTiming(willClose ? 0 : 1, ANIM);
          if (willClose) runOnJS(setOpen)(false);
        }),
    [open, progress, setOpen],
  );

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value * 0.5 }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (progress.value - 1) * PANEL_W }],
  }));

  // Close first, then navigate after the slide-out so the transition reads cleanly.
  const navAfterClose = (fn: () => void) => {
    close();
    setTimeout(fn, 220);
  };

  const pick = (id: string) => {
    setProjectId(id);
    close();
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Scrim — tap to close; transparent to touch while closed so the list stays live */}
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: "#000" }, scrimStyle]}
        pointerEvents={open ? "auto" : "none"}
      >
        <Pressable style={{ flex: 1 }} onPress={close} />
      </Animated.View>

      {/* Left-edge pull zone — only active while closed (panel + back-edge cover it when open) */}
      <GestureDetector gesture={edgeGesture}>
        <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: EDGE_W }} />
      </GestureDetector>

      {/* Panel — slides with `progress`; the whole panel is the drag-to-close surface */}
      <GestureDetector gesture={panelGesture}>
        <Animated.View
          style={[
            {
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: PANEL_W,
              backgroundColor: theme.panel,
              paddingTop: insets.top + 18,
            },
            panelStyle,
          ]}
        >
          <Text style={{ color: theme.faint, fontSize: 12, fontWeight: "600", paddingHorizontal: 20, paddingBottom: 8 }}>
            项目
          </Text>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12 }}>
            {projects.map((p) => {
              const active = p.id === projectId;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => pick(p.id)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 13,
                    borderRadius: radius.md,
                    backgroundColor: active ? theme.raised : pressed ? theme.raised : "transparent",
                  })}
                >
                  <Text
                    style={{
                      color: active ? theme.ink : theme.muted,
                      fontSize: 16,
                      fontWeight: active ? "600" : "500",
                      flex: 1,
                    }}
                  >
                    {p.name}
                  </Text>
                  {active ? <Ionicons name="checkmark" size={18} color={theme.accent} /> : null}
                </Pressable>
              );
            })}

            <Pressable
              onPress={() => navAfterClose(() => router.push("/project-new"))}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 12,
                paddingVertical: 13,
                borderRadius: radius.md,
                backgroundColor: pressed ? theme.raised : "transparent",
              })}
            >
              <Ionicons name="add" size={18} color={theme.accent} />
              <Text style={{ color: theme.accent, fontSize: 16, fontWeight: "600" }}>新建项目</Text>
            </Pressable>
          </ScrollView>

          {/* Footer: settings (left) + live-connection status (right), one row */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              borderTopWidth: 1,
              borderTopColor: theme.line,
              paddingHorizontal: 16,
              paddingTop: 10,
              paddingBottom: insets.bottom + 12,
            }}
          >
            <Pressable
              onPress={() => navAfterClose(() => router.push("/settings"))}
              hitSlop={8}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingVertical: 8,
                paddingHorizontal: 10,
                marginHorizontal: -10,
                borderRadius: radius.md,
                backgroundColor: pressed ? theme.raised : "transparent",
              })}
            >
              <Ionicons name="settings-outline" size={18} color={theme.muted} />
              <Text style={{ color: theme.ink, fontSize: 15, fontWeight: "500" }}>设置</Text>
            </Pressable>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: online ? theme.ok : theme.faint }} />
              <Text style={{ color: theme.faint, fontSize: 12 }}>{online ? "已连接" : "未连接"}</Text>
            </View>
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
