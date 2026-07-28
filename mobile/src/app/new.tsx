import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AGENT_TYPES,
  DEFAULT_APP_SETTINGS,
  TEAM_DEFAULTS,
  type AgentExecutorProfile,
  type AgentType,
  type LlmProvider,
  type Priority,
} from "@harness/shared";
import { useStore } from "@/lib/store";
import { api, type DetectedAgent } from "@/lib/api";
import { PRIORITIES, LAUNCH_MODES, type LaunchMode } from "@/lib/constants";
import { groupLabel } from "@/lib/util";
import { useTheme } from "@/lib/theme";
import { Pill, Button, Input } from "@/components/ui";
import { ScheduleFields } from "@/components/ScheduleFields";
import { TeamTaskOptions, type ExecutorSelection } from "@/components/TeamTaskOptions";
import { ExecutionConfig } from "@/components/ExecutionConfig";

const firstLine = (s: string) =>
  s.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 40) ?? "";

export default function NewTask() {
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const projects = useStore((s) => s.projects);
  const storeProjectId = useStore((s) => s.projectId);
  const upsertTask = useStore((s) => s.upsertTask);
  const groups = useStore((s) => s.groups);
  const upsertGroup = useStore((s) => s.upsertGroup);

  const [projectId, setProjectId] = useState<string | null>(storeProjectId);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [executorPick, setExecutorPick] = useState<ExecutorSelection>({ agentType: "claude", executorId: null });
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [teamOn, setTeamOn] = useState(false);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [detectedAgents, setDetectedAgents] = useState<DetectedAgent[]>([]);
  const [detectedLoaded, setDetectedLoaded] = useState(false);
  const [leadPick, setLeadPick] = useState<ExecutorSelection | null>(null);
  const [workerPick, setWorkerPick] = useState<ExecutorSelection | null>(null);
  const [leadModel, setLeadModel] = useState("");
  const [leadReasoningEffort, setLeadReasoningEffort] = useState("");
  const [workerModel, setWorkerModel] = useState("");
  const [workerReasoningEffort, setWorkerReasoningEffort] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  // 启动时机（§9）：默认「立即执行」，与 web 一致。once 用 Date，cron 用裸 5 字段表达式。
  const [launch, setLaunch] = useState<LaunchMode>("run");
  const [at, setAt] = useState<Date>(() => new Date(Date.now() + 3600_000)); // 默认 +1h
  const [cron, setCron] = useState("0 9 * * *");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Apply the factory default immediately, then hydrate the server-side global
  // setting. A failed read deliberately stays at true. As on web, a choice the
  // user makes before hydration completes is never overwritten.
  const [worktreeDefault, setWorktreeDefault] = useState(DEFAULT_APP_SETTINGS.worktreeDefault);
  const [useWorktree, setUseWorktree] = useState(DEFAULT_APP_SETTINGS.worktreeDefault);
  const [savingWorktreeDefault, setSavingWorktreeDefault] = useState(false);
  const worktreeChoiceTouched = useRef(false);
  const [base, setBase] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  // Project the form is targeting determines which branch list we fetch.
  const project = projects.find((p) => p.id === projectId) ?? null;
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const settings = await api.settings();
        if (!alive) return;
        setWorktreeDefault(settings.worktreeDefault);
        if (!worktreeChoiceTouched.current) setUseWorktree(settings.worktreeDefault);
      } catch {
        // Factory fallback is already applied; task creation can continue.
      }
    })();
    return () => { alive = false; };
  }, []);
  // Lazy-load branches when the toggle opens for the current project; reset
  // when the user switches projects.
  useEffect(() => {
    if (!useWorktree || !projectId) return;
    if (branchesLoaded) return;
    let alive = true;
    api.projectBranches(projectId).then((r) => {
      if (!alive) return;
      setBranches(r.branches);
      if (!base && r.current) setBase(r.current);
      setBranchesLoaded(true);
    }).catch(() => alive && setBranchesLoaded(true));
    return () => { alive = false; };
  }, [useWorktree, projectId, branchesLoaded, base]);
  useEffect(() => {
    // Switching projects invalidates the cached branch list.
    setBranches([]);
    setBranchesLoaded(false);
    setBase("");
  }, [projectId]);

  // Executor profiles + providers drive ordinary and team model choices. Local
  // detection remains team-only because it shells out to inspect resident support.
  useEffect(() => {
    let alive = true;
    Promise.all([api.agents().catch(() => []), api.llmProviders().catch(() => [])]).then(([nextProfiles, nextProviders]) => {
      if (!alive) return;
      setProfiles(nextProfiles);
      setProviders(nextProviders);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!teamOn || detectedLoaded) return;
    let alive = true;
    api.detectAgents().catch(() => []).then((detected) => {
      if (!alive) return;
      setDetectedAgents(detected);
      setDetectedLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [teamOn, detectedLoaded]);

  const leadTypes = useMemo<AgentType[]>(() => {
    const resident = detectedAgents.filter((item) => item.available && item.resident).map((item) => item.type);
    return resident.length ? resident : [TEAM_DEFAULTS.lead];
  }, [detectedAgents]);
  const workerTypes = useMemo<AgentType[]>(() => {
    const available = detectedAgents.filter((item) => item.available).map((item) => item.type);
    return available.length ? available : [...AGENT_TYPES];
  }, [detectedAgents]);
  const leadSelection: ExecutorSelection =
    leadPick && leadTypes.includes(leadPick.agentType)
      ? leadPick
      : { agentType: leadTypes[0]!, executorId: null };
  const workerSelection: ExecutorSelection =
    workerPick && workerTypes.includes(workerPick.agentType)
      ? workerPick
      : {
          agentType: workerTypes.find((type) => type !== leadSelection.agentType) ?? leadSelection.agentType,
          executorId: null,
        };

  const pickLaunch = (m: LaunchMode) => {
    if (m === "once") Keyboard.dismiss(); // 让出键盘，给 iOS inline spinner 腾位
    setLaunch(m);
  };

  const toggleWorktree = () => {
    worktreeChoiceTouched.current = true;
    setUseWorktree((value) => !value);
  };

  const saveWorktreeDefault = async () => {
    if (savingWorktreeDefault || useWorktree === worktreeDefault) return;
    setSavingWorktreeDefault(true);
    try {
      const settings = await api.patchSettings({ worktreeDefault: useWorktree });
      setWorktreeDefault(settings.worktreeDefault);
      Alert.alert(
        "已设为默认",
        `以后新建任务将默认${useWorktree ? "使用 worktree" : "直接在项目运行"}`,
      );
    } catch (e) {
      Alert.alert("保存失败", e instanceof Error ? e.message : String(e));
    } finally {
      setSavingWorktreeDefault(false);
    }
  };

  const projectGroups = groups.filter((g) => g.projectId === projectId);
  // 内联新建分组(默认并行),建好即选中——避免依赖平台相关的 Alert.prompt。
  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name || !projectId) return;
    try {
      const g = await api.createGroup({ name, mode: "parallel", projectId });
      upsertGroup(g);
      setGroupId(g.id);
      setNewGroupName("");
      setCreatingGroup(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = async () => {
    if (!projectId) {
      setError("请选择项目");
      return;
    }
    if (!title.trim() && !body.trim()) {
      setError("请填写标题或正文");
      return;
    }
    if (launch === "cron" && !cron.trim()) {
      setError("请填写 cron 表达式");
      return;
    }
    if (launch === "once" && at.getTime() <= Date.now()) {
      setError("定时时间必须在将来");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const explicit = title.trim();
      const team = {
        lead: leadSelection.agentType,
        worker: workerSelection.agentType,
        leadExecutorId: leadSelection.executorId,
        workerExecutorId: workerSelection.executorId,
        leadModel: leadModel || null,
        leadReasoningEffort: leadReasoningEffort || null,
        workerModel: workerModel || null,
        workerReasoningEffort: workerReasoningEffort || null,
      };
      const t = await api.createTask({
        projectId,
        groupId,
        title: explicit || firstLine(body) || "新任务",
        body: body.trim(),
        mode: teamOn ? "team" : "single",
        agentType: teamOn ? leadSelection.agentType : executorPick.agentType,
        executorId: teamOn ? null : executorPick.executorId,
        ...(teamOn
          ? { team }
          : {
              model: model || null,
              reasoningEffort: reasoningEffort || null,
            }),
        priority,
        // Resident consoles do not run the single-task auto-title turn.
        autoTitle: teamOn ? false : !explicit,
        // Team worktree is opt-in too: when enabled, the resident lead and its
        // default workers share it; a worker can still request its own isolation.
        useWorktree: project?.health.isRepo ? useWorktree : false,
        worktreeBase: useWorktree && base ? base : null,
      });
      upsertTask(t);
      // 启动时机分支：run=立即跑；once/cron=挂定时（调度器到点入队）；create=留 backlog。
      if (launch === "run") await api.runTask(t.id).catch(() => {});
      else if (launch === "once") await api.setSchedule(t.id, { kind: "once", at: at.toISOString() });
      else if (launch === "cron") await api.setSchedule(t.id, { kind: "cron", cron: cron.trim() });
      router.replace(`/task/${t.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const activeMode = LAUNCH_MODES.find((m) => m.key === launch)!;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.bg }}
        contentContainerStyle={{ padding: 16, gap: 18 }}
        keyboardShouldPersistTaps="handled"
      >
        <Field label="项目">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {projects.map((p) => (
              <Pill
                key={p.id}
                label={p.name}
                active={p.id === projectId}
                onPress={() => {
                  setProjectId(p.id);
                  setGroupId(null); // 换项目后清掉旧分组选择
                  setCreatingGroup(false);
                }}
              />
            ))}
          </View>
        </Field>

        <Field label="标题（留空则自动命名）">
          <Input value={title} onChangeText={setTitle} placeholder="任务标题" />
        </Field>

        <Field label="正文 / 指令">
          <Input
            value={body}
            onChangeText={setBody}
            placeholder={teamOn ? "给调度者的目标，它会拆活并派执行者…" : "要这个 agent 做什么…"}
            multiline
            style={{ minHeight: 120, textAlignVertical: "top" }}
          />
        </Field>

        <Field label="任务模式">
          <TeamTaskOptions
            enabled={teamOn}
            onEnabledChange={setTeamOn}
            lead={leadSelection}
            worker={workerSelection}
            leadTypes={leadTypes}
            workerTypes={workerTypes}
            profiles={profiles}
            providers={providers}
            leadModel={leadModel}
            leadReasoningEffort={leadReasoningEffort}
            workerModel={workerModel}
            workerReasoningEffort={workerReasoningEffort}
            onLeadChange={setLeadPick}
            onWorkerChange={setWorkerPick}
            onLeadModelChange={setLeadModel}
            onLeadReasoningEffortChange={setLeadReasoningEffort}
            onWorkerModelChange={setWorkerModel}
            onWorkerReasoningEffortChange={setWorkerReasoningEffort}
          />
        </Field>

        {!teamOn ? (
          <Field label="执行设置">
            <ExecutionConfig
              role="执行器"
              icon="hardware-chip-outline"
              selection={executorPick}
              types={[...AGENT_TYPES]}
              profiles={profiles}
              providers={providers}
              model={model}
              reasoningEffort={reasoningEffort}
              onSelectionChange={setExecutorPick}
              onModelChange={setModel}
              onReasoningEffortChange={setReasoningEffort}
            />
          </Field>
        ) : null}

        <Field label="优先级">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {PRIORITIES.map((p) => (
              <Pill
                key={p.key}
                label={p.label}
                color={p.bars > 0 ? p.color : undefined}
                active={p.key === priority}
                onPress={() => setPriority(p.key)}
              />
            ))}
          </View>
        </Field>

        <Field label="分组（可选）">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Pill label="无分组" active={!groupId} onPress={() => setGroupId(null)} />
            {projectGroups.map((g) => (
              <Pill key={g.id} label={groupLabel(g)} active={g.id === groupId} onPress={() => setGroupId(g.id)} />
            ))}
            <Pill label="＋ 新建分组" onPress={() => setCreatingGroup((v) => !v)} />
          </View>
          {creatingGroup ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
              <Input
                value={newGroupName}
                onChangeText={setNewGroupName}
                placeholder="分组名…(默认并行)"
                style={{ flex: 1 }}
                onSubmitEditing={createGroup}
                autoFocus
              />
              <Button label="创建" onPress={createGroup} disabled={!newGroupName.trim()} />
            </View>
          ) : null}
        </Field>

        <Field label="启动时机">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {LAUNCH_MODES.map((m) => (
              <Pill key={m.key} label={m.label} active={m.key === launch} onPress={() => pickLaunch(m.key)} />
            ))}
          </View>
          {launch === "once" || launch === "cron" ? (
            <View style={{ marginTop: 10 }}>
              <ScheduleFields kind={launch} at={at} cron={cron} onAt={setAt} onCron={setCron} />
            </View>
          ) : null}
        </Field>

        {project?.health.isRepo ? (
          <Field label={teamOn ? "worktree（团队共用）" : "worktree（隔离运行）"}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Pill
                label={useWorktree ? (teamOn ? "✓ 整队用新 worktree" : "✓ 用新 worktree") : "直接在项目跑"}
                active={useWorktree}
                onPress={toggleWorktree}
              />
              {useWorktree !== worktreeDefault ? (
                <Pressable
                  onPress={savingWorktreeDefault ? undefined : saveWorktreeDefault}
                  style={{ justifyContent: "center", paddingHorizontal: 6, opacity: savingWorktreeDefault ? 0.5 : 1 }}
                >
                  <Text style={{ color: theme.faint, fontSize: 12 }}>
                    {savingWorktreeDefault ? "保存中…" : "设为默认"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {useWorktree ? (
              <View style={{ marginTop: 8, gap: 8 }}>
                <Text style={{ color: theme.faint, fontSize: 11 }}>base 分支</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Pill label="当前分支" active={!base} onPress={() => setBase("")} />
                  {branches.map((b) => (
                    <Pill key={b} label={b} active={b === base} onPress={() => setBase(b)} />
                  ))}
                </View>
                <Text style={{ color: theme.faint, fontSize: 11 }}>
                  将拉一个新分支 harness/&lt;id8&gt;，跑在 .worktrees/&lt;id&gt;/
                </Text>
              </View>
            ) : null}
          </Field>
        ) : null}

        {error ? <Text style={{ color: theme.danger, fontSize: 13 }}>{error}</Text> : null}

        <Button
          label={busy ? "提交中…" : activeMode.btn}
          onPress={submit}
          disabled={busy || (launch === "cron" && !cron.trim())}
          style={{ marginTop: 4 }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.faint, fontSize: 12 }}>{label}</Text>
      {children}
    </View>
  );
}
