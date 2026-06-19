import { useEffect, useRef } from "react";
import { Animated, View, Text, Pressable, Modal, ScrollView, Dimensions } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useStore } from "@/lib/store";
import { useTheme, radius } from "@/lib/theme";

const PANEL_W = Math.min(320, Dimensions.get("window").width * 0.82);

// Custom left drawer (RN Modal + Animated — no extra nav dependency). Hosts the
// project list (tap to switch), new-project entry, settings, and live-connection
// status. Opened from the hamburger on the task list.
export function SideDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const projects = useStore((s) => s.projects);
  const projectId = useStore((s) => s.projectId);
  const setProjectId = useStore((s) => s.setProjectId);
  const connected = useStore((s) => s.connected);

  const tx = useRef(new Animated.Value(-PANEL_W)).current;
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(tx, { toValue: open ? 0 : -PANEL_W, duration: 220, useNativeDriver: true }),
      Animated.timing(fade, { toValue: open ? 1 : 0, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [open, tx, fade]);

  // Close first, then navigate after the slide-out so the transition reads cleanly.
  const navAfterClose = (fn: () => void) => {
    onClose();
    setTimeout(fn, 200);
  };

  const pick = (id: string) => {
    setProjectId(id);
    onClose();
  };

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", opacity: fade }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>

      <Animated.View
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: PANEL_W,
          backgroundColor: theme.panel,
          transform: [{ translateX: tx }],
          paddingTop: insets.top + 18,
        }}
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

        {/* Footer: settings + live-connection status */}
        <View style={{ borderTopWidth: 1, borderTopColor: theme.line, paddingHorizontal: 12, paddingTop: 8, paddingBottom: insets.bottom + 12, gap: 2 }}>
          <Pressable
            onPress={() => navAfterClose(() => router.push("/settings"))}
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
            <Ionicons name="settings-outline" size={18} color={theme.muted} />
            <Text style={{ color: theme.ink, fontSize: 16, fontWeight: "500" }}>设置</Text>
          </Pressable>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingTop: 8 }}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: connected ? theme.ok : theme.faint,
              }}
            />
            <Text style={{ color: theme.faint, fontSize: 13 }}>{connected ? "实时已连接" : "未连接"}</Text>
          </View>
        </View>
      </Animated.View>
    </Modal>
  );
}
