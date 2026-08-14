import { useMemo, useState, type ComponentProps } from "react";
import { ActivityIndicator, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { AgentExecutorProfile, AgentType, LlmProvider } from "@harness/shared";
import {
  CLI_MODEL_PRESETS,
  REASONING_EFFORT_DETAIL,
  isReasoningEffortSupported,
  reasoningEffortsFor,
} from "@harness/shared/cli-presets";
import { sameExecutor } from "@harness/shared/executors";
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
// CLI 官方账号那一档的候选:server 现问 CLI 的结果(`grok models` 之类)。整个 app
// 共一份,打开哪个任务都不用重探。拿不到就退回 CLI_MODEL_PRESETS 那份内置快照 ——
// 快照是发版时抄的,新模型上线后会滞后,所以只当兜底,不当第一来源。
const cliModelCache = new Map<AgentType, string[]>();

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
  // 连类型一起记:换了智能体但还没打开选择器时,不能把上一个 CLI 的清单继续显示。
  const [cliModels, setCliModels] = useState<{ type: AgentType; models: string[] } | null>(
    () => {
      const cached = cliModelCache.get(selection.agentType);
      return cached ? { type: selection.agentType, models: cached } : null;
    },
  );
  const [modelError, setModelError] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState(model);
  const profile = profileForSelection(selection, profiles);
  const provider = profile?.providerId
    ? providers.find((item) => item.id === profile.providerId)
    : undefined;

  // 挂了供应商就用它的实时目录;没挂就是 CLI 官方账号那一档 —— 优先用 server 现问
  // CLI 的结果,还没拿到(首帧/离线)才退回内置快照,免得下拉框先空一下。
  const cliCandidates = cliModels?.type === selection.agentType
    ? cliModels.models
    : cliModelCache.get(selection.agentType);
  const modelValues = provider
    ? providerModels ?? []
    : cliCandidates ?? [...CLI_MODEL_PRESETS[selection.agentType]];
  // 手填的模型补一条,但**必须新建数组**:cliCandidates / providerModels 是进程级
  // 共享缓存里的那一份,就地 unshift 会把这个任务的自定义模型渗进后面每一个选择器。
  const modelChoices = model && !modelValues.includes(model) ? [model, ...modelValues] : modelValues;
  const modelOptions = followOptions(
    modelChoices,
    modelDetail(selection, profile),
  );
  // 档位跟着**当前模型**的能力规则收窄；模型没设或未登记时退回该 CLI 的并集。
  // 多数 CLI 没有（或还没实测出）智能水平档位，这时 sheet 里只剩一条「跟随执行器」，
  // 点开一个单选项没有意义 —— 整个 trigger 不渲染。已经设过值的仍要渲染：换类型后
  // 留下的旧覆盖得有地方看见和清掉。
  const effortValues = reasoningEffortsFor(selection.agentType, model);
  const effortPickable = effortValues.length > 0 || !!reasoningEffort;
  const effortOptions = followOptions(
    // 已选档位不在允许集合里时它不在候选中，得补一条，否则想清掉都点不着。
    reasoningEffort && !effortValues.includes(reasoningEffort)
      ? [reasoningEffort, ...effortValues]
      : effortValues,
    effortDetail(selection, profile),
  );
  // 模型和强度是两件独立的事：换模型不静默改强度，对不上就在下面写清楚，让用户
  // 自己决定改哪一边。静默清空会让人以为自己没点中。
  const effortSupported = isReasoningEffortSupported(selection.agentType, model, reasoningEffort);
  const commitModel = (next: string) => {
    onModelChange(next);
    const canContinue = reasoningEffortsFor(selection.agentType, next).length > 0 || !!reasoningEffort;
    setPicker(canContinue ? "effort" : null);
  };
  const executorItems = useMemo(
    () => executorOptions(types, profiles, selection),
    [types, profiles, selection],
  );

  const openModelFor = (nextSelection: ExecutorSelection, nextModel: string) => {
    const nextProfile = profileForSelection(nextSelection, profiles);
    const nextProvider = nextProfile?.providerId
      ? providers.find((item) => item.id === nextProfile.providerId)
      : undefined;
    setCustomModel(nextModel);
    setPicker("model");
    setModelError(null);
    if (!nextProvider) {
      setProviderModels(null);
      loadCliModels(nextSelection.agentType);
      return;
    }
    const cached = providerModelCache.get(nextProvider.id);
    if (cached) {
      setProviderModels(cached);
      return;
    }
    setProviderModels(null);
    api
      .probeModels({ protocol: nextProvider.protocol, baseUrl: nextProvider.baseUrl, id: nextProvider.id })
      .then(({ models }) => {
        providerModelCache.set(nextProvider.id, models);
        setProviderModels(models);
      })
      .catch((error) => setModelError(error instanceof Error ? error.message : String(error)));
  };
  const openModel = () => openModelFor(selection, model);

  // CLI 那一档的候选。失败**不报错**:内置快照顶着,选择器照常能用 —— 为一个「清单
  // 可能少两个」的问题弹红字,不如安静降级。
  function loadCliModels(agentType: AgentType) {
    const cached = cliModelCache.get(agentType);
    setCliModels(cached ? { type: agentType, models: cached } : null);
    if (cached) return;
    api
      .cliModels(agentType)
      .then((list) => {
        const models = list.find((entry) => entry.type === agentType)?.models;
        if (!models?.length) return;
        cliModelCache.set(agentType, [...models]);
        setCliModels({ type: agentType, models: [...models] });
      })
      .catch(() => {});
  }

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
      {/* 跟 web 同一副形状：一颗三段胶囊「智能体 · 模型 · 智能水平」，选定前一段后
          默认向右接着打开后一段。手机上给模型多一点宽，各段都保持单行省略。 */}
      <View
        style={{
          flexDirection: "row",
          overflow: "hidden",
          borderRadius: radius.md,
          borderWidth: effortSupported ? 0 : 1,
          borderColor: effortSupported ? "transparent" : theme.danger,
          backgroundColor: theme.panel,
        }}
      >
        <ConfigTrigger
          label="智能体"
          value={selectionLabel(selection, profiles)}
          grow={1}
          onPress={() => setPicker("executor")}
        />
        <ConfigTrigger label="模型" value={model || "跟随执行器"} grow={1.35} divider onPress={openModel} />
        {effortPickable ? (
          <ConfigTrigger
            label="智能水平"
            value={reasoningEffort || "跟随执行器"}
            tone={effortSupported ? "normal" : "error"}
            grow={0.9}
            divider
            onPress={() => setPicker("effort")}
          />
        ) : null}
      </View>
      {effortSupported ? null : (
        <Text style={{ color: theme.danger, fontSize: 10.5 }}>
          {model || "当前模型"} 不支持 {reasoningEffort}，请改选档位或换一个模型
        </Text>
      )}

      {picker ? (
        <SelectSheet
          title={picker === "executor" ? `选择${role}` : picker === "model" ? `${role}模型` : `${role}智能水平`}
          options={options}
          value={value}
          onSelect={(next) => {
            if (picker === "executor") {
              const selected = parseSelection(next, profiles, selection);
              // 换执行器 = 旧的模型/智能水平覆盖作废（那套模型 id 多半在新执行器上
              // 不存在）。清空动作放在这一层，三个调用点共用；判定走 shared 的
              // sameExecutor，与 web 和服务端同一条口径。
              if (!sameExecutor(selected, selection)) {
                onModelChange("");
                onReasoningEffortChange("");
              }
              onSelectionChange(selected);
              openModelFor(selected, sameExecutor(selected, selection) ? model : "");
            } else if (picker === "model") commitModel(next);
            else onReasoningEffortChange(next);
          }}
          // 选中前一段时会先把 picker 推到后一段；只关闭仍停在原段的 sheet，避免
          // SelectSheet 随后的默认关闭把刚接续打开的下一段覆盖掉。
          onClose={() => setPicker((current) => current === picker ? null : current)}
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
                    commitModel(customModel.trim());
                  }}
                />
                <Button
                  label="使用"
                  onPress={() => {
                    commitModel(customModel.trim());
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

function ConfigTrigger({
  label,
  value,
  tone = "normal",
  grow = 1,
  divider = false,
  onPress,
}: {
  label: string;
  value: string;
  /** error = 当前选中的档位这个模型吃不下，红字提醒但仍可点开改。 */
  tone?: "normal" | "error";
  /** 这一段分多少宽：模型名最长，给它多一点。 */
  grow?: number;
  /** 除第一段外都画一道左分隔线——三段是一颗胶囊，不是三颗。 */
  divider?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const bad = tone === "error";
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: grow,
        minWidth: 0,
        gap: 3,
        paddingHorizontal: 10,
        paddingVertical: 9,
        borderLeftWidth: divider ? 1 : 0,
        borderLeftColor: theme.line,
        backgroundColor: pressed ? theme.overlay : "transparent",
      })}
    >
      <Text style={{ color: theme.faint, fontSize: 10, fontFamily: fonts.mono }} numberOfLines={1}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        {bad ? <Ionicons name="warning" size={12} color={theme.danger} /> : null}
        <Text
          style={{ flex: 1, color: bad ? theme.danger : theme.ink, fontSize: 12, fontFamily: fonts.bodySemi }}
          numberOfLines={1}
        >
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
    : `使用「${name}」的默认智能水平`;
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

// 选项分两路，别混成一路（2026-07-30 审查拦下过一次）：
// 1. **「默认 X」只从 types 生成**，而 types 只装本机探到的 available（调用点负责过滤）——
//    这是「按类型新选」，没探到的选出来就是一单必然起不来的任务。
// 2. **已注册的 profile 恒列出**，哪怕它的类型此刻没探到（ssh 远端本机自然探不到）；但列出
//    profile ≠ 把它的类型也变成第 1 类候选，所以这些单独排在后面、不带「默认 X」。
// 3. 当前生效的选择两路都不在时（老任务用的 CLI 刚被卸掉），补一条标注状态的条目：让 sheet
//    能打勾、也让用户看见原因。它永远等于当前值，构不成一个新的可选类型。
function executorOptions(
  types: AgentType[],
  profiles: AgentExecutorProfile[],
  selection: ExecutorSelection,
): SelectSheetOption[] {
  const profileOption = (profile: AgentExecutorProfile, suffix?: string): SelectSheetOption => ({
    value: profile.id,
    label: profile.name,
    detail: [profile.type, profile.model || "默认模型", profile.isDefault ? "类型默认" : null, suffix]
      .filter(Boolean)
      .join(" · "),
  });
  const options = types.flatMap((type) => {
    const defaultProfile = profiles.find((profile) => profile.type === type && profile.isDefault);
    return [
      {
        value: `default:${type}`,
        label: `默认 ${type}`,
        detail: defaultProfile ? `当前使用 ${defaultProfile.name}` : "跟随该类型的默认执行器",
      },
      ...profiles.filter((profile) => profile.type === type).map((profile) => profileOption(profile)),
    ];
  });
  options.push(
    ...profiles
      .filter((profile) => !types.includes(profile.type))
      .map((profile) => profileOption(profile, "本机未检测到")),
  );
  if (!selection.executorId && !types.includes(selection.agentType)) {
    options.push({
      value: `default:${selection.agentType}`,
      label: `默认 ${selection.agentType}`,
      detail: "当前设置 · 本机未检测到该 CLI，很可能起不来",
    });
  }
  return options;
}
