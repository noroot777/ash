// Claude CLI 的 stream-json 输出 → AgentEvent 流。
//
// 从 claude.ts 拆出来(2026-09-24):那边是「怎么把 CLI 拉起来」(settings、供应商注入、
// spawn、常驻会话),这边是「CLI 吐出来的东西怎么读」——两件事各自都在往 700 行的上限
// 上顶,合在一份里每次改都要把整份塞进上下文。导出的名字一个没变,claude.ts 原样
// re-export,复用这份解析的第三方 CLI(executors/catalog/parsers.ts)照旧从 claude.js 取。
import { createInterface } from "node:readline";
import type { AgentEvent, AgentType } from "@ash/shared";
import { guessContextWindow } from "@ash/shared/usage";
import { NativeWorkTrace } from "./native-work.js";
import { childActivity } from "./native-agent-activity.js";
import { NativeActivityBuffer } from "./native-activity-buffer.js";
import { spawnAgent, spawnErrorMessage, forceFinishOnExit } from "./spawn.js";
import { calibrateSkills } from "../skills.js";
import { persistMarkdownImages, persistToolResultImages } from "../agent-attachments.js";
import { ClaudeControlBridge } from "./claude-control.js";
import { normalizeClaudeCliError, shortJson, claudeContextUsed, claudeContextWindow, claudeUsage } from "./claude-metadata.js";

// resident 非空 = 常驻模式:`result` 行只代表「一个回合说完了」(→ turnEnd),
// 流要一直开着;只有进程真的没了才 done。
// bin 只影响 spawn 报错文案 —— 导出是为了让目录里「输出格式跟 claude 一致」的
// CLI(stream-json 的 --output-format)直接复用这一份解析,不必各写一遍。
// calibrateAs:只有**确知自己是哪种 CLI 的进程**才传(见下面 init 分支)。
// 复用这份 parser 的第三方 CLI 一律不传 —— 它们的技能名跟 claude 的不是一回事,
// 拿 bin 名去猜会把别人的技能塞进 claude 的缓存。
export async function* parseClaudeStream(
  child: ReturnType<typeof spawnAgent>,
  resident?: ClaudeControlBridge,
  bin = "claude",
  calibrateAs?: AgentType,
  compactWindow: number | null = null,
  onInitialized: () => void = () => {},
  waitNoticeMs = 5 * 60_000,
): AsyncIterable<AgentEvent> {
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  const activityBuffer = new NativeActivityBuffer();
  const push = (e: AgentEvent) => {
    const events = activityBuffer.push(e);
    if (!events.length) return;
    queue.push(...events);
    resolve?.();
    resolve = null;
  };

  // Coalesce token-level text_delta into small chunks: flush on a newline or once
  // ~40 chars have accrued, so the client streams smoothly without a re-render per
  // character (a long reply would otherwise fire thousands of setStates). The
  // chunks concatenate downstream with no separator, so the joined text is exactly
  // the model's output. With partial streaming ON, the complete `assistant`
  // message that trails the deltas is used ONLY for tool_use — replaying its text
  // would duplicate everything the deltas already streamed.
  let textBuf = "";
  const flushText = () => {
    if (textBuf) {
      push({ kind: "text", text: textBuf });
      textBuf = "";
    }
  };

  // 上下文水位。**只有 `assistant` 事件里的 `message.usage` 是单次 API 调用的快照**
  // —— 收尾的 `result` 行是整回合累加(几十次调用相加,长会话能到千万级),拿它当水位
  // 会得出「上下文爆了 50 倍」。所以在这里逐条记下最新一次调用的输入规模,回合结束
  // 时发一条 context 事件。窗口(分母)反过来只有 `result` 行有,见 claudeContextWindow。
  let contextUsed = 0;
  let contextModel: string | null = null;
  const seenImages = new Set<string>();
  const childImages = new Map<string, Set<string>>();
  const nativeWork = new NativeWorkTrace();

  const rl = createInterface({ input: child.stdout! });

  // 「在等上游回话」等到什么份上就该说一声。CLI 发请求时给一条 status:"requesting",
  // 之后连接要是挂住,那就是**彻底的静默**:不重试、不报错、一个事件都没有
  // (2026-09-24:中转网关上单次请求挂了 47 分钟,回合从头到尾零事件)。上面那条
  // api_retry 救不了这种 —— 它压根没重试过。
  //
  // 判据必须钉死在「最后一件事是在等 API」上,不能只看「多久没有事件」:工具在跑
  // (pytest 跑上半小时)同样一个事件都不发,那是活儿正常在干,报出来纯属误报。收到
  // 任何别的事件就立刻解除等待 —— 上游一开口,requesting 后面马上跟着 message_start。
  //
  // 落成**持久 system 注记**而不是 `kind:"error"`:这类「回合正常着,只是在等」的信号
  // 跟本回合成败正交,塞进 error 的代价见 session-notice.ts 顶部 —— 时间线上渲染成红色
  // 异常、执行过程计入异常数,duet 更是直接 `failed()` 掉整场讨论(第 1 轮审查 P1/P2)。
  // system 这条路三条消费链(single-run / team / duet)都已经当旁注收。
  let awaitingSince: number | null = null;
  let waitNoticed = 0;
  const waitTimer = setInterval(() => {
    if (finished || awaitingSince === null) return;
    const waited = Date.now() - awaitingSince;
    const due = Math.floor(waited / waitNoticeMs);
    if (due <= waitNoticed) return; // 每满一个间隔才报一次,别把静默刷成滚屏
    waitNoticed = due;
    push({
      kind: "system",
      text: `已经等上游 ${Math.max(1, Math.round(waited / 60_000))} 分钟没有响应，本回合仍在等待中`,
      at: new Date().toISOString(),
      level: "notice",
    });
  }, Math.max(1_000, Math.floor(waitNoticeMs / 10)));
  waitTimer.unref?.(); // 心跳不能拖着进程不让退
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      return;
    }
    // requesting 与 api_retry **都算「正在等上游回话」**:真实序列是一次 requesting 之后
    // 连着若干条 api_retry,中间不再有新的 requesting。把 retry 当「别的事件」解除等待,
    // 等于第一次失败之后心跳就永久熄火,而那之后每一次重试请求同样可能挂住(第 1 轮
    // 审查 P2)。每收到一条就重新起算 —— 那本来就是新一次「发出去等回话」。
    const waiting = ev?.type === "system"
      && (ev.subtype === "api_retry" || (ev.subtype === "status" && ev.status === "requesting"));
    if (waiting) {
      awaitingSince = Date.now();
      waitNoticed = 0;
    } else {
      awaitingSince = null;
    }
    for (const activity of nativeWork.claudeMessage(ev)) push(activity);
    if (ev.parent_tool_use_id) {
      const images = childImages.get(ev.parent_tool_use_id) ?? new Set<string>();
      childImages.set(ev.parent_tool_use_id, images);
      for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (block.type === "tool_result") {
          for (const path of persistToolResultImages(block.content, images)) push(childActivity(ev.parent_tool_use_id, { kind: "attachment", path }));
        } else if (block.type === "text" && typeof block.text === "string") {
          for (const path of persistMarkdownImages(block.text, images)) push(childActivity(ev.parent_tool_use_id, { kind: "attachment", path }));
        }
      }
      return;
    }
    if (ev.type === "control_response") {
      resident?.handleResponse(ev);
      return;
    }
    if (ev.type === "stream_event") {
      const se = ev.event;
      if (se?.type === "content_block_delta" && se.delta?.type === "text_delta" && se.delta.text) {
        textBuf += se.delta.text;
        if (textBuf.length >= 40 || textBuf.includes("\n")) flushText();
      }
      return; // deltas drive the live stream; the trailing complete message handles tools
    }
    if (ev.type === "system" && ev.session_id) {
      if (ev.subtype === "init") onInitialized();
      // init 事件白送一份**权威**技能清单(skills / slash_commands / cwd 都在里面),
      // 顺手校准 skills 模块的扫描结果 —— 这是唯一不用额外起一个 CLI 进程就能拿到
      // 「这个 CLI 自己认哪些技能」的机会,别浪费。纯旁路:失败也不能影响事件流。
      if (calibrateAs && ev.subtype === "init" && typeof ev.cwd === "string") {
        try {
          calibrateSkills(calibrateAs, ev.cwd, ev.skills, ev.slash_commands);
        } catch {
          /* 校准是锦上添花,坏了就还用扫描结果 */
        }
      }
      // 压缩(手动 `/compact` 与自动压缩)的过程和成败**只在这条 status 事件里**。
      // 不接住它的代价是压缩失败**看上去和成功一模一样**:收尾的 `result` 照样是
      // `subtype:"success"` + `is_error:false` + 退出码 0,任务状态不动,时间线上只多
      // 出 CLI 合成的一句英文 —— 而压缩失败恰恰是最要紧的一种失败:上下文原地不动,
      // 下一句话照样撞「Prompt is too long」(2026-08-13 实测:中转网关连着三次 503,
      // 手动 `/compact` 和自动压缩都没压成,用户只能得出「这个系统的 /compact 坏了」)。
      // 所以这里把结论抬成显式事件:失败 → error(执行诊断块 + trace + SSE),开始/成功
      // → 一行正文。三者都只管展示,不碰任务状态(原生命令本来就走旁路回合)。
      if (ev.subtype === "status") {
        if (typeof ev.compact_result === "string") {
          if (ev.compact_result === "failed") {
            const detail = typeof ev.compact_error === "string" && ev.compact_error.trim()
              ? ev.compact_error.trim()
              : "CLI 没有给出原因";
            push({
              kind: "error",
              message: `上下文压缩失败，会话大小原地不动：${detail}`,
              affectsTurn: false,
            });
          } else {
            push({ kind: "text", text: "\n> 上下文已压缩。\n\n" });
          }
        } else if (ev.status === "compacting") {
          push({ kind: "text", text: "\n> 正在压缩上下文…\n\n" });
        }
      }
      // 上游重试是 CLI 唯一一次说出「不是我卡住了,是上游不给响应」。不接住它,重试和
      // 正常思考在界面上长得一模一样:只有一句「智能体委派中」停在那,而退避到后面单次
      // 就要等半分钟,一轮十次足够把回合拖上三刻钟(2026-09-24:中转网关先 502 再整个不
      // 响应,两个任务各停了 47 分钟,用户无从判断,只能靠重启 ash 试探问题在哪 ——
      // 重启其实也救不了,恢复靠的是 CLI 自己重试成功)。所以每一次重试都抬成一条旁注:
      // 它同时是「还活着」的心跳,重试间隔本来就是分钟级,不会刷屏。
      // 走 system 注记而不是 error:重试期间回合仍然正常进行中,理由同上面 waitTimer 那段。
      // 真的重试耗尽,收尾的 result / synthetic 消息会照旧把失败报成 error。
      if (ev.subtype === "api_retry") {
        const attempt = Number(ev.attempt) || 0;
        const max = Number(ev.max_retries) || 0;
        const status = Number(ev.error_status) || 0;
        // error 常常就是字符串 "unknown"(连接挂住、没有响应体),那时它不比「没有响应」
        // 多说什么,别原样抬给用户看。
        const reason = typeof ev.error === "string" && ev.error.trim() && ev.error !== "unknown" ? ev.error.trim() : "";
        const cause = status
          ? `上游返回 ${status}${reason ? ` ${reason}` : ""}`
          : reason ? `上游报 ${reason}` : "上游没有响应";
        const wait = Number(ev.retry_delay_ms) || 0;
        const parts: string[] = [];
        if (attempt) parts.push(max ? `第 ${attempt}/${max} 次` : `第 ${attempt} 次`);
        if (wait) parts.push(`等 ${wait >= 1000 ? `${Math.round(wait / 1000)} 秒` : `${(wait / 1000).toFixed(1)} 秒`}`);
        push({
          kind: "system",
          text: `${cause}，正在重试${parts.length ? `（${parts.join("，")}）` : ""}`,
          at: new Date().toISOString(),
          level: "notice",
        });
      }
      push({ kind: "session", cliSessionId: ev.session_id });
    } else if (ev.type === "assistant" && ev.message?.content) {
      flushText(); // settle this message's text-delta tail before its tools
      // 这一次 API 调用装了多少进模型 = 上下文水位(见上面 contextUsed 的注释)。
      // 合成消息不是真调用,它的 usage 不代表上下文,跳过。
      if (ev.message.model && ev.message.model !== "<synthetic>") {
        contextModel = ev.message.model;
        const snapshot = claudeContextUsed(ev.message.usage);
        if (snapshot > 0) contextUsed = snapshot;
      }
      // CLI 本地合成的消息(model `<synthetic>`:模型不存在 / 鉴权失败 / 限流等)
      // **不经过 delta 流** —— 它是 CLI 自己拼出来的,不是模型吐的。所以这一类的
      // text 必须照收,跳过就等于把唯一一句错误说明扔了(见 docs/incidents.md
      // 「空白回合」:404 model_not_found 整个被吞,用户只看到任务停着不动)。
      const synthetic = ev.message.model === "<synthetic>";
      let hadText = false;
      for (const block of ev.message.content) {
        if (block.type === "text") {
          hadText = true; // 真模型的 text 已经由 deltas 流过 —— 不要再 push 一遍
          if (synthetic && block.text) push({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") push(nativeWork.call(block.name, block.input, block.id)
          ?? { kind: "tool", name: block.name, detail: shortJson(block.input) });
      }
      if (hadText) push({ kind: "text", text: "\n\n" }); // paragraph break, identical live & on reload
      for (const block of ev.message.content) {
        if (block.type !== "text" || typeof block.text !== "string") continue;
        for (const path of persistMarkdownImages(block.text, seenImages)) push({ kind: "attachment", path });
      }
    } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      flushText();
      for (const block of ev.message.content) {
        if (block?.type !== "tool_result") continue;
        const activity = nativeWork.result(block.tool_use_id, block.content, block.is_error === true);
        if (activity) push(activity);
        for (const path of persistToolResultImages(block.content, seenImages)) push({ kind: "attachment", path });
      }
    } else if (ev.type === "result") {
      flushText();
      if (ev.session_id) push({ kind: "session", cliSessionId: ev.session_id });
      const usage = claudeUsage(ev);
      if (usage) push({ kind: "usage", usage });
      // 水位跟着流水一起发。模型窗口仍优先用 claude 自报的(1M 只有那儿认得出),
      // 但执行器若显式配了自动压缩窗口就另带 compactWindow：模型能力与“先在哪压缩”
      // 是两层数据，界面拿后者算真正的剩余量，不能为了显示 400k 把 1M 上限抹掉。
      if (contextUsed > 0) {
        const model = contextModel ?? ev.model ?? null;
        const reported = claudeContextWindow(ev, model);
        const window = reported ?? guessContextWindow(model);
        push({
          kind: "context",
          context: {
            used: contextUsed,
            window,
            windowEstimated: reported === null && window !== null,
            ...(compactWindow !== null ? { compactWindow } : {}),
          },
        });
      }
      // 我们自己发的 interrupt 会把本回合收成 error_during_execution —— 那是
      // 「用户插话打断」的预期结果,不是故障,不报错。只吞掉紧跟其后的那一个
      // result(标志立即清掉),所以最坏情况也只影响一个回合的错误上报。
      const ownInterrupt = resident?.interruptPending === true;
      if (resident) resident.interruptPending = false;
      // claude CLI 把 **API 层**的失败(404 模型不存在、401、限流…)报成
      // `subtype:"success"` + `is_error:true` + `api_error_status` —— 只看 subtype
      // 会把它整条判成正常结束。两路判据都要算上,否则回合「成功」但一个字没说。
      const apiError = ev.is_error === true || typeof ev.api_error_status === "number";
      if (((ev.subtype && ev.subtype !== "success") || apiError) && !ownInterrupt) {
        // CLI **自己**失败时(会话找不到、启动期崩)`result` 是空的,原因只在
        // `errors[]` 里。不读它就只剩一句 `result: error_during_execution`——用户看不出
        // 发生了什么,`session-lost.ts` 那条「no conversation found」的识别也永远匹配不上,
        // 一条已经失效的 --resume 会被一路重试到底。
        const errors = Array.isArray(ev.errors)
          ? ev.errors.filter((e: unknown): e is string => typeof e === "string" && e.trim() !== "")
          : [];
        const detail = typeof ev.result === "string" && ev.result.trim()
          ? ev.result.trim()
          : errors.length ? errors.join("; ") : `result: ${ev.subtype}`;
        push({
          kind: "error",
          message: ev.api_error_status ? `HTTP ${ev.api_error_status}: ${detail}` : detail,
        });
      }
      // 常驻:回合说完了,进程还活着等下一条消息 —— 流不结束。
      if (resident) push({ kind: "turnEnd" });
      seenImages.clear();
      childImages.clear();
    }
  });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (finished) return;
    resident?.failPending(new Error(`Claude 进程错误：${err.message}`));
    push({ kind: "error", message: spawnErrorMessage(bin, err) });
    push({ kind: "done", exitStatus: 1 });
    finished = true;
    resolve?.();
    resolve = null;
  });
  child.on("close", (code) => {
    if (finished) return;
    resident?.failPending(new Error("Claude 进程在 interrupt ACK 前退出"));
    flushText(); // emit any text tail that never hit the flush threshold
    const exit = code ?? 0;
    if (exit !== 0 && stderr.trim()) push({ kind: "error", message: normalizeClaudeCliError(stderr).slice(0, 2000) });
    push({ kind: "done", exitStatus: exit });
    finished = true;
    resolve?.();
    resolve = null;
  });
  forceFinishOnExit(child, () => finished, (exit) => {
    resident?.failPending(new Error("Claude 进程在 interrupt ACK 前异常收尾"));
    flushText();
    push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
    push({ kind: "done", exitStatus: exit });
    finished = true;
    resolve?.();
    resolve = null;
  });

  // finally 而不是逐条终止路径里 clear:消费方提前 break(用户停任务)一样走得到这里。
  try {
    while (true) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (finished) return;
      await new Promise<void>((r) => (resolve = r));
    }
  } finally {
    clearInterval(waitTimer);
  }
}
