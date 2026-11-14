// 回合级停滞看门狗的**契约**:现场事实(`StallFacts`)与三条消费链各自要提供的动作
// (`StallActions`)。
//
// 为什么单独一个文件:判据状态机在 `turn-stall.ts`,措辞在 `turn-stall-text.ts`,而这两份接口
// 是**三条消费链(single-run / duet / team)与看门狗之间的那张合同** —— 新接一条链时要读的
// 就是它,它也是唯一一处写着「每个动作为什么必须由链自己做、以及做不到会出什么事」的地方。
// 判据那个文件已经贴着单文件上限(根 CLAUDE.md 700 行),合同留在里面只会把它顶破。
//
// 这里一行运行时代码都没有(纯 interface),所以从哪边 import 都不会制造循环。
import type { ModelFailure } from "@ash/shared";

/** 持有者 = 此刻在消费这条会话的那个实例本身(同 session-waiting.ts 的 WaitingOwner)。 */
export type StallOwner = object;

/** 一次停滞的现场。措辞一律由 `turn-stall-text.ts` 拼(三条链的措辞不许漂),这里只带事实。 */
export interface StallFacts {
  sessionId: string;
  taskId: string;
  turnStartedAt: string;
  /** 停滞起点:**第一条错误事件的到达时刻**(见 `turn-stall.ts` 的 openStall,刻意取保守的那一边)。 */
  since: string;
  /** 自那以来的错误事件总数。 */
  errors: number;
  /** 其中 `level:"notice"` 的那些 —— 「上游在重试」这一类。 */
  retries: number;
  /** 其中来自**子智能体线程**的那些(包装成 `nativeWork` 活动的,见 errorFacts)。 */
  childErrors: number;
  /** 最后一条错误的原文(已截断)。 */
  lastMessage: string;
  /**
   * 最后一条错误**来自模型 API 的哪一类**(执行器挂上的 `ModelFailure`,穿过子智能体包装取),
   * 没挂就是 null —— 不沿用更早那条的:熔断的原因只能是此刻卡住它的那一条(进展一来整份停滞
   * 就解除了,所以也不会带到下一次停滞里)。
   */
  lastModel: ModelFailure | null;
  /**
   * 停滞**之前**这一轮最后那条正常事件是什么(`text`/`thinking`/`tool`/…),null = 这一轮从头
   * 到尾没有过正常事件。
   *
   * 诊断里「卡在哪一步」靠它:`tool` 之后挂住(工具跑完等模型总结)和一条正常输出都没有过
   * (连接从头就没建起来)是两种现场,要查的东西完全不同。
   *
   * **原始协议的 method/type 不在这一层**:那个只有 `executors/diagnostics.ts` 的
   * `RunTraceRecorder.finish()` 产出,而它是**进程退出之后**才跑的 —— 熔断这一刻进程还活着,
   * 那个对象压根不存在。同一份信息在熔断诊断指名的那个原始事件流文件的最后一行里(路径由 `turn-stall-text.ts` 的 rawLogHint 算)。
   */
  lastProgressKind: string | null;
  elapsedMs: number;
}

export interface StallActions {
  /** 这个任务的 id —— 诊断里要给原始事件流的落点。 */
  taskId: string;
  /**
   * **警告档**:落一条持久可见的提示。
   *
   * 落点是**执行过程**(trace)而不是 `.md` 的 system 旁注:后者是回合收口之后才补落盘的,
   * 一整串提示会糊在会话结尾、离它真正发生的那一步十万八千里(用户 2026-10-21 反馈,
   * 同一个理由写在 `executors/claude-stream.ts` 的 waitTimer 那段)。
   */
  warn(text: string, facts: StallFacts): void;
  /**
   * **熔断档**:红色诊断 + 终止这一轮。
   *
   * 「这一轮算失败」这件事**看门狗已经替实现方钉好了**(熔断前先写 `turn-stall-verdict.ts`,
   * 三处结算各自去读),实现方不必、也不该再去反推退出码 —— 被杀的 CLI 多半报不出非零,理由
   * 见那个文件头。这里只负责「说出来 + 让它停下」。
   */
  trip(text: string, facts: StallFacts): void;
  /**
   * **熔断的兜底**:`trip` 之后过了宽限期,这一轮**还是没真的结束**。
   *
   * 为什么要有这一档(第 1 轮审查第 4 条):`trip` 对常驻台走的是 `interrupt()`,而那只是
   * 往 stdin 写一行请求 —— 没有 ACK、没有「等回合真的结束」、也没有强杀退路。请求没人理
   * 的话,熔断就只是在时间线上说了句话,回合照旧卡着。所以熔断**以真实结束为成功条件**:
   * 没结束就在这里回收句柄/台。
   *
   * 不实现 = 这条链的 `trip` 本身就是硬终止(单飞/duet 直接 `kill()`),不需要第二档。
   */
  escalate?(text: string, facts: StallFacts): void;
  /**
   * 停滞解除(上游回话了)或回合收尾:撤掉卡片上那个持久标记。只在真的报过警时才会被调。
   *
   * **熔断之后同样会走到这里**(回合真结束时)—— 那个标记说的是「此刻正卡着」,回合都结束了
   * 它就该撤掉,持久可见的那份证据是时间线上的熔断诊断 + 任务落的失败态。不撤的那一版会把
   * 标记留在会话行上,下一轮复用同一行时 `ended_at` 一清,它又亮起来:页面上一边是正常答完
   * 的新回合、一边是红色停滞环,刷新还在(第 1 轮审查第 3 条,已实测)。
   */
  resolve(facts: StallFacts): void;
  /**
   * 警告档的**持久投影**:把「这条会话此刻卡在上游连不上」落进库(卡片上那颗红环)。
   *
   * 为什么它跟 `warn` 分开、而且要报成败(本轮审查 N1):上一版两件事挤在 `warn` 里,而
   * `warned` 在调用动作之前就置 true 了 —— 投影那笔 UPDATE 一次失败(I/O、权限、库忙)只写一行
   * console,之后再也不会有人重投。于是上游继续断着、时间线上的警告也在,卡片却一直没有红环:
   * **「已经通知过」被当成了「持久状态已经确认」**,而这两件事的失败模式完全不同 —— 通知是一次性
   * 的,投影是个需要确认的状态。
   *
   * 拆开之后看门狗每一拍重投一次,直到它确认落库(置标记那笔按定义幂等:同一个 `since` 写第二次
   * 结果一样)。**必填**,不是可选增强:做成可选的话新增一条消费链忘了传就静默没有持久那一半,
   * 而那正是这一条本身的形状。
   */
  project(facts: StallFacts): Promise<boolean>;
  /**
   * **这一轮产出过东西了** —— 本轮进展事件上调,**返回落盘确认了没有**:没确认就在下一条
   * 进展事件上再来一次(同 `project` 那条「通知是一次性的、持久状态是个要确认的东西」;
   * 第 2 轮自由审查 F2 点名:上一版只在首条调一次,写失败后再也没人重投,而读侧那时还会把
   * 「写失败」读成「确证没产出」)。
   *
   * 为什么这件事必须由消费链落盘、而不是留在看门狗里:进程内那份记录(`lastProgress`)挂在
   * **持有者**上,重启接管会造一个新句柄,旧句柄见过的进展一起没了,已消费的输出又落在
   * `agentOffset` 之前、不会再次到达这里。于是一个正在跑长工具的健康回合在接管之后看起来
   * 和「输入压根没送到」完全一样,而静默钟仍按回合真实起点算 —— 第 1 轮自由审查 F1 实测到
   * 的误杀就是这么来的(`sleep 3600` 跑着,新进程判「一条输出都没有过」并终止了它)。
   *
   * 看门狗那一份是纯状态机、一个字节都不落盘(`turn-stall.ts` 文件头最后一段),所以这里只报事实;落盘在 `turn-progress-mark.ts`,读回来
   * 的那一头是 `watchTurnSilence` 的 `hadProgress` 参数。
   */
  noteProgress?(): boolean;
}
