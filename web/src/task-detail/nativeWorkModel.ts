import type { NativeAgentActivity, NativeWorkEvent, NativeWorkStatus, TaskStatus } from "@ash/shared";
import { markdownImageRefs } from "@ash/shared/markdown-images";
import { childResultTexts, nativeWorkStatus as workStatus, sameSnapshotIdentity, snapshotVersion } from "@ash/shared/native-work";
export { nativeWorkStatus as workStatus } from "@ash/shared/native-work";
import type { AttachmentSource, ConversationItem } from "./conversationModel.ts";

export interface NativeWorkItem {
  id: string;
  kind: "agent" | "task";
  sessionId: string;
  sessionLabel: string;
  parentId?: string;
  nativeId?: string;
  title: string;
  description?: string;
  status: NativeWorkStatus;
  result?: string;
  message?: string;
  /** message 快照的协议身份(codex item.id / claude message.id)。配对用的身份住在
   * textVersions(身份跟正文一起转移,shared 的 snapshotVersion);这字段随行携带,行合并
   * 时与 message 作为同一份快照一起取舍(审查第 1 轮 R1 实证 C)。 */
  messageId?: string;
  owner?: string;
  model?: string;
  requestedModel?: string;
  /** 智能水平（内部仍叫 effort）：实跑档位与派活时点的档位分开记。 */
  effort?: string;
  requestedEffort?: string;
  startedAt?: string;
  endedAt?: string;
  agentType?: string;
  legacy?: boolean;
  activity?: NativeAgentActivity[];
  /** message/result(快照式正文)里图片引用的保存结果 —— 跟 activity 那份文档各配各的。 */
  messageImages?: AttachmentSource[];
  resultImages?: AttachmentSource[];
}

// 子智能体列表与执行详情抽屉共用同一套状态文案。
export const NATIVE_WORK_STATUS_LABELS: Record<NativeWorkStatus, string> = {
  pending: "待处理", running: "进行中", completed: "已完成", failed: "失败", stopped: "已停止", unknown: "状态未知",
};

/**
 * 没有派活正文时照实说，别留一片空白让人以为是界面漏了。
 * codex 的 `spawn_agent` 正文在上游就被整段加密（父子两份 rollout 里都只有密文），
 * 所以那条路是真拿不到；claude 的 Agent 工具入参是明文，会原样记下来。
 */
export const NATIVE_WORK_NO_ASSIGNMENT = "未记录主会话给它的输入：codex 的派活正文在上游已加密，ash 取不到；claude 的派活正文会原样记录。";

type Call = Extract<NativeWorkEvent, { type: "call" }>;
const str = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
// 参数类型写成可空是**故意的**：服务端已经把缺 name 的 tool 事件判成坏行并回 500
// （server/src/transcript.ts 的 validTraceEvent），但那是新判据，历史落盘和别的读端
// 都可能递进来一条没名字的记录。这里 `name!.split()` 一崩，React 会把整个任务页卸载
// 成白屏——一条坏记录不值这个代价（第 5 轮审查）。
const toolName = (name: string | undefined) => (name ?? "").split(/[./]/).at(-1)!.toLowerCase();
const spawnTools = new Set(["agent", "task", "spawn_agent"]);
const legacyTools = new Set([...spawnTools, "taskcreate", "taskupdate", "todowrite", "update_plan"]);
const terminal = (status: NativeWorkStatus) => ["completed", "failed", "stopped"].includes(status);
/** 没有真名字时用的占位标题。合并两条记录时靠它分辨哪个标题是真问出来的。 */
const placeholderTitle = (sessionId: string, id: string) => `子智能体 ${id.slice(sessionId.length + 1, sessionId.length + 9)}`;
const named = (row: NativeWorkItem) => row.title !== placeholderTitle(row.sessionId, row.id);
/**
 * codex 派给子智能体的正文是上游下发的密文（Fernet：`gAAAA…` 开头的单段 base64url）。
 * 它既不是标题也不是「收到的输入」——贴出来只会让人以为记录坏了，所以当它不存在，
 * 由 NATIVE_WORK_NO_ASSIGNMENT 说明为什么空着。
 */
const assignmentText = (value: unknown): string => {
  const text = str(value);
  return /^gAAAA[A-Za-z0-9_-]{32,}={0,2}$/.test(text) ? "" : text;
};
function parse(raw: string): Record<string, any> {
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}

function legacyInput(raw: string): Record<string, unknown> {
  const input = parse(raw);
  if (Object.keys(input).length) return input;
  // Old trace details were cut mid-JSON at 1,500 characters.
  for (const key of ["subject", "description", "prompt", "taskId", "status", "owner", "subagent_type", "model"]) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    if (match) { try { input[key] = JSON.parse(`"${match[1]}"`); } catch { /* incomplete field */ } }
  }
  return input;
}

export function buildNativeWork(items: ConversationItem[], taskStatus: TaskStatus): NativeWorkItem[] {
  const rows = new Map<string, NativeWorkItem>();
  // `行 id \u0000 字段` → 该快照式正文(message/result)的图片记录。服务端用 attachment 上的
  // `field` 标注归属;这里不许把它混进 row.activity —— 混进去等于给执行记录那份文档多一条
  // 结果,turnImages 的逐目的地对账会把整组判作废。`rev` 是正文的代(清场/换稿开新代),
  // 展示端只认最高代那组 —— 但代号只在**同一份来源文档**里可比(`from`):不同来源的记录
  // 混进同一槽时,后到的文档整组顶替先到的,正文(put 同样替换)和账才说的是同一版。
  type MetaRecord = { rev: number; from: string; version?: string; src: AttachmentSource };
  const metaImages = new Map<string, MetaRecord[]>();
  const stashMeta = (slot: string, record: MetaRecord) => {
    const list = metaImages.get(slot);
    if (!list || list[0]!.from !== record.from) metaImages.set(slot, [record]);
    else list.push(record);
  };
  /** 结果正文从调用行提取到别的行时(taskoutput / wait 的 statuses),它名下的 result 图片
   * 记录跟着搬。分发按「第 n 处指向这个来源的引用 ↔ 第 n 条报这个来源的记录」:几个子正文
   * 引用同一路径时,按记录的文档顺序(pos)对应提取顺序逐个派 —— 全给第一个命中的那版,
   * 甲拿双份被计数判作废、乙一条都没有(复审 R1 resultRouting)。提取文本里数不到的来源
   * (转义改写过)留在原槽:宁可不配,不乱认。 */
  const routeResultImages = (fromRow: string, targets: { rowId: string; text: string }[]) => {
    const slot = `${fromRow}\u0000result`;
    const records = metaImages.get(slot);
    if (!records) return;
    const capacity = new Map<string, Map<string, number>>();
    for (const target of targets) {
      if (target.rowId === fromRow || capacity.has(target.rowId)) continue;
      // 目标行的正文如今不是这份来源文档写的(更晚的直写/另一次调用顶掉了),这批记录说的
      // 是已经不在屏幕上的那版 —— 宁可留在原槽不配(第 10 轮审查 R2 legacyRouteOvertakes)。
      const origin = textOrigins.get(`${target.rowId}\u0000result`);
      if (origin !== undefined && origin !== fromRow) continue;
      const bySource = new Map<string, number>();
      for (const node of markdownImageRefs(target.text)) {
        bySource.set(node.destination, (bySource.get(node.destination) ?? 0) + 1);
      }
      capacity.set(target.rowId, bySource);
    }
    const rest: MetaRecord[] = [];
    const moved = new Map<string, MetaRecord[]>();
    for (const record of [...records].sort((a, b) => (a.src.pos ?? 0) - (b.src.pos ?? 0))) {
      const target = targets.find((candidate) => (capacity.get(candidate.rowId)?.get(record.src.source) ?? 0) > 0);
      if (!target) { rest.push(record); continue; }
      const bySource = capacity.get(target.rowId)!;
      bySource.set(record.src.source, bySource.get(record.src.source)! - 1);
      const destination = `${target.rowId}\u0000result`;
      moved.set(destination, [...(moved.get(destination) ?? []), record]);
    }
    for (const [destination, assigned] of moved) {
      const prior = metaImages.get(destination);
      // 同一来源文档分几批路由时追加;换了来源文档(新一轮 wait/taskoutput 的新正文)整组
      // 顶替 —— 正文那一侧 put 也是替换,两边必须说同一版。
      metaImages.set(destination, prior && prior[0]!.from === fromRow ? [...prior, ...assigned] : assigned);
    }
    if (rest.length) metaImages.set(slot, rest);
    else metaImages.delete(slot);
  };
  const calls = new Map<string, { call: Call; rowId?: string }>();
  // `行 id \u0000 字段` → 这段正文**当前由哪份来源文档写入**(直写 = 行自己,statuses/
  // taskoutput = 调用行)。路由与配对都要核它:正文已被更晚的文档改写时,旧来源的记录说的
  // 是另一版正文,搬进来就是把旧字节安在新话上(第 10 轮审查 R2 legacyRouteOvertakes)。
  const textOrigins = new Map<string, string>();
  // `行 id \u0000 字段` → 这段正文的协议身份(message 的 messageId / result 的调用 id,
  // 与服务端记账的 version 同源)。转移规则是 shared 的 snapshotVersion:换稿连身份一起换,
  // 无身份的新稿不继承旧身份(审查第 1 轮 R1)。
  const textVersions = new Map<string, string>();
  // 路由推迟到全部记录就位之后再执行:恢复合并(mergeImageJournal)把补回的记录追加在
  // trace 末尾,结果事件先到、记录后到,走到哪路到哪会把后到的记录永远留在调用行的槽里
  // (复审 R1 routedJournalLate 的存量数据半边)。
  const pendingRoutes: { from: string; targets: { rowId: string; text: string }[] }[] = [];
  const taskIds = new Map<string, string>();
  const endedRows = new Set<string>();
  const legacyOrdinals = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "agent") continue;
    const key = (id: string) => `${item.sessionId}:${id}`;
    const base = { sessionId: item.sessionId, sessionLabel: item.label };
    let observedAt: string | undefined;
    const put = (id: string, patch: Partial<NativeWorkItem>) => {
      const previous = rows.get(id);
      const next = { id, kind: "agent" as const, title: placeholderTitle(item.sessionId, id), status: "unknown" as const, ...base, ...previous, ...patch };
      if (observedAt) {
        if (!next.startedAt && next.status === "running") next.startedAt = observedAt;
        if (terminal(next.status) && (!previous || !terminal(previous.status))) next.endedAt = observedAt;
      }
      if (!terminal(next.status)) delete next.endedAt;
      if (next.result && next.message === next.result) delete next.message;
      rows.set(id, next);
      if (item.endedAt) endedRows.add(id);
      else endedRows.delete(id);
      return next;
    };
    const taskKey = (parent: string | undefined, nativeId: string) => key(`${parent ?? "root"}:task:${nativeId}`);
    const applyTask = (call: Call, legacy: boolean) => {
      const input = call.input;
      const nativeId = str(input.taskId);
      if (!nativeId) return;
      const lookup = taskKey(call.parentId, nativeId);
      const id = taskIds.get(lookup) ?? lookup;
      taskIds.set(lookup, id);
      const status = workStatus(input.status);
      put(id, {
        kind: "task", nativeId, parentId: call.parentId ? key(call.parentId) : undefined,
        ...(!rows.has(id) ? { title: `内部任务 #${nativeId}` } : {}),
        ...(str(input.subject) ? { title: str(input.subject) } : {}),
        ...(str(input.description) ? { description: str(input.description) } : {}),
        ...(str(input.owner) ? { owner: str(input.owner) } : {}),
        ...(status !== "unknown" ? { status } : {}), legacy,
      });
    };
    let index = 0;
    for (const segment of item.segments) for (const trace of segment.events) {
      const fallbackId = `legacy:${item.id}:${index++}`;
      if (trace.kind !== "tool") continue;
      if (!trace.nativeWork && !legacyTools.has(toolName(trace.label))) continue;
      const legacy = !trace.nativeWork;
      const activity: NativeWorkEvent = trace.nativeWork ?? {
        type: "call", id: fallbackId, name: trace.label, input: legacyInput(trace.detail ?? ""),
      };
      const timestamp = activity.at ?? trace.at;
      observedAt = timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
      if (activity.type === "activity") {
        const id = key(activity.id);
        const event = activity.event;
        if (event.kind === "attachment" && (event.field === "message" || event.field === "result") && event.source) {
          stashMeta(`${id}\u0000${event.field}`, {
            rev: event.rev ?? 0, from: id,
            ...(event.version !== undefined ? { version: event.version } : {}),
            src: { path: event.path, source: event.source, ref: event.ref, pos: event.pos, lost: event.lost },
          });
          continue;
        }
        const row = rows.get(id) ?? put(id, { nativeId: activity.id, status: "running" });
        (row.activity ??= []).push(event);
        continue;
      }
      if (activity.type === "agent") {
        const id = key(activity.id);
        const patch = Object.fromEntries(Object.entries(activity).filter(([, value]) => value !== undefined));
        delete patch.type;
        delete patch.id;
        delete patch.closed;
        delete patch.at;
        if (activity.model && ["spawnagent", "spawn_agent"].includes(toolName(trace.label))) {
          patch.requestedModel = activity.model;
          delete patch.model;
        }
        if (activity.effort && ["spawnagent", "spawn_agent"].includes(toolName(trace.label))) {
          patch.requestedEffort = activity.effort;
          delete patch.effort;
        }
        const previous = rows.get(id);
        if (activity.closed && (previous?.status === "completed" || previous?.status === "failed")) patch.status = previous.status;
        if (activity.status === "unknown" && rows.has(id)) delete patch.status;
        for (const field of ["message", "result"] as const) {
          const value = activity[field];
          if (typeof value !== "string" || !value) continue;
          const slot = `${id}\u0000${field}`;
          textOrigins.set(slot, id);
          // put() 在 message === result 时会删掉 message,正文退一步拿 result 顶上。
          const prevText = previous?.[field] ?? previous?.result ?? "";
          const version = snapshotVersion({ text: prevText, version: textVersions.get(slot) }, value, activity.messageId);
          if (version !== undefined) textVersions.set(slot, version);
          else textVersions.delete(slot);
        }
        put(id, { ...patch, ...(activity.parentId ? { parentId: key(activity.parentId) } : {}) });
        continue;
      }
      if (activity.type === "call") {
        const name = toolName(activity.name);
        const input = activity.input;
        const id = key(activity.id);
        const parentId = activity.parentId ? key(activity.parentId) : undefined;
        if (name === "todowrite" || name === "update_plan") {
          const list = input.todos ?? input.plan;
          if (!Array.isArray(list)) continue;
          const prefix = key(`${activity.parentId ?? "root"}:plan:`);
          const previousPlan = new Map([...rows].filter(([rowId]) => rowId.startsWith(prefix)));
          for (const rowId of previousPlan.keys()) rows.delete(rowId);
          list.forEach((step, ordinal) => {
            if (!step || typeof step !== "object") return;
            const title = str(step.content ?? step.step);
            const rowId = `${prefix}${ordinal}`;
            const previous = previousPlan.get(rowId);
            if (previous?.title === title) rows.set(rowId, previous);
            if (title) put(rowId, { kind: "task", title, parentId, status: workStatus(step.status), description: str(input.explanation), legacy });
          });
          continue;
        }
        if (calls.has(id)) continue;
        calls.set(id, { call: activity });
        if (spawnTools.has(name)) {
          const assignment = assignmentText(input.prompt ?? input.message);
          // 一个字都没问出来时不写 title，让 put 的占位标题生效（带一截 id，多行并排还分得开，
          // 也让 named() 如实说「这行还没有真名字」）。
          const title = str(input.description ?? input.name ?? input.task_name) || assignment.split("\n")[0].slice(0, 100);
          put(id, { kind: "agent", parentId, ...(title ? { title } : {}),
            description: assignment, requestedModel: str(input.model),
            requestedEffort: str(input.reasoningEffort ?? input.reasoning_effort ?? input.effort), agentType: str(input.subagent_type ?? input.agent_type),
            status: legacy ? "unknown" : "running", ...(observedAt ? { startedAt: observedAt } : {}), legacy });
          calls.get(id)!.rowId = id;
        } else if (name === "taskcreate") {
          let nativeId: string | undefined;
          if (legacy) {
            const scope = taskKey(activity.parentId, "");
            const ordinal = (legacyOrdinals.get(scope) ?? 0) + 1;
            legacyOrdinals.set(scope, ordinal);
            nativeId = String(ordinal);
            taskIds.set(taskKey(activity.parentId, nativeId), id);
          }
          put(id, { kind: "task", nativeId, parentId, title: str(input.subject) || "内部任务", description: str(input.description), status: legacy ? "unknown" : "pending", legacy });
          calls.get(id)!.rowId = id;
        } else if (name === "taskupdate" && legacy) applyTask(activity, true);
        continue;
      }
      const saved = calls.get(key(activity.id));
      if (!saved) continue;
      const { call, rowId } = saved;
      const name = toolName(call.name);
      const response = parse(activity.result);
      if (name === "taskupdate") {
        if (!activity.failed) applyTask(call, false);
        continue;
      }
      if (rowId && name === "taskcreate") {
        const nativeId = str(response.task?.id ?? response.taskId ?? response.id) || /Task\s+#(\S+)\s+created/i.exec(activity.result)?.[1];
        if (nativeId) taskIds.set(taskKey(call.parentId, nativeId), rowId);
        put(rowId, { nativeId, status: activity.failed ? "failed" : "pending", ...(activity.failed ? { result: activity.result } : {}) });
      } else if (rowId && spawnTools.has(name)) {
        const nativeId = str(response.agent_id ?? response.agentId) || /agentId:\s*([\w-]+)/.exec(activity.result)?.[1];
        const background = call.input.run_in_background === true || name === "spawn_agent" || /agent launched.*(?:async|background)|Async agent launched/i.test(activity.result);
        put(rowId, { nativeId, status: activity.failed ? "failed" : background ? "running" : "completed", result: activity.result });
        if (nativeId && name === "spawn_agent") {
          const row = rows.get(rowId)!;
          rows.delete(rowId);
          const existing = rows.get(key(nativeId));
          // 两边各有一半:派活调用带着调用参数,子线程那条带着执行器后来报上来的真名字与实跑
          // 档位。合并时逐项挑好的那个,别让后到的派活结果把已问出来的盖回去;两边都没名字时
          // 按合并后的 id 重算占位标题,免得留着派活调用那一截 id。
          const title = existing && named(existing) ? existing.title
            : named(row) ? row.title : placeholderTitle(row.sessionId, key(nativeId));
          // 行搬家(调用行 → 真实线程行):正文、身份、来源、图片记录是**同一份快照**,一起
          // 搬或一起弃,不许逐字段择优(审查第 1 轮 R1 实证 C:线程行的蓝正文配上调用行的旧
          // 身份与红记录)。哪边的正文进了合并后的行,哪边的快照就是这一槽的现任:线程行自己
          // 有这段正文时,调用行名下的记录说的是已经不在屏幕上的那版,整份丢弃;调用行的正文
          // 胜出时,它的记录/来源/身份改签后**整组顶替**线程槽(与 stashMeta 的「一槽只装一份
          // 来源文档,后到的整组顶替」同口径)。
          for (const field of ["message", "result"] as const) {
            const fromSlot = `${rowId}\u0000${field}`;
            const toSlot = `${key(nativeId)}\u0000${field}`;
            const moved = metaImages.get(fromSlot);
            const origin = textOrigins.get(fromSlot);
            const version = textVersions.get(fromSlot);
            metaImages.delete(fromSlot);
            textOrigins.delete(fromSlot);
            textVersions.delete(fromSlot);
            const callTextWins = field === "message"
              ? !existing
              : !existing || (activity.failed ? true : existing.result === undefined);
            if (!callTextWins) continue;
            if (origin !== undefined) textOrigins.set(toSlot, origin === rowId ? key(nativeId) : origin);
            if (version !== undefined) textVersions.set(toSlot, version);
            else textVersions.delete(toSlot);
            if (moved?.length) {
              metaImages.set(toSlot, moved.map((record) => record.from === rowId ? { ...record, from: key(nativeId) } : record));
            }
          }
          rows.set(key(nativeId), { ...row, id: key(nativeId), title, ...(existing ? {
            activity: existing.activity, message: existing.message, messageId: existing.messageId,
            description: existing.description || row.description,
            model: existing.model || row.model,
            requestedModel: existing.requestedModel || row.requestedModel,
            effort: existing.effort || row.effort,
            requestedEffort: existing.requestedEffort || row.requestedEffort,
            startedAt: [row.startedAt, existing.startedAt].filter((at): at is string => !!at).sort()[0],
            endedAt: existing.endedAt ?? row.endedAt,
            status: activity.failed ? "failed" : existing.status,
            result: activity.failed ? row.result : existing.result ?? row.result,
          } : {}) });
          if (endedRows.delete(rowId)) endedRows.add(key(nativeId));
        }
      } else if (!activity.failed) {
        // 结构化结果的子正文提取与服务端记账共用一份(childResultTexts):服务端按它把图片
        // 记录记在子文档名下,这儿按同一把尺取正文,两边才指同一段字(复审 R1 encodedMarkdown)。
        const extracted = new Map(childResultTexts(call.name, call.input, activity.result).map((child) => [child.id, child.text]));
        if (name === "taskget" || name === "tasklist") {
          const tasks = response.tasks ?? (response.task ? [response.task] : response.id ? [response] : []);
          if (Array.isArray(tasks)) for (const task of tasks) {
            if (task && typeof task === "object") applyTask({ ...call, input: { ...task, taskId: task.id ?? task.taskId } }, false);
          }
        }
        if (name === "taskoutput" || name === "taskstop") {
          const nativeId = str(call.input.task_id ?? response.task?.task_id);
          const row = [...rows.values()].find((candidate) => candidate.sessionId === item.sessionId && candidate.kind === "agent" && candidate.nativeId === nativeId);
          const status = name === "taskstop" ? "stopped" : workStatus(response.task?.status ?? /<status>([^<]+)<\/status>/.exec(activity.result)?.[1]);
          if (row && status !== "unknown") {
            const text = extracted.get(nativeId)
              ?? (str(response.task?.output) || /<output>([\s\S]*?)<\/output>/.exec(activity.result)?.[1] || activity.result);
            put(row.id, { status, result: text });
            textOrigins.set(`${row.id}\u0000result`, key(activity.id));
            textVersions.set(`${row.id}\u0000result`, activity.id);
            pendingRoutes.push({ from: key(activity.id), targets: [{ rowId: row.id, text }] });
          }
        }
        const states = response.status ?? response.statuses;
        if (states && typeof states === "object") {
          const routed: { rowId: string; text: string }[] = [];
          for (const [nativeId, state] of Object.entries(states)) {
            const value = typeof state === "object" && state ? state as Record<string, unknown> : {};
            const status = workStatus(Object.keys(value)[0] ?? state);
            const text = extracted.get(nativeId) ?? str(value.completed ?? value.errored ?? value.error);
            put(key(nativeId), { nativeId, status, result: text });
            if (text) {
              textOrigins.set(`${key(nativeId)}\u0000result`, key(activity.id));
              textVersions.set(`${key(nativeId)}\u0000result`, activity.id);
              routed.push({ rowId: key(nativeId), text });
            }
          }
          pendingRoutes.push({ from: key(activity.id), targets: routed });
        }
        if (name === "close_agent") {
          const id = key(str(call.input.id));
          const previous = rows.get(id);
          if (previous?.status !== "completed" && previous?.status !== "failed") put(id, { status: "stopped" });
        }
      }
    }
  }
  for (const route of pendingRoutes) routeResultImages(route.from, route.targets);
  const withMeta = (row: NativeWorkItem): NativeWorkItem => {
    const pick = (field: "message" | "result"): AttachmentSource[] | undefined => {
      const slot = `${row.id}\u0000${field}`;
      const list = metaImages.get(slot);
      if (!list?.length) return undefined;
      // 槽里这组记录的来源文档必须就是「这段正文的写入者」:正文由别的文档(更晚的直写/
      // 另一次调用)给出时,老来源留下的记录说的是另一版正文 —— 宁可不配(第 10 轮审查 R2
      // legacyRouteOvertakes)。行自己名下的记录(直写、搬家改签过的)天然同源,放行。
      const origin = textOrigins.get(slot);
      if (origin !== undefined && list[0]!.from !== origin && list[0]!.from !== row.id) return undefined;
      // 协议身份按快照契约核对(shared 的 sameSnapshotIdentity,严格口径):快照式图片记录
      // 全部产自契约之后 —— 记录带身份就必须对上正文身份,正文没身份时带身份的记录属于别的
      // 代;「缺身份放行」只留给记录自己没身份的那一代(第 10 轮审查 R2;审查第 1 轮 R1)。
      const version = textVersions.get(slot);
      const current = list.filter((record) => sameSnapshotIdentity(record.version, version, true));
      if (!current.length) return undefined;
      // 只认最高代:正文清场/换稿之后,旧代记录说的是已经不在屏幕上的那一版。
      const top = Math.max(...current.map((record) => record.rev));
      return current.filter((record) => record.rev === top).map((record) => record.src);
    };
    const message = pick("message");
    const result = pick("result");
    if (!message && !result) return row;
    return { ...row, ...(message ? { messageImages: message } : {}), ...(result ? { resultImages: result } : {}) };
  };
  // Parent lifecycle cannot prove the final state of independently running children.
  return [...rows.values()].map(withMeta).map((row) => {
    if (row.status !== "running" && row.status !== "pending") return row;
    if (taskStatus === "canceled" || taskStatus === "paused") return { ...row, status: "unknown", message: row.message || "主任务已停止或暂停，未收到此项最终状态。" };
    if ((taskStatus !== "running" && taskStatus !== "queued") || endedRows.has(row.id)) return { ...row, status: "unknown", message: row.message || "会话已结束，未收到此项最终状态。" };
    return row;
  });
}
