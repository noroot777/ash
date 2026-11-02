// 回合停滞看门狗的**阈值**:每档的默认值、环境变量名,以及「配错一个字不许变成见错就杀」的
// 那道解析闸。判据与动手住在 ./turn-stall.ts;拆出来是因为那份文件贴着 700 行上限。

/** 配过一次的坏值只报一次,别让看门狗自己变成刷屏源。 */
const badEnvReported = new Set<string>();

/**
 * 读一个毫秒/条数阈值。**非有限数一律退回默认值**。
 *
 * 不校验的那一版有个很糟的失效方向(第 1 轮审查非拦项):`ASH_STALL_TRIP_MS=30m` 解析成
 * `NaN`,而 `NaN <= 0` 和 `elapsedMs < NaN` **都是 false** —— 两道闸同时放行,于是第一条
 * 错误事件就当场熔断。看门狗配错一个字就变成「见错就杀」,这比不设看门狗更坏。
 */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isFinite(value)) return value;
  if (!badEnvReported.has(name)) {
    badEnvReported.add(name);
    console.warn(`[ash] ${name}=${JSON.stringify(raw)} 不是数字,这一档按默认值 ${fallback} 走`);
  }
  return fallback;
}

/**
 * 阈值**每次现读**而不是模块加载时定格:回归测试要在一个进程里分阶段改口径(先钉条数档、
 * 再钉时间档),定格了就得为每一档各起一个进程。读 env 的开销只落在真有停滞时(见 evaluate)。
 *
 * 各档 `<= 0` = 关掉这一档。
 */
export function thresholds() {
  return {
    /** 警告档:连续这么多条错误事件(期间上游一次都没真回话)就报。 */
    warnErrors: num("ASH_STALL_WARN_ERRORS", 5),
    /** 警告档:这种状态持续这么久也报(两个条件取或)。 */
    warnMs: num("ASH_STALL_WARN_MS", 5 * 60_000),
    /** 熔断档:这种状态持续这么久就终止本回合。 */
    tripMs: num("ASH_STALL_TRIP_MS", 30 * 60_000),
    /** 熔断之后留给「这一轮真的结束」的宽限期,过了就回收句柄(见 StallActions.escalate)。 */
    graceMs: num("ASH_STALL_TRIP_GRACE_MS", 60_000),
    /** 静默档·警告:回合开始这么久还没有过任何进展事件就报。 */
    silentWarnMs: num("ASH_STALL_SILENT_WARN_MS", 10 * 60_000),
    /**
     * 静默档·熔断:同上,终止本回合。
     *
     * **刻意比错误档的 30 分钟宽**:那一档手里有几百条错误事件当证据,这一档只有「什么都没有」,
     * 是更弱的证据 —— 同一个方向上的取舍(宁可晚杀不可早杀)在这里要再让一步。
     */
    silentTripMs: num("ASH_STALL_SILENT_TRIP_MS", 45 * 60_000),
  };
}

export const pollMs = () => Math.min(30_000, Math.max(200, num("ASH_STALL_POLL_MS", 15_000)));

/** 只给回归测试(`__resetTurnStalls`):坏值告警重新可报。 */
export function resetStallThresholdWarnings(): void {
  badEnvReported.clear();
}
