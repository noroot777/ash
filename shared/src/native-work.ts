export type NativeWorkStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "unknown";

export function nativeWorkStatus(value: unknown): NativeWorkStatus {
  const name = typeof value === "string" ? value.replace(/[_ -]/g, "").toLowerCase() : "";
  if (["completed", "complete", "done", "success"].includes(name)) return "completed";
  if (["running", "inprogress", "working"].includes(name)) return "running";
  if (["pending", "queued", "spawned", "initializing", "pendinginit"].includes(name)) return "pending";
  if (["failed", "error", "errored", "notfound"].includes(name)) return "failed";
  if (["stopped", "closed", "shutdown", "cancelled", "canceled", "interrupted", "deleted"].includes(name)) return "stopped";
  return "unknown";
}

export type NativeAgentActivity =
  | { kind: "text" | "thinking"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "error"; message: string }
  // source/ref/path 的语义见 shared/src/events.ts 的同名字段(子智能体那一层同样要带:
  // 抽屉里的正文跟主会话走同一套配对,少一个字段就配不上)。
  // `field` = 这条记录属于哪份**快照式**正文:子智能体的 message / 返回结果 result(它们
  // 不是执行记录那份追加式文档,配对各归各,见 server 的 markdown-image-meta.ts)。
  // `rev` = 快照式正文的第几**代**(turn/started 清场、或已交代后换稿,都开新一代):展示端
  // 只认最高代的那组记录 —— 正文已经换稿,旧代的冻结说的是已经不在屏幕上的那一版。
  // `version` = 记这笔账时正文的**协议身份**(message 的 messageId / result 的调用 id)。
  // 展示端两边都带身份时必须一致才配对:同文同代都证明不了同一份快照 —— 两条独立消息
  // 恰好同文时,旧身份的冻结配给新话就是把旧字节安在新画面上(第 10 轮审查 R2)。
  | { kind: "attachment"; path?: string; source?: string; ref?: number; pos?: number; lost?: boolean; field?: "message" | "result"; rev?: number; version?: string };

export type NativeWorkEvent = (
  | { type: "activity"; id: string; event: NativeAgentActivity }
  | { type: "call"; id: string; parentId?: string; name: string; input: Record<string, unknown> }
  | { type: "result"; id: string; result: string; failed: boolean }
  // model/effort 是子智能体**实跑**的档位；requested* 是派活那一刻调用方点的名（可能被执行器改掉）。
  // messageId:这份 message 快照在原生协议里的身份(codex 的 item.id)。两条**不同**的完整
  // 消息哪怕后一条是前一条的文字延长,也是两份独立快照 —— 文字前缀不能证明同一份正文,
  // 图片账据此换代重拍(第 9 轮复审 R1 distinctPrefixMessages)。
  | { type: "agent"; id: string; nativeId?: string; parentId?: string; title?: string; description?: string;
      status: NativeWorkStatus; closed?: boolean; message?: string; messageId?: string; result?: string;
      model?: string; requestedModel?: string; effort?: string; requestedEffort?: string; agentType?: string }
) & { at?: string };

/**
 * 结构化结果里各子智能体的正文(wait 的 status/statuses、taskoutput/taskstop 的
 * <output>/task.output)。服务端图片捕获与前端展示**共用这一份提取**:两边各写一遍的话,
 * 服务端按原始 JSON 字符串扫出的坐标与转义在解码后的展示正文里对不上 —— title 带引号的
 * 图在原始包装里连图片节点都不是,一个字节都没冻结(第 9 轮复审 R1 encodedMarkdown)。
 * taskoutput 沿用展示端的门:状态认不出(unknown)就不算提取成功。
 */
export function childResultTexts(
  name: string | undefined,
  input: unknown,
  result: string | undefined,
): { id: string; text: string }[] {
  if (!result) return [];
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  let response: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(result) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) response = parsed as Record<string, unknown>;
  } catch { /* 不是 JSON:XML 形态走下面的正则 */ }
  const leaf = (name ?? "").split(/[./]/).at(-1)!.toLowerCase();
  const out: { id: string; text: string }[] = [];
  if (leaf === "taskoutput" || leaf === "taskstop") {
    const task = (response.task && typeof response.task === "object" ? response.task : {}) as Record<string, unknown>;
    const id = str((input as Record<string, unknown> | undefined)?.task_id ?? task.task_id);
    const status = leaf === "taskstop" ? "stopped"
      : nativeWorkStatus(str(task.status) || /<status>([^<]+)<\/status>/.exec(result)?.[1]);
    const text = str(task.output) || /<output>([\s\S]*?)<\/output>/.exec(result)?.[1] || result;
    if (id && status !== "unknown" && text) out.push({ id, text });
  }
  const states = response.status ?? response.statuses;
  if (states && typeof states === "object") {
    for (const [id, state] of Object.entries(states as Record<string, unknown>)) {
      const value = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
      const text = str(value.completed ?? value.errored ?? value.error);
      if (text) out.push({ id, text });
    }
  }
  return out;
}

export function isVisibleExecutionEvent(event: { nativeWork?: NativeWorkEvent }): boolean {
  return !event.nativeWork || (event.nativeWork.type === "call" && !event.nativeWork.parentId);
}

/**
 * 正文快照的身份转移 —— 生产(meta 记账)、恢复(seed/merge)、展示(nativeWorkModel)三侧
 * 唯一的一份规则(审查第 1 轮 R1:正文与身份是同一份快照,替换正文必须连身份一起替换):
 *   · 新事件自带身份 → 换成新身份;
 *   · 没带身份、正文是前缀延续(流式增量、同文重放)→ 还是同一份快照在长大,身份沿用;
 *   · 没带身份、整段改写或清场 → 新稿没有身份 —— 旧身份不许留下来给新稿背书。
 */
export function snapshotVersion(
  prev: { text: string; version?: string },
  text: string,
  version?: string,
): string | undefined {
  if (version !== undefined) return version;
  return text.startsWith(prev.text) ? prev.version : undefined;
}

/**
 * 一条记录(账本行、交代事件、展示端的图片记录)与正文是否同一份快照。
 *
 * `strict` = 这条记录产自快照契约生效之后(带指纹的账本行、带 field 的交代事件/记录):
 * 记录带身份就必须对上正文身份 —— 正文没身份时,带身份的记录一定属于别的代;记录不带
 * 身份的(那一代协议真没给)放行,交给指纹与节点核对兜底。非 strict 只给**老数据**(没
 * 指纹的旧账):缺身份放行是它的显式兼容口径,不是新事件的通行证(审查第 1 轮 R1)。
 */
export function sameSnapshotIdentity(
  record: string | undefined,
  body: string | undefined,
  strict: boolean,
): boolean {
  if (record === undefined) return true;
  if (body === undefined) return !strict;
  return record === body;
}
