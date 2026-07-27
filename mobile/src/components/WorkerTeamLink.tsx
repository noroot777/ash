import { View, Text, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, radius, fonts } from "@/lib/theme";

export function WorkerTeamLink({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: radius.md,
        backgroundColor: pressed ? theme.overlay : theme.raised,
      })}
    >
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.panel,
        }}
      >
        <Ionicons name="people" size={14} color={theme.accent} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: theme.faint, fontSize: 10, fontFamily: fonts.monoMed, letterSpacing: 0.6 }}>
          所属团队
        </Text>
        <Text style={{ color: theme.ink, fontSize: 12, fontFamily: fonts.bodySemi }} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <Ionicons name="arrow-forward" size={14} color={theme.faint} />
    </Pressable>
  );
}
