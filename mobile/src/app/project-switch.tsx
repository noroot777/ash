import { View, Text, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useStore } from "@/lib/store";
import { useTheme, radius } from "@/lib/theme";

// Project switcher — opened from the hamburger on the task list. Lists projects,
// tap one to select and dismiss; "+ 新建项目" jumps to the create-project sheet.
export default function ProjectSwitch() {
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const projects = useStore((s) => s.projects);
  const projectId = useStore((s) => s.projectId);
  const setProjectId = useStore((s) => s.setProjectId);

  const pick = (id: string) => {
    setProjectId(id);
    router.back();
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.panel }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 18, paddingBottom: 8 }}>
        <Text style={{ color: theme.ink, fontSize: 20, fontWeight: "700", flex: 1 }}>切换项目</Text>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={{ color: theme.muted, fontSize: 22 }}>✕</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: insets.bottom + 12 }}>
        {projects.map((p) => {
          const active = p.id === projectId;
          return (
            <Pressable
              key={p.id}
              onPress={() => pick(p.id)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingHorizontal: 12,
                paddingVertical: 14,
                borderRadius: radius.md,
                backgroundColor: pressed ? theme.raised : "transparent",
              })}
            >
              <Text style={{ color: active ? theme.accent : theme.ink, fontSize: 16, fontWeight: active ? "600" : "500", flex: 1 }}>
                {p.name}
              </Text>
              {active ? <Ionicons name="checkmark" size={20} color={theme.accent} /> : null}
            </Pressable>
          );
        })}

        <Pressable
          onPress={() => router.replace("/project-new")}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingHorizontal: 12,
            paddingVertical: 14,
            marginTop: 4,
            borderRadius: radius.md,
            backgroundColor: pressed ? theme.raised : "transparent",
          })}
        >
          <Ionicons name="add" size={20} color={theme.accent} />
          <Text style={{ color: theme.accent, fontSize: 16, fontWeight: "600" }}>新建项目</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
