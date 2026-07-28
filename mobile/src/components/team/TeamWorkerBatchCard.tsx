import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Task } from "@harness/shared";
import type { Batch } from "@harness/shared/team";
import { STATUS_META } from "@/lib/constants";
import { formatInstant } from "@/lib/time";
import { fonts, radius, useTheme } from "@/lib/theme";
import { StatusDot } from "@/components/ui";

export function TeamWorkerBatchCard({
  batch,
  batchNumber,
  workerNumber,
  onOpenWorker,
}: {
  batch: Batch;
  batchNumber: number;
  workerNumber: ReadonlyMap<string, number>;
  onOpenWorker: (id: string) => void;
}) {
  const theme = useTheme();

  return (
    <View
      style={{
        overflow: "hidden",
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: batch.group?.paused ? theme.faint : theme.line,
        backgroundColor: theme.panel,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 7,
          paddingHorizontal: 11,
          paddingVertical: 9,
          backgroundColor: theme.raised,
        }}
      >
        <Ionicons name="git-branch-outline" size={14} color={theme.muted} />
        <Text style={{ color: theme.ink, fontSize: 13, fontFamily: fonts.bodySemi }}>
          批次 {batchNumber}
        </Text>
        <BatchPill label={batch.serial ? "串行" : "并行"} />
        {batch.group?.paused ? <BatchPill label="已停止" /> : null}
        <Text style={{ marginLeft: "auto", color: theme.faint, fontSize: 10, fontFamily: fonts.mono }}>
          {formatInstant(batch.at)}
        </Text>
      </View>

      {batch.workers.map((worker) => (
        <WorkerRow
          key={worker.id}
          worker={worker}
          number={workerNumber.get(worker.id) ?? 0}
          groupPaused={!!batch.group?.paused}
          onPress={() => onOpenWorker(worker.id)}
        />
      ))}
    </View>
  );
}

function BatchPill({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: theme.line2,
        backgroundColor: theme.panel,
      }}
    >
      <Text style={{ color: theme.muted, fontSize: 10, fontFamily: fonts.mono }}>{label}</Text>
    </View>
  );
}

function WorkerRow({
  worker,
  number,
  groupPaused,
  onPress,
}: {
  worker: Task;
  number: number;
  groupPaused: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const asking = !!worker.question;
  const status = workerStatusText(worker, groupPaused);
  const executor = worker.executorLabel?.trim() || worker.agentType || "—";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开执行者 ${number}：${worker.title}`}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        minHeight: 60,
        paddingHorizontal: 11,
        paddingVertical: 9,
        borderTopWidth: 1,
        borderTopColor: theme.line,
        backgroundColor: asking ? "#22D3EE0D" : theme.panel,
      }}
    >
      <StatusDot status={worker.status} size={10} />
      <Text style={{ width: 18, color: theme.faint, fontSize: 10, fontFamily: fonts.mono }}>
        {number}
      </Text>
      <View style={{ flex: 1, gap: 5 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Text numberOfLines={1} style={{ flex: 1, color: theme.ink, fontSize: 13, fontFamily: fonts.bodyMed }}>
            {worker.title}
          </Text>
          {asking ? (
            <View style={{ borderRadius: radius.sm, backgroundColor: "#22D3EE1A", paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ color: "#22D3EE", fontSize: 10, fontFamily: fonts.bodySemi }}>提问中</Text>
            </View>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={{ maxWidth: "48%", color: theme.muted, fontSize: 10, fontFamily: fonts.mono }}>
            {executor}
          </Text>
          <Text numberOfLines={1} style={{ flex: 1, color: asking ? "#22D3EE" : theme.faint, fontSize: 11, fontFamily: fonts.body }}>
            {status}
          </Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={15} color={theme.faint} />
    </Pressable>
  );
}

function workerStatusText(worker: Task, groupPaused: boolean): string {
  if (worker.question) return "等待你的答复";
  if (groupPaused && worker.status === "paused") return "被停止全组打断";
  if (groupPaused && (worker.status === "queued" || worker.status === "backlog")) return "所属组已停止";
  if (worker.status === "queued" && worker.queuePosition != null) return `排队第 ${worker.queuePosition + 1} 位`;
  if (worker.status === "paused" && worker.resumePrompt) return "已到检查点";
  return STATUS_META[worker.status]?.label ?? worker.status;
}
