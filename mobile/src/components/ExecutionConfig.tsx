import { useMemo, useState, type ComponentProps } from "react";
import { ActivityIndicator, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { AgentExecutorProfile, AgentType, LlmProvider } from "@harness/shared";
import {
  CLI_MODEL_PRESETS,
  REASONING_EFFORT_DETAIL,
  REASONING_EFFORT_VALUES,
} from "@harness/shared";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/lib/api";
import { useTheme, radius, fonts } from "@/lib/theme";
import { Button, Input } from "@/components/ui";
import { SelectSheet, type SelectSheetOption } from "@/components/SelectSheet";

export type ExecutorSelection = {
  agentType: AgentType;
  executorId: string | null;
};

type PickerKind = "executor" | "model" | "effort";
const providerModelCache = new Map<string, string[]>();

export function ExecutionConfig({
  role,
  icon,
  selection,
  types,
  profiles,
  providers,
  model,
  reasoningEffort,
  onSelectionChange,
  onModelChange,
  onReasoningEffortChange,
  style,
}: {
  role: string;
  icon: ComponentProps<typeof Ionicons>["name"];
  selection: ExecutorSelection;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  model: string;
  reasoningEffort: string;
  onSelectionChange: (selection: ExecutorSelection) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: string) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [providerModels, setProviderModels] = useState<string[] | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState(model);
  const profile = profileForSelection(selection, profiles);
  const provider = profile?.providerId
    ? providers.find((item) => item.id === profile.providerId)
    : undefined;

  const modelValues = provider ? providerModels ?? [] : [...CLI_MODEL_PRESETS[selection.agentType]];
  if (model && !modelValues.includes(model)) modelValues.unshift(model);
  const modelOptions = followOptions(
    modelValues,
    modelDetail(selection, profile),
  );
  const effortOptions = followOptions(
    REASONING_EFFORT_VALUES[selection.agentType],
    effortDetail(selection, profile),
  );
  const executorItems = useMemo(
    () => executorOptions(types, profiles),
    [types, profiles],
  );

  const openModel = () => {
    setCustomModel(model);
    setPicker("model");
    setModelError(null);
    if (!provider) {
      setProviderModels(null);
      return;
    }
    const cached = providerModelCache.get(provider.id);
    if (cached) {
      setProviderModels(cached);
      return;
    }
    setProviderModels(null);
    api
      .probeModels({ protocol: provider.protocol, baseUrl: provider.baseUrl, id: provider.id })
      .then(({ models }) => {
        providerModelCache.set(provider.id, models);
        setProviderModels(models);
      })
      .catch((error) => setModelError(error instanceof Error ? error.message : String(error)));
  };

  const options = picker === "executor"
    ? executorItems
    : picker === "model"
      ? modelOptions
      : effortOptions;
  const value = picker === "executor"
    ? selectionValue(selection)
    : picker === "model"
      ? model
      : reasoningEffort;

  return (
    <View
      style={[
        {
          gap: 9,
          padding: 12,
          borderRadius: radius.lg,
          backgroundColor: theme.raised,
        },
        style,
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Ionicons name={icon} size={15} color={theme.accent} />
        <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>{role}</Text>
      </View>
      <ConfigTrigger
        label="执行器"
        value={selectionLabel(selection, profiles)}
        onPress={() => setPicker("executor")}
      />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <ConfigTrigger label="模型" value={model || "跟随执行器"} onPress={openModel} />
        <ConfigTrigger
          label="思考强度"
          value={reasoningEffort || "跟随执行器"}
          onPress={() => setPicker("effort")}
        />
      </View>

      {picker ? (
        <SelectSheet
          title={picker === "executor" ? `选择${role}` : picker === "model" ? `${role}模型` : `${role}思考强度`}
          options={options}
          value={value}
          onSelect={(next) => {
            if (picker === "executor") onSelectionChange(parseSelection(next, profiles, selection));
            else if (picker === "model") onModelChange(next);
            else onReasoningEffortChange(next);
          }}
          onClose={() => setPicker(null)}
          header={picker === "model" ? (
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Input
                  value={customModel}
                  onChangeText={setCustomModel}
                  placeholder="自定义模型全名"
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{ flex: 1, fontFamily: fonts.mono, fontSize: 13 }}
                  onSubmitEditing={() => {
                    onModelChange(customModel.trim());
                    setPicker(null);
                  }}
                />
                <Button
                  label="使用"
                  onPress={() => {
                    onModelChange(customModel.trim());
                    setPicker(null);
                  }}
                />
              </View>
              {provider ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  {!providerModels && !modelError ? <ActivityIndicator size="small" color={theme.faint} /> : null}
                  <Text style={{ flex: 1, color: modelError ? theme.danger : theme.faint, fontSize: 11 }}>
                    {modelError
                      ?? (providerModels
                        ? `供应商「${provider.name}」返回 ${providerModels.length} 个模型`
                        : `正在从「${provider.name}」拉取模型…`)}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : undefined}
        />
      ) : null}
    </View>
  );
}

function ConfigTrigger({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        gap: 3,
        paddingHorizontal: 11,
        paddingVertical: 9,
        borderRadius: radius.md,
        backgroundColor: pressed ? theme.overlay : theme.panel,
      })}
    >
      <Text style={{ color: theme.faint, fontSize: 10, fontFamily: fonts.mono }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Text style={{ flex: 1, color: theme.ink, fontSize: 12, fontFamily: fonts.bodySemi }} numberOfLines={1}>
          {value}
        </Text>
        <Ionicons name="chevron-down" size={12} color={theme.faint} />
      </View>
    </Pressable>
  );
}

function followOptions(values: readonly string[], detail: string): SelectSheetOption[] {
  return [
    { value: "", label: "跟随执行器", detail },
    ...values.map((value) => ({ value, label: value, detail: REASONING_EFFORT_DETAIL[value] })),
  ];
}

function profileForSelection(selection: ExecutorSelection, profiles: AgentExecutorProfile[]) {
  const selected = selection.executorId
    ? profiles.find((item) => item.id === selection.executorId)
    : undefined;
  return selected
    ?? profiles.find((item) => item.type === selection.agentType && item.isDefault);
}

function modelDetail(selection: ExecutorSelection, profile?: AgentExecutorProfile): string {
  const name = profile?.name ?? `默认 ${selection.agentType}`;
  return profile?.model ? `使用「${name}」的 ${profile.model}` : `使用「${name}」的默认模型`;
}

function effortDetail(selection: ExecutorSelection, profile?: AgentExecutorProfile): string {
  const name = profile?.name ?? `默认 ${selection.agentType}`;
  return profile?.reasoningEffort
    ? `使用「${name}」的 ${profile.reasoningEffort}`
    : `使用「${name}」的默认强度`;
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
    return [
      {
        value: `default:${type}`,
        label: `默认 ${type}`,
        detail: defaultProfile ? `当前使用 ${defaultProfile.name}` : "跟随该类型的默认执行器",
      },
      ...profiles
        .filter((profile) => profile.type === type)
        .map((profile) => ({
          value: profile.id,
          label: profile.name,
          detail: [profile.type, profile.model || "默认模型", profile.isDefault ? "类型默认" : null]
            .filter(Boolean)
            .join(" · "),
        })),
    ];
  });
}
