import { useState } from "react";
import { View, Text, Pressable, Switch } from "react-native";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { Ionicons } from "@expo/vector-icons";
import { SelectSheet, type SelectSheetOption } from "@/components/SelectSheet";
import { useTheme, radius, fonts } from "@/lib/theme";

export type ExecutorSelection = {
  agentType: AgentType;
  executorId: string | null;
};

type PickerKind = "lead" | "worker";

export function TeamTaskOptions({
  enabled,
  onEnabledChange,
  lead,
  worker,
  leadTypes,
  workerTypes,
  profiles,
  onLeadChange,
  onWorkerChange,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  lead: ExecutorSelection;
  worker: ExecutorSelection;
  leadTypes: AgentType[];
  workerTypes: AgentType[];
  profiles: AgentExecutorProfile[];
  onLeadChange: (selection: ExecutorSelection) => void;
  onWorkerChange: (selection: ExecutorSelection) => void;
}) {
  const theme = useTheme();
  const [picker, setPicker] = useState<PickerKind | null>(null);

  const selection = picker === "lead" ? lead : worker;
  const types = picker === "lead" ? leadTypes : workerTypes;
  const options = picker ? executorOptions(types, profiles) : [];

  const pick = (value: string) => {
    const next = parseSelection(value, profiles, selection);
    if (picker === "lead") onLeadChange(next);
    else onWorkerChange(next);
  };

  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 14,
          borderRadius: radius.lg,
          backgroundColor: enabled ? theme.raised : theme.panel,
          borderWidth: 1,
          borderColor: enabled ? theme.accent : theme.line,
        }}
      >
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: enabled ? theme.accent : theme.overlay,
          }}
        >
          <Ionicons name="people" size={18} color={enabled ? theme.accentFg : theme.muted} />
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: theme.ink, fontSize: 15, fontFamily: fonts.bodySemi }}>带一队</Text>
          <Text style={{ color: theme.faint, fontSize: 12, lineHeight: 17 }}>
            常驻调度者负责拆活、派执行者，你可以随时插话。
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={onEnabledChange}
          trackColor={{ false: theme.line2, true: theme.accent }}
          thumbColor={enabled ? theme.accentFg : theme.muted}
        />
      </View>

      {enabled ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <ExecutorTrigger
            icon="shield-checkmark-outline"
            label="调度者"
            value={selectionLabel(lead, profiles)}
            onPress={() => setPicker("lead")}
          />
          <ExecutorTrigger
            icon="construct-outline"
            label="执行者"
            value={selectionLabel(worker, profiles)}
            onPress={() => setPicker("worker")}
          />
        </View>
      ) : null}

      {picker ? (
        <SelectSheet
          title={picker === "lead" ? "选择调度者执行器" : "选择默认执行者"}
          options={options}
          value={selectionValue(selection)}
          onSelect={pick}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </View>
  );
}

function ExecutorTrigger({
  icon,
  label,
  value,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 11,
        borderRadius: radius.md,
        backgroundColor: pressed ? theme.overlay : theme.raised,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Ionicons name={icon} size={14} color={theme.accent} />
        <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>{label}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Text style={{ flex: 1, color: theme.ink, fontSize: 13, fontFamily: fonts.bodySemi }} numberOfLines={1}>
          {value}
        </Text>
        <Ionicons name="chevron-down" size={13} color={theme.faint} />
      </View>
    </Pressable>
  );
}

function selectionValue(selection: ExecutorSelection): string {
  return selection.executorId ?? `default:${selection.agentType}`;
}

function selectionLabel(selection: ExecutorSelection, profiles: AgentExecutorProfile[]): string {
  return profiles.find((profile) => profile.id === selection.executorId)?.name ?? `默认 ${selection.agentType}`;
}

function parseSelection(
  value: string,
  profiles: AgentExecutorProfile[],
  fallback: ExecutorSelection,
): ExecutorSelection {
  if (value.startsWith("default:")) {
    return { agentType: value.slice("default:".length) as AgentType, executorId: null };
  }
  const profile = profiles.find((item) => item.id === value);
  return profile ? { agentType: profile.type, executorId: profile.id } : fallback;
}

function executorOptions(types: AgentType[], profiles: AgentExecutorProfile[]): SelectSheetOption[] {
  return types.flatMap((type) => {
    const defaultProfile = profiles.find((profile) => profile.type === type && profile.isDefault);
    const typeOptions: SelectSheetOption[] = [
      {
        value: `default:${type}`,
        label: `默认 ${type}`,
        detail: defaultProfile ? `当前使用 ${defaultProfile.name}` : "跟随该类型的默认执行器",
      },
    ];
    return typeOptions.concat(
      profiles
        .filter((profile) => profile.type === type)
        .map((profile) => ({
          value: profile.id,
          label: profile.name,
          detail: [profile.type, profile.model || "默认模型", profile.isDefault ? "类型默认" : null]
            .filter(Boolean)
            .join(" · "),
        })),
    );
  });
}
