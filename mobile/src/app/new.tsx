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
} from "@ash/shared";
import { useStore } from "@/lib/store";
import { api, type DetectedAgent } from "@/lib/api";
import { LAUNCH_MODES, type LaunchMode } from "@/lib/constants";
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
  const [detectFailed, setDetectFailed] = useState(false);
  const [leadPick, setLeadPick] = useState<ExecutorSelection | null>(null);
  const [workerPick, setWorkerPick] = useState<ExecutorSelection | null>(null);
  const [leadModel, setLeadModel] = useState("");
  const [leadReasoningEffort, setLeadReasoningEffort] = useState("");
  const [workerModel, setWorkerModel] = useState("");
  const [workerReasoningEffort, setWorkerReasoningEffort] = useState("");
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

  // Executor profiles + providers drive ordinary and team model choices. 本机检测
  // 也一起拉：普通任务的执行器候选同样只列探到的 CLI（目录里 15 个，没装的选出来只会
  // 跑失败），所以不能再等切到团队模式才探。mobile 是拉取风格，这里就一次性拉完。
  useEffect(() => {
    let alive = true;
    Promise.all([
      api.agents().catch(() => []),
      api.llmProviders().catch(() => []),
      api
        .detectAgents()
        .then((list) => ({ list, failed: false }))
        // 探测失败必须与「一个都没装」分开：候选列表上长得一样，但只有后者该拦住建单。
        .catch(() => ({ list: [] as DetectedAgent[], failed: true })),
    ]).then(([nextProfiles, nextProviders, detection]) => {
      if (!alive) return;
      setProfiles(nextProfiles);
      setProviders(nextProviders);
      setDetectedAgents(detection.list);
      setDetectFailed(detection.failed);
      setDetectedLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 「按类型新选」的候选**只有本机探到的 available**，顺序跟 AGENT_TYPES，允许为空。
  // 刻意不并入已注册 profile 的类型、也不兜底 claude：那会凭空造出一个本机没装的候选
  // （2026-07-30 审查拦下过）。已注册的 profile 由 ExecutionConfig 的 executorOptions
  // 单独列出。与 web 的 useDetectedAgents.availableTypes 同一条口径。
  const availableTypes = useMemo<AgentType[]>(() => {
    const usable = new Set<string>(
      detectedAgents.filter((item) => item.available).map((item) => item.type),
    );
    return AGENT_TYPES.filter((type) => usable.has(type));
  }, [detectedAgents]);
  // 哪些类型**有能力**当调度者(执行器实现了 openResident)。detect 只在 CLI 装了的时候才去
  // 问执行器,没装的一律报 resident:false —— 所以要并上一份已知能力名单兜底,否则「本机没装
  // claude、但注册了 claude 调度者 profile」会被误判成没有可用调度者(第二轮审查抓到)。
  // 这份名单是服务端 openResident 实现的镜像,与 web useDetectedAgents.residentTypes 同源。
  const residentTypes = useMemo<AgentType[]>(() => {
    const capable = new Set<string>(["claude"]);
    for (const item of detectedAgents) if (item.resident) capable.add(item.type);
    return AGENT_TYPES.filter((type) => capable.has(type));
  }, [detectedAgents]);
  // 「能不能常驻」与「本机装没装」是两个独立条件:按类型新选调度者要两个都满足,
  // 但**已注册 profile 只按 resident 筛** —— 探测失败时它也不该凭空消失。
  const leadTypes = useMemo<AgentType[]>(
    () => residentTypes.filter((type) => availableTypes.includes(type)),
    [residentTypes, availableTypes],
  );
  const leadProfiles = useMemo(
    () => profiles.filter((profile) => residentTypes.includes(profile.type)),
    [profiles, residentTypes],
  );
  // 这个选择在本机还成不成立：指名 profile 的看 profile 还在不在（探测这一次没探到也
  // 照样能用），按类型默认的看类型探到没探到。
  const pickable = (
    selection: ExecutorSelection,
    types: AgentType[],
    pool: AgentExecutorProfile[] = profiles,
  ) =>
    selection.executorId
      ? pool.some((profile) => profile.id === selection.executorId)
      : types.includes(selection.agentType);
  // 当前选择不可用时顺移到哪:先一个 available 类型(可要求避开 avoid,给两个角色留不同
  // 视角),没有就退到任一已注册 profile,都没有返回 null。与 web fallbackExecutor 同口径。
  const fallbackExecutor = (
    types: AgentType[],
    pool: AgentExecutorProfile[],
    avoid?: AgentType,
  ): ExecutorSelection | null => {
    const type = types.find((item) => item !== avoid) ?? types[0];
    if (type) return { agentType: type, executorId: null };
    const profile =
      pool.find((item) => item.type !== avoid && item.isDefault)
      ?? pool.find((item) => item.type !== avoid)
      ?? pool.find((item) => item.isDefault)
      ?? pool[0];
    return profile ? { agentType: profile.type, executorId: profile.id } : null;
  };
  const leadSelection: ExecutorSelection =
    leadPick && pickable(leadPick, leadTypes, leadProfiles)
      ? leadPick
      : fallbackExecutor(leadTypes, leadProfiles) ?? { agentType: TEAM_DEFAULTS.lead, executorId: null };
  const workerSelection: ExecutorSelection =
    workerPick && pickable(workerPick, availableTypes)
      ? workerPick
      : fallbackExecutor(availableTypes, profiles, leadSelection.agentType)
        ?? { agentType: leadSelection.agentType, executorId: leadSelection.executorId };
  // 默认执行器写死 claude，这台机器上没装 claude 时它就是一单必然失败的任务。检测回来后
  // 当前选择不成立就顺移：先第一个 available 类型，没有就退到任一已注册 profile；两者都
  // 没有时保留原值并在界面上明示（不硬堵提交——检测失败与「真的什么都没装」长得一样）。
  useEffect(() => {
    if (!detectedLoaded || pickable(executorPick, availableTypes)) return;
    const next = fallbackExecutor(availableTypes, profiles);
    if (!next) return;
    setExecutorPick(next);
    setModel("");
    setReasoningEffort("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pickable 只读 profiles，已在依赖里
  }, [detectedLoaded, availableTypes, executorPick, profiles]);
  const unavailablePick = detectedLoaded && !pickable(executorPick, availableTypes)
    ? executorPick.agentType
    : null;
  // 真的一个都没有（探测成功、零 available、零已注册 profile）= 建出来必然起不来,拦住提交。
  // 探测失败时不拦：分不清「没装」和「探不出来」,拦住会把一次接口抖动变成「新建任务坏了」。
  const noExecutor = detectedLoaded && !detectFailed && availableTypes.length === 0 && profiles.length === 0;

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
    // 挡板放在提交函数里,不只挂在按钮的 disabled 上 —— web 那边就是因为只挂了按钮,⌘↵
    // 绕过去建出一单必然失败的任务(第三轮审查抓到)。mobile 现在没有第二条提交路径,但
    // 判据留在这里,以后加手势/快捷键自动继承。
    if (noExecutor) {
      setError("本机没检测到任何可用的智能体 CLI，也没有已注册的执行器；先装一个或注册一个再建任务");
      return;
    }
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
            leadProfiles={leadProfiles}
            workerTypes={availableTypes}
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
              types={availableTypes}
              profiles={profiles}
              providers={providers}
              model={model}
              reasoningEffort={reasoningEffort}
              onSelectionChange={setExecutorPick}
              onModelChange={setModel}
              onReasoningEffortChange={setReasoningEffort}
            />
            {unavailablePick && !noExecutor ? (
              // 警示色沿用 TeamOverview 那处的 amber-500 字面值（主题里没有 warning 角色，
              // danger 留给真错误）。
              <Text style={{ marginTop: 6, color: "#F59E0B", fontSize: 11.5, lineHeight: 16 }}>
                本机没检测到「{unavailablePick}」这个 CLI，这单很可能起不来。
                {detectFailed
                  ? "（这次检测请求本身失败了，也可能只是探不出来。）"
                  : "装好后到桌面端「管理执行器」点检测。"}
              </Text>
            ) : null}
          </Field>
        ) : null}

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
                  将拉一个新分支 ash/&lt;id8&gt;，跑在 .worktrees/&lt;id&gt;/
                </Text>
              </View>
            ) : null}
          </Field>
        ) : null}

        {error ? <Text style={{ color: theme.danger, fontSize: 13 }}>{error}</Text> : null}

        {/* 一个能干活的都没有 = 建了必然起不来,所以按钮也禁用;这条提示与模式无关,普通/团队都要看到。 */}
        {noExecutor ? (
          <Text style={{ color: "#F59E0B", fontSize: 11.5, lineHeight: 16 }}>
            本机没检测到任何可用的智能体 CLI，也没有已注册的执行器 —— 建出来的任务起不来，所以先拦住了。装一个 CLI 后到桌面端「管理执行器」点检测。
          </Text>
        ) : null}

        <Button
          label={busy ? "提交中…" : activeMode.btn}
          onPress={submit}
          disabled={busy || noExecutor || (launch === "cron" && !cron.trim())}
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
