import { View, Text, Switch } from "react-native";
import type { AgentExecutorProfile, AgentType, LlmProvider } from "@harness/shared";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, radius, fonts } from "@/lib/theme";
import { ExecutionConfig, type ExecutorSelection } from "@/components/ExecutionConfig";

export type { ExecutorSelection } from "@/components/ExecutionConfig";

export function TeamTaskOptions({
  enabled,
  onEnabledChange,
  lead,
  worker,
  leadTypes,
  leadProfiles,
  workerTypes,
  profiles,
  providers,
  leadModel,
  leadReasoningEffort,
  workerModel,
  workerReasoningEffort,
  onLeadChange,
  onWorkerChange,
  onLeadModelChange,
  onLeadReasoningEffortChange,
  onWorkerModelChange,
  onWorkerReasoningEffortChange,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  lead: ExecutorSelection;
  worker: ExecutorSelection;
  leadTypes: AgentType[];
  /** 调度者那一栏能挑的 profile(已按 resident 收窄);缺省用共用的全量。 */
  leadProfiles?: AgentExecutorProfile[];
  workerTypes: AgentType[];
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  leadModel: string;
  leadReasoningEffort: string;
  workerModel: string;
  workerReasoningEffort: string;
  onLeadChange: (selection: ExecutorSelection) => void;
  onWorkerChange: (selection: ExecutorSelection) => void;
  onLeadModelChange: (model: string) => void;
  onLeadReasoningEffortChange: (effort: string) => void;
  onWorkerModelChange: (model: string) => void;
  onWorkerReasoningEffortChange: (effort: string) => void;
}) {
  const theme = useTheme();

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
        <View style={{ gap: 8 }}>
          <ExecutionConfig
            icon="shield-checkmark-outline"
            role="调度者"
            selection={lead}
            types={leadTypes}
            profiles={leadProfiles ?? profiles}
            providers={providers}
            model={leadModel}
            reasoningEffort={leadReasoningEffort}
            onSelectionChange={onLeadChange}
            onModelChange={onLeadModelChange}
            onReasoningEffortChange={onLeadReasoningEffortChange}
          />
          <ExecutionConfig
            icon="construct-outline"
            role="执行者"
            selection={worker}
            types={workerTypes}
            profiles={profiles}
            providers={providers}
            model={workerModel}
            reasoningEffort={workerReasoningEffort}
            onSelectionChange={onWorkerChange}
            onModelChange={onWorkerModelChange}
            onReasoningEffortChange={onWorkerReasoningEffortChange}
          />
        </View>
      ) : null}
    </View>
  );
}
