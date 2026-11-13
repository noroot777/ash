// Claude CLI 的 stream-json 输出 → AgentEvent 流。
//
// 从 claude.ts 拆出来(2026-09-24):那边是「怎么把 CLI 拉起来」(settings、供应商注入、
// spawn、常驻会话),这边是「CLI 吐出来的东西怎么读」——两件事各自都在往 700 行的上限
// 上顶,合在一份里每次改都要把整份塞进上下文。导出的名字一个没变,claude.ts 原样
// re-export,复用这份解析的第三方 CLI(executors/catalog/parsers.ts)照旧从 claude.js 取。
import { createInterface } from "node:readline";
import type { AgentEvent, AgentType } from "@ash/shared";
import { type CompactSnapshot, guessContextWindow } from "@ash/shared/usage";
import { NativeWorkTrace } from "./native-work.js";
import { childActivity } from "./native-agent-activity.js";
import { ClaudeWriteLedger, soleReceipt } from "./tool-writes.js";
import { NativeActivityBuffer } from "./native-activity-buffer.js";
import { spawnAgent, spawnErrorMessage, forceFinishOnExit } from "./spawn.js";
import { calibrateSkills } from "../skills.js";
import { imageStore, persistToolResultImages, type ImageStore } from "../agent-attachments.js";
import { eventQueue } from "./event-queue.js";
import { markdownImageSink, settleMarkdownImages, type MarkdownImageAccounting, type MarkdownImageSink } from "./markdown-image-stream.js";
import { ClaudeControlBridge } from "./claude-control.js";
import { ClaudeBackgroundTrace } from "../claude-background-reaped.js";
import { ClaudeMonitorTrace } from "../claude-monitors.js";
import { runOriginOfChild } from "../claude-monitor-origin.js";
import { consumedEvents, holdSince, startsTurn } from "./claude-recovery.js";
import type { ConsumedOutput } from "./types.js";
import { claudeRetryMessage, isClaudeRetry } from "./claude-retry-notice.js";
import { normalizeClaudeCliError, shortJson, claudeContextUsed, claudeContextWindow, claudeUsage } from "./claude-metadata.js";
import { ClaudeRequestTimer } from "./request-timing.js";
import { claudeApiStatus, modelFailureOf } from "./model-failure.js";

// resident 非空 = 常驻模式:`result` 行只代表「一个回合说完了」(→ turnEnd),
// 流要一直开着;只有进程真的没了才 done。
// bin 只影响 spawn 报错文案 —— 导出是为了让目录里「输出格式跟 claude 一致」的
// CLI(stream-json 的 --output-format)直接复用这一份解析,不必各写一遍。
// calibrateAs:只有**确知自己是哪种 CLI 的进程**才传(见下面 init 分支)。
// 复用这份 parser 的第三方 CLI 一律不传 —— 它们的技能名跟 claude 的不是一回事,
// 拿 bin 名去猜会把别人的技能塞进 claude 的缓存。
export function parseClaudeStream(
  child: ReturnType<typeof spawnAgent>,
  resident?: ClaudeControlBridge,
  bin = "claude",
  calibrateAs?: AgentType,
  // 产出这条流的那个进程**起跑时**的压缩配置(shared CompactSnapshot)。由起跑方算好传进来,
  // 接管时传会话存下的那份 —— 这里只负责原样带在每条水位上,不自己去读配置。
  compact: CompactSnapshot | null = null,
  onInitialized: () => void = () => {},
  waitNoticeMs = 5 * 60_000,
  // 这条流属于哪条 CLI 会话。**接管路径必须传**：接管是从已消费的 offset 之后接着读的,
  // `init` 早在上一轮就消费掉了,不会再来一次,靠等 system 事件设身份会一直等不到
  // (见 ../claude-monitors.ts 构造函数的说明)。新开的流可以不传,init 会带来。
  cliSessionId?: string,
  // 这条会话干活的目录。正文里 `![](output/x.png)` 这种**相对路径**要靠它解成真文件
  // 才复制得进 uploads —— 不传的话那张图在对话里只会是个裂开的图标(见
  // ../agent-attachments.ts 与下面这一层)。
  cwd?: string,
  // 正文图片的持久账本/身份种子(RunOpts.images),见 markdown-image-stream.ts。
  accounting?: MarkdownImageAccounting,
  // 接管时上一个 ash 进程已经消费掉的那段原始输出(文件 + 字节水位)。先静音重放一遍,接回的
  // 状态才和不间断执行一致,见 ./claude-recovery.ts。
  consumed?: ConsumedOutput,
): AsyncIterable<AgentEvent> {
  // 正文里的图**不在这份解析里收**:它要按「一份文档」认身份,而这里一条模型消息就是
  // 一片碎片 —— 上一条消息给定义、下一条引用它时,按消息扫压根不认那张图(审查第 4 轮
  // R2)。父会话与每个子智能体各一笔账,统一由这一层记(见 markdown-image-stream.ts)。
  //
  // **账记在 push 处,不是记在下游**:下面那个 `queue` 是先攒着的,挂在消费者取事件那一刻
  // 等于把「读文件」推迟到整条队列之后,中间 agent 完全来得及把同一个路径重拍一遍(审查
  // 第 5 轮 R1)。所以 sink 在这里建好传进去,由 push 同步进账,这一层只负责收口。
  const images = markdownImageSink(cwd, accounting);
  return settleMarkdownImages(
    claudeStreamEvents(child, resident, bin, calibrateAs, compact, onInitialized, waitNoticeMs, images, cliSessionId, cwd, consumed),
    images,
  );
}

async function* claudeStreamEvents(
  child: ReturnType<typeof spawnAgent>,
  resident: ClaudeControlBridge | undefined,
  bin: string,
  calibrateAs: AgentType | undefined,
  compact: CompactSnapshot | null,
  onInitialized: () => void,
  waitNoticeMs: number,
  images: MarkdownImageSink,
  cliSessionId?: string,
  cwd?: string,
  consumed?: ConsumedOutput,
): AsyncIterable<AgentEvent> {
  // 队列、唤醒、收尾、增量合并、子活动合并和**图片记账的时点**都在这条共用流水线里
  // (见 event-queue.ts)。顺序是硬要求:字节在 `delta`/`push` 的那一刻就冻住,交代排在
  // 合并与队列之后 —— 挂反了,正文写着「修改前是红色」就会存成后来那张蓝图(审查第 5 轮
  // R1、第 6 轮 R1:短子正文滞留在 40 字合并缓冲里,期间父步骤把文件重拍了)。
  //
  // Coalesce token-level text_delta into small chunks: flush on a newline or once
  // ~40 chars have accrued, so the client streams smoothly without a re-render per
  // character (a long reply would otherwise fire thousands of setStates). The
  // chunks concatenate downstream with no separator, so the joined text is exactly
  // the model's output. With partial streaming ON, the complete `assistant`
  // message that trails the deltas is used ONLY for tool_use — replaying its text
  // would duplicate everything the deltas already streamed.
  const events = eventQueue({ images, activity: new NativeActivityBuffer(), coalesce: { text: 40 } });
  // 重放水位之前那段输出时(见下面 `consumed`)一律静音:那些话上一个 ash 进程已经说过了。
  // 只有最后一个回合结尾推出的那几条要留着 —— 它们决定接回之后收不收台,见 `ending`。
  let replaying = false;
  let ending: AgentEvent[] | null = null;
  let capturing = false;
  const push = (event: AgentEvent) => {
    if (!replaying) events.push(event);
    else if (capturing) ending?.push(event);
  };
  const flushText = () => events.flush();

  // 上下文水位。**只有 `assistant` 事件里的 `message.usage` 是单次 API 调用的快照**
  // —— 收尾的 `result` 行是整回合累加(几十次调用相加,长会话能到千万级),拿它当水位
  // 会得出「上下文爆了 50 倍」。所以在这里逐条记下最新一次调用的输入规模,回合结束
  // 时发一条 context 事件。窗口(分母)反过来只有 `result` 行有,见 claudeContextWindow。
  let contextUsed = 0;
  let contextModel: string | null = null;
  const seenImages: ImageStore = imageStore();
  // 写文件调用要等结果没报错才算写过（见 tool-writes.ts），主会话与子智能体共用这一本。
  const writeLedger = new ClaudeWriteLedger(cwd);
  const childImages = new Map<string, ImageStore>();
  const nativeWork = new NativeWorkTrace();
  // 上一条 result 之后主智能体说过话没有。孤儿回执与「完成通知自己开的一回合」都带
  // `origin:task-notification`,分得开它们的只有这一条(见 result 分支)。
  let turnSpoke = false;
  // claude 自带 `Monitor` 工具的只读投影（见 ../claude-monitors.ts）。放在这一层的理由：
  // 认人要同时看 tool_use 块（工具名）和 system 事件（后台任务生命周期），只有这里两样
  // 都流过。整条链 fire-and-forget，记账失败不影响事件流。
  //
  // **来源身份在这里就绑定**：这条 stdout 就是那个 agent 进程写的，它的那组落盘路径就是
  // 这一代的 run 文件 —— 两样都从 child 直接拿，不经过 `sessions` 那几列（每回合被下一轮
  // 覆盖，落库排在队列上，晚一步读到的就是下一代人的凭据，于是上一轮早结束的监听被新进程
  // 续命成「正在盯着」；整段在 ../claude-monitor-origin.ts 的文件头）。
  const claudeMonitors = new ClaudeMonitorTrace(cliSessionId, runOriginOfChild(child));
  // 后台子代理 / 后台 Bash 的同类账本：认人同样要 tool_use、tool_result、system 三样一起看。
  // 它们随回合收尾被收走时在时间线上留一笔（见 ../claude-background-reaped.ts）。
  const background = new ClaudeBackgroundTrace(cliSessionId);
  // 每次模型请求的起止(见 ./request-timing.ts),随回合的 usage 带出去。
  const requestTimer = new ClaudeRequestTimer();
  // 接管时读不出水位之前那段:后台还有没有活、回合在不在进行,一概说不准(见 ./claude-recovery.ts)。
  // 回合结尾一律按「可能还有」先不收台,等到期限按未完成结算 —— 不能拿空账本判「没有后台工作」。
  let recoveryUnknown = false;
  const outPath = (child as { ashPaths?: { out?: string } }).ashPaths?.out;
  // 单飞判「后台超时/丢失」前要核对的就是这本实时账(见 singleRunFromResident)。
  if (resident) resident.backgroundPending = () => ({ ...background.waiting(), ...(recoveryUnknown ? { unknown: true as const } : {}) });

  // 「在等上游回话」等到什么份上就该说一声。CLI 发请求时给一条 status:"requesting",
  // 之后连接要是挂住,那就是**彻底的静默**:不重试、不报错、一个事件都没有
  // (2026-09-24:中转网关上单次请求挂了 47 分钟,回合从头到尾零事件)。上面那条
  // api_retry 救不了这种 —— 它压根没重试过。
  //
  // 判据必须钉死在「最后一件事是在等 API」上,不能只看「多久没有事件」:工具在跑
  // (pytest 跑上半小时)同样一个事件都不发,那是活儿正常在干,报出来纯属误报。收到
  // 任何别的事件就立刻解除等待 —— 上游一开口,requesting 后面马上跟着 message_start。
  //
  // 落成 `kind:"error"` + `level:"notice"`:这类「回合正常着,只是在等」的信号跟本回合
  // 成败正交,所以**必须带 notice 这一级** —— 裸 error 的代价见 session-notice.ts 顶部:
  // 时间线上渲染成红色异常、执行过程计入异常数,duet 更是直接 `failed()` 掉整场讨论
  // (第 1 轮审查 P1/P2)。三条消费链(single-run / team / duet)都按 isExecutionNotice
  // 分流:照落 trace、照发,但一概不当失败处理。
  //
  // 为什么不再走 system 旁注:那一路写的是 `.md` 的回合 sentinel,而它是**回合收口之后**
  // 才补落盘的,于是一整串重试记录糊在会话结尾、离它真正发生的那一步十万八千里
  // (用户 2026-10-21 反馈)。走 trace 才落在执行过程里它发生的那个位置。
  let awaitingSince: number | null = null;
  let waitNoticed = 0;
  // `status:"compacting"` 是**心跳**不是**开始**:CLI 在整个压缩过程里每隔几秒重发一条,
  // 实测一次压缩发了 9 条(2026-09-29 的 run,连着 9 行之后才是 compact_result:success)。
  // 一条一行地抬上去,界面上就成了「正在压缩上下文…」刷屏九遍,看着像压了九次。
  // 所以只在**从没压到在压**的那一刻报一行,收到 compact_result 复位 —— 一个回合里真压
  // 两次时,第二次照样会报。
  let compacting = false;
  const waitTimer = setInterval(() => {
    if (events.closed || awaitingSince === null) return;
    const waited = Date.now() - awaitingSince;
    const due = Math.floor(waited / waitNoticeMs);
    if (due <= waitNoticed) return; // 每满一个间隔才报一次,别把静默刷成滚屏
    waitNoticed = due;
    push({
      kind: "error",
      message: `已经等上游 ${Math.max(1, Math.round(waited / 60_000))} 分钟没有响应，本回合仍在等待中`,
      level: "notice",
      affectsTurn: false,
    });
  }, Math.max(1_000, Math.floor(waitNoticeMs / 10)));
  waitTimer.unref?.(); // 心跳不能拖着进程不让退
  // 逐行处理。直播与重放共用这一份 —— 接回后的状态和不间断执行一致靠的就是这一条
  // (./claude-recovery.ts);重放时对外的产出由 `push` 静音,写库、落文件这类副作用在这里跳过。
  const handle = (ev: any): void => {
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
    // Monitor 的投影自己落库,接管时从库里认回来(../claude-monitors.ts),不重放。
    if (!replaying) claudeMonitors.event(ev);
    // 计时用的是读到这一行的时刻,重放是一口气读完的旧输出,喂进来只会量出离谱的速度。
    if (!replaying) requestTimer.event(ev);
    background.event(ev);
    // 主智能体开口了(或 CLI 起了新一轮):一个回合正在进行。后台任务的进度(system
    // task_*)不算 —— 回合结束之后它们照样在流里滚。
    if (startsTurn(ev)) {
      if (ev.type === "assistant") turnSpoke = true;
      resident?.beginTurn();
      ending = null;
    }
    if (ev.parent_tool_use_id) {
      const images = childImages.get(ev.parent_tool_use_id) ?? imageStore();
      childImages.set(ev.parent_tool_use_id, images);
      for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        // 子智能体挂的 Monitor 同样要认：它跑在同一条 CLI 会话、同一个 ash 任务上，
        // 盯的也是同一份活。漏接的话面板会说「这个任务上还没有哨兵」，而 agent 那边
        // 明明已经挂上了——跟主智能体那条路是同一个毛病，只是入口在这个分支里。
        // 注意这个分支**会提前 return**，所以必须在这儿接，不能指望下面那段顶层处理。
        if (block.type === "tool_use" && !replaying) claudeMonitors.toolUse(block.name, block.input, block.id);
        if (block.type === "tool_result" && !replaying) claudeMonitors.toolResult(block.tool_use_id, block.content);
        if (block.type === "tool_use") background.toolUse(block.name, block.id, block.input);
        if (block.type === "tool_result") background.toolResult(block.tool_use_id, block.is_error === true);
        // 子智能体写的文件同样是这个任务写的（见 tool-writes.ts）。
        if (block.type === "tool_use") writeLedger.toolUse(block.name, block.input, block.id);
        if (block.type === "tool_result") {
          const writes = writeLedger.toolResult(block.tool_use_id, block.is_error === true, soleReceipt(ev));
          if (writes) push(writes);
        }
        // 正文里的图归 withMarkdownImages(子智能体那份抽屉正文是它自己一笔账);这里只
        // 收工具结果里那几张 base64 截图 —— 它们不是正文语法,按块交代就是对的。
        if (block.type === "tool_result" && !replaying) {
          for (const path of persistToolResultImages(block.content, images)) push(childActivity(ev.parent_tool_use_id, { kind: "attachment", path }));
        }
      }
      return;
    }
    if (ev.type === "control_response") {
      // 重放里的回执配不上这一代的请求;哪个结尾是打断出来的由打断记录认(ClaudeControlBridge)。
      if (!replaying) resident?.handleResponse(ev);
      return;
    }
    if (ev.type === "stream_event") {
      const se = ev.event;
      if (!replaying && se?.type === "content_block_delta" && se.delta?.type === "text_delta" && se.delta.text) {
        events.delta("text", se.delta.text);
      }
      return; // deltas drive the live stream; the trailing complete message handles tools
    }
    if (ev.type === "system" && ev.session_id) {
      if (ev.subtype === "init" && !replaying) onInitialized();
      // init 事件白送一份**权威**技能清单(skills / slash_commands / cwd 都在里面),
      // 顺手校准 skills 模块的扫描结果 —— 这是唯一不用额外起一个 CLI 进程就能拿到
      // 「这个 CLI 自己认哪些技能」的机会,别浪费。纯旁路:失败也不能影响事件流。
      if (calibrateAs && !replaying && ev.subtype === "init" && typeof ev.cwd === "string") {
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
      // → 执行过程里的一步(notice)。三者都带 `compaction`,只管展示,不碰任务状态(原生
      // 命令本来就走旁路回合)。
      // 从前开始/成功是往正文里插一句引用,展示端再从正文里认它 —— 智能体的回复只要恰好
      // 引了这句(比如解释压缩日志),代码块里那一行就被摘掉、还凭空显示「在压缩」。
      if (ev.subtype === "status") {
        if (typeof ev.compact_result === "string") {
          compacting = false;
          if (ev.compact_result === "failed") {
            const detail = typeof ev.compact_error === "string" && ev.compact_error.trim()
              ? ev.compact_error.trim()
              : "CLI 没有给出原因";
            push({
              kind: "error",
              message: `上下文压缩失败，会话大小原地不动：${detail}`,
              affectsTurn: false,
              compaction: "failed",
            });
          } else {
            push({ kind: "error", message: "上下文已压缩", level: "notice", affectsTurn: false, compaction: "done" });
          }
        } else if (ev.status === "compacting" && !compacting) {
          compacting = true;
          push({ kind: "error", message: "正在压缩上下文", level: "notice", affectsTurn: false, compaction: "start" });
        } else if (ev.status === null) {
          // 压缩结束了却没有结论:CLI 的合法路径之一 —— PreCompact hook 把这次自动压缩
          // 拦下时,就是先 `status:"compacting"` 再以 `status:null` 收尾,`compact_result`
          // 整个字段缺失。不谎报「已压缩」,但得说一声这次结束了(cancelled):否则界面上那句
          // 「在压缩上下文」会一直挂到回合结束。标志也必须复位,否则它会泄漏到下一次压缩,
          // 把那次的开始提示整个吞掉。
          // 只认显式的 `null`:`requesting` 这类别的状态值在压缩期间也可能出现,拿它复位
          // 等于把心跳去重白做一遍。
          if (compacting) push({ kind: "error", message: "这次压缩被拦下了，没有压", level: "notice", affectsTurn: false, compaction: "cancelled" });
          compacting = false;
        }
      }
      // 上游重试是 CLI 唯一一次说出「不是我卡住了,是上游不给响应」。不接住它,重试和
      // 正常思考在界面上长得一模一样:只有一句「智能体委派中」停在那,而退避到后面单次
      // 就要等半分钟,一轮十次足够把回合拖上三刻钟(2026-09-24:中转网关先 502 再整个不
      // 响应,两个任务各停了 47 分钟)。
      //
      // 那次现场值得记一笔,因为它同时暴露了「这条信号有多要紧」:1M 模型的请求并不直连
      // 供应商,而是经本机 ash 的 context-1m 代理转发(anthropic-context-1m.ts),那一跳的
      // 上游 fetch 只继承 request.signal、自己不设超时,上游挂住它就一直等着。界面上又
      // 一个字都没有,用户当时能试的只剩重启 ash —— 重启确实让三个任务同时活了过来,但
      // 那是因为它切断了这台机器上**全部**在途请求、逼 CLI 重连,是没得选时的钝手段,
      // 不是这类情况的处理办法。真正该做的是把 CLI 早就说了的话显示出来,也就是下面这段。
      //
      // 所以每一次重试都抬成执行过程里的一条提示:它同时是「还活着」的心跳,重试间隔
      // 本来就是分钟级,不会刷屏。
      // 带 `level:"notice"` 而不是裸 error:重试期间回合仍然正常进行中,理由同上面
      // waitTimer 那段。真的重试耗尽,收尾的 result / synthetic 消息会照旧把失败报成
      // 故障级 error ——「最终失败了没有」由那条答,这里只负责把过程留在它发生的位置上。
      // 措辞与子智能体那一路共用一处(claude-retry-notice.ts):同一条原始事件有两个入口。
      if (isClaudeRetry(ev)) {
        // 带上这次重试撞的是哪一类：看门狗熔断掉这一轮时，原因据它说得出状态码（model-failure.ts）。
        const model = modelFailureOf(typeof ev.error === "string" ? ev.error : "", Number(ev.error_status) || null);
        push({ kind: "error", message: claudeRetryMessage(ev), level: "notice", affectsTurn: false, ...(model ? { model } : {}) });
      }
      // **这一条紧跟在上面那句重试提示后面**,而它只是把 CLI 会话身份报一遍 —— 不是上游回话了。
      // 停滞看门狗因此不能把「不是错误」当成「有进展」:那样每一条重试都被自己后面这一句当场
      // 解除,一条永远连不上的 Claude 会话于是报警和熔断都不会发生(第 2 轮审查 F1,已实测)。
      // 判据共用 `@ash/shared/waiting` 的 `resumesWaiting`(session/context/system 都不算回话),
      // 落点在 ../turn-stall.ts。
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
        } else if (block.type === "tool_use") {
          // Monitor 的入参只有这儿有：system/task_started 只带 tool_use_id，要靠它回指
          // 才分得清「内置 Monitor」和「普通后台 Bash」。
          if (!replaying) claudeMonitors.toolUse(block.name, block.input, block.id);
          background.toolUse(block.name, block.id, block.input);
          push(nativeWork.call(block.name, block.input, block.id)
            ?? { kind: "tool", name: block.name, detail: shortJson(block.input) });
          writeLedger.toolUse(block.name, block.input, block.id);
        }
      }
      if (hadText) push({ kind: "text", text: "\n\n" }); // paragraph break, identical live & on reload
    } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      flushText();
      for (const block of ev.message.content) {
        if (block?.type !== "tool_result") continue;
        // 起手回执里那句 `expires in 20m` 是来源侧唯一说出**生效**期限的地方（入参那个
        // timeout_ms 只是请求值，claude 会自己钳）。见 claude-monitors.ts 的 toolResult。
        if (!replaying) claudeMonitors.toolResult(block.tool_use_id, block.content);
        background.toolResult(block.tool_use_id, block.is_error === true);
        const activity = nativeWork.result(block.tool_use_id, block.content, block.is_error === true);
        if (activity) push(activity);
        const writes = writeLedger.toolResult(block.tool_use_id, block.is_error === true, soleReceipt(ev));
        if (writes) push(writes);
        if (!replaying) for (const path of persistToolResultImages(block.content, seenImages)) push({ kind: "attachment", path });
      }
    } else if (ev.type === "result") {
      // **不是每一条 `result` 都是「本回合说完了」。** claude CLI resume 时会先替
      // **上一个进程遗弃的后台任务**(`Orphaned by a previous Claude Code process exit`)
      // 补一条聚合回执,长这样:`origin:{kind:"task-notification"}`、`num_turns:0`、
      // `result:""`、`duration_ms` 几十毫秒 —— 它汇报的是孤儿通知,不是我们送进 stdin
      // 的那条 prompt 的结果。
      //
      // 把它当回合结束的代价是**整个回合被静默吞掉**:singleRunFromResident 见到第一个
      // turnEnd 就 `resident.close()` 并 yield done,进程当场收台,而那条 prompt 此时
      // 才刚 init 完、连 `status:requesting` 都没走完,一个 token 都没吐。外面看到的是
      // 一个「1.7 秒成功完成」的空回合,自由工作流照它推进下一轮审查。
      // (2026-09-27 实测:P5EH_BPGxLt- 第 9→10 轮之间执行者就是这么被吞的 —— 上一回合
      // 把测试丢进 5 个后台 Task 就结束,那 5 个成了孤儿,下一回合 resume 时汇报,
      // 于是第 10 轮审的还是第 8 轮那个 commit,报告与第 9 轮一字不差。)
      //
      // 整条跳过而不是只跳过 turnEnd:这条回执的 usage/context 全是 0,而两者落库都是
      // **覆盖**不是累加(shared/src/events.ts),照收会把本回合账目清零;session 也已经
      // 由它前面那条 init 推过了。跳过之后真正的 result 照常到达;万一 CLI 只吐了这一条
      // 就没了下文,进程退出还有 forceFinishOnExit 兜底,不会静默挂死。
      //
      // **只跳过主智能体一个字都没说的那种。** 后台工作流 / 子代理跑完,CLI 拿完成通知自己开
      // 的那一回合**同样**带 `origin:task-notification`,可那是真回合:智能体读了结果、干了活、
      // 交了卷(2026-11-06 实测 `claude -p` 与 stream-json 两种形态都是这样)。整条跳过它,
      // 单飞那一路就永远等不到这一回合的结尾。
      //
      // **报了失败的也不跳**:那一回合第一个 API 请求就挂掉(401、限流)时主智能体同样一个字
      // 都没说,只凭「说没说话」判会把这条权威失败整条吞掉,单飞那一路接着空等到超时。孤儿回执
      // 是成功形状的(`subtype:"success"`、没有 `is_error`),失败字段先看。
      const apiError = ev.is_error === true || typeof ev.api_error_status === "number";
      const failed = (!!ev.subtype && ev.subtype !== "success") || apiError;
      if (ev.origin?.kind === "task-notification" && !turnSpoke && !failed) return;
      turnSpoke = false;
      // 第几个回合结尾:等后台的起点和打断的认领都按它记,重启接管时认得出是哪一个。
      if (resident) resident.turns += 1;
      // 这一个结尾推出的事件,重放时留着(见 `ending`);下一个回合一开始就作废。
      ending = [];
      capturing = true;
      flushText();
      if (ev.session_id) push({ kind: "session", cliSessionId: ev.session_id });
      const usage = claudeUsage(ev);
      const timed = requestTimer.take();
      if (usage) push({ kind: "usage", usage: timed ? { ...usage, timed } : usage });
      // 水位跟着流水一起发。模型窗口仍优先用 claude 自报的(1M 只有那儿认得出),
      // 压缩配置则整份带上这个进程的启动快照：模型能力与“先在哪压缩”是两层数据，
      // 界面拿后者算真正的剩余量与触发点，不能为了显示 400k 把 1M 上限抹掉。
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
            ...compact,
          },
        });
      }
      // 我们自己发的 interrupt 会把本回合收成 error_during_execution —— 那是
      // 「用户插话打断」的预期结果,不是故障,不报错。每条打断只认领一个结尾(身份见
      // ClaudeControlBridge.claimInterrupt),所以最坏情况也只影响一个回合的错误上报。
      const claim = resident?.takeInterrupt(resident.turns) ?? null;
      // 上一代发了插话的打断、正文没送进去就重启了:回合确实是我们打断的(不报错),但不会再有
      // 插话开的下一回合,按这一回合结束处理,并告诉用户那条插话要重发。
      const ownInterrupt = !!claim && !claim.abandoned;
      const realFailure = failed && !claim;
      // 上一代读完这个结尾、开始等后台之后,在空档里直接送进去过一条消息:这个结尾已经被那条消息开
      // 的回合取代,不等后台、不收台,会话在忙(下面推完结尾就开新回合,这个结尾随之过期)。它落在
      // 已消费水位之前还是之后的尾流里都一样认(见 claude-recovery.ts 的 SteerJournal)。
      const superseded = !!resident && !claim && resident.takeSend(resident.turns);
      if (claim?.abandoned) {
        push({ kind: "system", text: "插话打断了这一回合，但 ash 恰在送出插话内容之前重启，那条消息没有送到，需要的话请重新发一次。", at: new Date().toISOString(), level: "notice" });
      }
      // 我们自己打断的那一回合收尾时,插话那条消息已经(或马上就要)送进去开下一回合:会话
      // 仍算在忙。这里清成空闲,紧跟着的第二次插话就会走「空档直接送」、不再打断第一条。
      if (resident && !ownInterrupt) resident.turnActive = false;
      // claude CLI 把 **API 层**的失败(404 模型不存在、401、限流…)报成
      // `subtype:"success"` + `is_error:true` + `api_error_status` —— 只看 subtype
      // 会把它整条判成正常结束。两路判据都要算上,否则回合「成功」但一个字没说。
      if (realFailure) {
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
        // 这一条确知是模型 API 的结局时（带着 api_error_status，或 CLI 写成「API Error: N」）挂上
        // 类型，读端据它说「上游连不上 / 超出长度上限 / 限流…」；CLI 自己的失败不挂。
        const reported = Number(ev.api_error_status);
        const status = Number.isInteger(reported) && reported >= 100 ? reported : claudeApiStatus(detail);
        const model = status != null ? modelFailureOf(detail, status) : null;
        push({
          kind: "error",
          message: ev.api_error_status ? `HTTP ${ev.api_error_status}: ${detail}` : detail,
          ...(model ? { model } : {}),
        });
      }
      // 单飞这一路的回合结束本来就是收台(见 ClaudeControlBridge.reapsAtTurnEnd);用户插话
      // 打断的那个 result 不算,进程还要接着跑下一段。名下还有没跑完的后台子代理 / 工作流
      // 时先不收:它们跑完 CLI 会自己开下一回合,收了台它们就白跑了(任务 SGK-4lWyRQCX)。
      // 这一回合本身报了失败就不等:结局已经定了,等下去只是把一个失败的结算拖后两小时。
      //
      // 等待说明发成 system 旁注而不是 notice error:后者是「上游在重试」的契约,停滞看门狗会把
      // 它计成重试、页面会显示「在等上游」—— 而这里上游好好的,是我们在等自己的后台。
      //
      // 接管时状态未知(`recoveryUnknown`)就当后台可能还有活:账本是空的不等于没有。
      const waiting = resident?.reapsAtTurnEnd && !ownInterrupt && !realFailure && !superseded ? background.waiting() : null;
      const holding = !!waiting && (waiting.agent + waiting.workflow > 0 || recoveryUnknown);
      if (holding) {
        push({ kind: "system", text: backgroundHoldNotice(waiting, recoveryUnknown), at: new Date().toISOString(), level: "notice", aside: true });
      } else if (resident?.reapsAtTurnEnd && !ownInterrupt && !superseded) {
        for (const activity of nativeWork.reaped()) push(activity);
      }
      // 常驻:回合说完了,进程还活着等下一条消息 —— 流不结束。打断出来的那个结尾要标出来:
      // 单飞据此不收台(接管回来的这一代没有发过那次打断,只能靠这个认)。等后台的起点重放时
      // 先不记,重放完真要重发这个结尾时再定(见下面的 `consumed`)。
      if (resident) {
        push(holding
          ? { kind: "turnEnd", background: { ...waiting!, ...(replaying ? {} : { since: holdSince(outPath, resident.turns) }) }, epoch: resident.epoch }
          : ownInterrupt ? { kind: "turnEnd", interrupted: true } : { kind: "turnEnd", epoch: resident.epoch });
        if (superseded) resident.beginTurn(true);
      }
      // 只清字节去重表,不动 `refs`:引用身份在一条流里单调递增,复位会让两个回合的
      // 身份撞上。字节去重按回合清是故意的 —— 同一个路径在下一回合被重拍过,那是新的
      // 一张图,得有自己的拷贝。
      seenImages.copies.clear();
      childImages.clear();
      // 回合结束 = 压缩绝不可能还在进行中。兜底复位,免得将来 CLI 新增一条我们没认出来
      // 的终止路径时,残留的标志把下一回合的开始提示吞掉(常驻进程一份标志跨多回合)。
      compacting = false;
      capturing = false;
    }
  };

  // 重启接管:先把水位之前那段静音走一遍(见 ./claude-recovery.ts 文件头)。打断记录先读回来,
  // 重放里的结尾才认得出哪个是打断出来的。
  if (consumed) {
    replaying = true;
    background.quiet = true;
    try {
      resident?.restore();
      if (consumed.offset > 0) for (const ev of consumedEvents(consumed)) handle(ev);
    } catch (error) {
      recoveryUnknown = true;
      ending = null;
      // 忙闲同样说不准。当它空闲:插话直接送,真在忙 CLI 也只是排到这一回合之后;当它在忙则可能
      // 去打断一个空闲会话,那不会再吐 result,插话开的那一回合结尾会被当成打断的结尾、收不了台。
      if (resident) resident.turnActive = false;
      console.warn(`[ash] 读不出接管前已消费的输出（${consumed.outPath}），按「后台状态未知」接着跑:`, error);
    } finally {
      replaying = false;
      capturing = false;
      background.quiet = false;
    }
    // 读不出来时,单飞这一路就地开始「等后台」:不知道会不会还有下一个回合结尾,不能等到它来了
    // 才承担期限 —— CLI 若正闲着等自己的后台,那个结尾可能永远不来(自由审查 ZbBv9az0Qgtf R1-A)。
    // 说明当场给用户;期限到了按核实不了结算。真在回合中途,它一开口就开了新回合,这份等待随即
    // 作废,那一回合的结尾再按未知判。
    if (recoveryUnknown && resident?.reapsAtTurnEnd) {
      const waiting = background.waiting();
      push({ kind: "system", text: backgroundHoldNotice(waiting, true), at: new Date().toISOString(), level: "notice", aside: true });
      // 起点同样落盘(按 -1 这个「接管时读不出」的结尾认),反复重启不重新给满。
      push({ kind: "turnEnd", background: { ...waiting, since: holdSince(outPath, -1) }, epoch: resident.epoch });
    }
    // 水位正停在一个回合结尾之后:上一代当时据它收台或开始等后台,这一代没见过,得照样重发。
    // 打断出来的结尾不在此列(回合仍算在忙)。时刻与回合身份用重发这一刻的:重放里的计数跟这一代
    // 对不上;这之后再开回合,它照样过期。
    const last = ending as AgentEvent[] | null; // handle() 里写的,控制流分析看不见
    if (last && resident && !resident.turnActive) {
      const at = new Date().toISOString();
      for (const event of last) {
        if (event.kind === "system") push({ ...event, at });
        else if (event.kind === "turnEnd" && event.background) push({ ...event, background: { ...event.background, since: holdSince(outPath, resident.turns) }, epoch: resident.epoch });
        else if (event.kind === "turnEnd") push({ ...event, epoch: resident.epoch });
        else push(event);
      }
    }
    ending = null;
  }

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      return;
    }
    handle(ev);
  });

  // 进程没了的那一刻还有后台工作没跑完,或者跑没跑完核实不了(接管时读不出之前的输出):如实
  // 交给单飞,退出码是 0 也不能按完成结算。三种情况分得开:不带 = 都了结了,带计数 = 还有这些
  // 没跑完,带 unknown = 说不准(计数只是已知的那部分,不拿它冒充全部)。
  const done = (exitStatus: number): AgentEvent => {
    if (!resident?.reapsAtTurnEnd) return { kind: "done", exitStatus };
    const waiting = background.waiting();
    if (recoveryUnknown) return { kind: "done", exitStatus, unfinished: { ...waiting, unknown: true } };
    return waiting.agent + waiting.workflow > 0 ? { kind: "done", exitStatus, unfinished: waiting } : { kind: "done", exitStatus };
  };
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (events.closed) return;
    resident?.failPending(new Error(`Claude 进程错误：${err.message}`));
    push({ kind: "error", message: spawnErrorMessage(bin, err) });
    for (const activity of nativeWork.reaped()) push(activity);
    push(done(1));
    events.close();
  });
  child.on("close", (code) => {
    if (events.closed) return;
    resident?.failPending(new Error("Claude 进程在 interrupt ACK 前退出"));
    flushText(); // emit any text tail that never hit the flush threshold
    const exit = code ?? 0;
    if (exit !== 0 && stderr.trim()) push({ kind: "error", message: normalizeClaudeCliError(stderr).slice(0, 2000) });
    // 进程没了,寄生在里面的工作流也没了(团队调度台走的是这一路)。
    for (const activity of nativeWork.reaped()) push(activity);
    push(done(exit));
    events.close();
  });
  forceFinishOnExit(child, () => events.closed, (exit) => {
    resident?.failPending(new Error("Claude 进程在 interrupt ACK 前异常收尾"));
    flushText();
    push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
    for (const activity of nativeWork.reaped()) push(activity);
    push(done(exit));
    events.close();
  });

  // finally 而不是逐条终止路径里 clear:消费方提前 break(用户停任务)一样走得到这里。
  try {
    yield* events.drain();
  } finally {
    clearInterval(waitTimer);
    // agent 进程结束 = 它名下的内置 Monitor 全都跟着没了（它们本来就在这棵进程树里）。
    // 不收尾的话面板上会永远留着几张「正在盯着」的僵尸卡。
    //
    // **等它记完**：收尾排在投影自己的写库队列上，不等的话这条流都返回了、队列里还压着
    // 这一代的 open/close，而外面紧跟着就是下一轮的会话更新（新一轮第 1 轮审查点名的同类
    // 收尾位置）。这个 await 不会抛、也不会挂（见 ClaudeMonitorTrace.finishAll）。
    await claudeMonitors.finishAll();
    // 同理：进程没了，名下还在跑的后台子代理 / 后台 Bash 也全没了。不抛（见 finish）。
    await background.finish();
  }
}

/** 回合说完了、后台还有活没跑完时落在执行过程里的那一句。 */
export function backgroundHoldNotice(waiting: { agent: number; workflow: number }, unknown = false): string {
  if (unknown && !waiting.agent && !waiting.workflow) {
    return "重启接管时读不出之前的输出，确认不了后台还有没有活在跑，先按还在跑等着；确认没有的话可以直接停止。";
  }
  const parts = [
    waiting.workflow ? `${waiting.workflow} 个工作流` : "",
    waiting.agent ? `${waiting.agent} 个后台子代理` : "",
  ].filter(Boolean).join("、");
  return `后台还有 ${parts}在跑，等它们跑完智能体会接着干。`;
}
