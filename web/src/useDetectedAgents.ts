import { useEffect, useState } from "react";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { api } from "./api";

/** `GET /api/agents/detect` 的一项，只留「选谁干活」要用的三个字段。 */
export type DetectedAgent = {
  type: AgentType;
  available: boolean;
  resident: boolean;
};

// 「选谁干活」的候选来自**本机检测**，不是 AGENT_TYPES 全量：目录里登记了 15 个 CLI，
// 一台机器上装了三四个是常态，把没装的摆进下拉只能让用户选出一个必然跑失败的执行器。
//
// 检测要 shell 出去做十几次 which + --version，所以整页只探一次：结果按模块级 promise
// 缓存，谁先要谁触发，后来者复用。用户在智能体面板点「检测本地智能体」后调
// `refreshDetectedAgents()` 让下一个订阅者重新探（刚装完 CLI 就能在下拉里看到）。
//
// **失败与「一个都没装」必须分开**：两者在候选列表上长得一样，但后果不一样 —— 真的一个
// 都没装时该拦住建单（建了也跑不起来），探测失败时绝不能拦（一次接口抖动会变成「新建
// 任务坏了」）。所以带一个 failed 标志一起往外给。
export type Detection = { list: DetectedAgent[]; failed: boolean };

let cached: Promise<Detection> | null = null;
const subscribers = new Set<(detection: Detection) => void>();

function load(): Promise<Detection> {
  cached ??= api
    .detectAgents()
    .then((list) => ({ list, failed: false }))
    .catch(() => ({ list: [] as DetectedAgent[], failed: true }));
  return cached;
}

/** 丢掉缓存并让所有挂载中的订阅者重新探一次。 */
export function refreshDetectedAgents() {
  cached = null;
  const next = load();
  for (const notify of subscribers) {
    void next.then(notify);
  }
}

/**
 * 检测态。`detected === null` = 还没探完；`failed` = 探测请求本身失败（此时 list 是空的，
 * 但**不代表**这台机器没装 CLI，别拿它当「什么都没装」用）。
 */
export function useDetection(): { detected: DetectedAgent[] | null; failed: boolean } {
  const [detection, setDetection] = useState<Detection | null>(null);
  useEffect(() => {
    let alive = true;
    const notify = (next: Detection) => {
      if (alive) setDetection(next);
    };
    subscribers.add(notify);
    void load().then(notify);
    return () => {
      alive = false;
      subscribers.delete(notify);
    };
  }, []);
  return { detected: detection?.list ?? null, failed: detection?.failed ?? false };
}

/** 只要那份列表时用这个（`null` = 还没探完）。 */
export function useDetectedAgents(): DetectedAgent[] | null {
  return useDetection().detected;
}

/**
 * 「按类型新选执行器」的候选：**只有本机探到的 available**，顺序跟 AGENT_TYPES。
 *
 * 刻意允许返回空数组，也刻意**不并入**已注册 profile 的类型：
 * - 兜底给一个「反正 claude 总能选」会凭空造出一个本机没装的候选（2026-07-30 审查拦下过）；
 * - 已注册 profile 要照旧展示，但那是「列出这个 profile 本身」，不等于把它的类型重新变成
 *   「按类型默认」的候选 —— 这两条由 `ExecutorPicker.executorOptions` 分两路各自生成。
 *
 * 调用点因此必须能吃空数组：判断某个选择还成不成立用 `isExecutorPickable`，不要 `types[0]!`。
 */
export function availableTypes(detected: DetectedAgent[] | null): AgentType[] {
  const usable = new Set<string>((detected ?? []).filter((item) => item.available).map((item) => item.type));
  return AGENT_TYPES.filter((type) => usable.has(type));
}

/**
 * 这个选择在当前这台机器上还成不成立：指名 profile 的看那个 profile 还在不在（用户显式
 * 注册过的东西不因为「本机没探到那个 CLI」而作废，它可能是 ssh 远端），按类型默认的看
 * 类型有没有探到。用来决定「用户上次的选择要不要顺移到别处」。
 */
export function isExecutorPickable(
  selection: { agentType: AgentType; executorId: string | null },
  types: AgentType[],
  profiles: AgentExecutorProfile[],
): boolean {
  return selection.executorId
    ? profiles.some((profile) => profile.id === selection.executorId)
    : types.includes(selection.agentType);
}

/**
 * 哪些类型**有能力**当团队调度者（执行器实现了 `openResident`）。
 *
 * 真相在服务端的执行器实现，但 `GET /api/agents/detect` 只在 CLI **装了**的时候才去问
 * 执行器，没装的一律报 `resident: false`。于是「本机没装 claude、但注册了一个 ssh 的
 * claude 调度者」会被误判成「这台机器没有可用调度者」——2026-07-30 第二轮审查抓到的
 * 阻断就是这个。所以这里在 detect 的结果之上再并一份**已知能力名单**兜底。
 *
 * 这份名单是服务端 `openResident` 实现的镜像（目前只有 claude 有，`GenericCliExecutor`
 * 一律不实现）。给某个执行器加上常驻能力时记得同步；漏同步的后果有限：那个 CLI 装了的
 * 话 detect 会照实报 resident，只有「没装但注册了远端 profile」这一种组合会少列出来。
 * 更好的收口是让 detect 把「能不能常驻」按类型如实返回（与装没装解耦），届时这份名单可删。
 */
const RESIDENT_CAPABLE: readonly AgentType[] = ["claude"];

export function residentTypes(detected: DetectedAgent[] | null): AgentType[] {
  const capable = new Set<string>(RESIDENT_CAPABLE);
  for (const item of detected ?? []) if (item.resident) capable.add(item.type);
  return AGENT_TYPES.filter((type) => capable.has(type));
}

/**
 * 当前选择不可用时该顺移到哪:先挑一个 available 类型(可以要求「别和 avoid 同类型」,
 * 给辩论两个辩手/团队调度者与执行者留出不同视角),没有 available 类型就退到任一已注册
 * profile(可能是 ssh 远端),什么都没有返回 null —— 由调用点决定是提示还是拦提交。
 */
export function fallbackExecutor(
  types: AgentType[],
  profiles: AgentExecutorProfile[],
  avoid?: AgentType,
): { agentType: AgentType; executorId: string | null } | null {
  const type = types.find((item) => item !== avoid) ?? types[0];
  if (type) return { agentType: type, executorId: null };
  const profile =
    profiles.find((item) => item.type !== avoid && item.isDefault)
    ?? profiles.find((item) => item.type !== avoid)
    ?? profiles.find((item) => item.isDefault)
    ?? profiles[0];
  return profile ? { agentType: profile.type, executorId: profile.id } : null;
}

/** 检测态 + available 类型候选一起给出，省得每个调用点都写两行。 */
export function useAvailableTypes() {
  const { detected, failed } = useDetection();
  return { detected, failed, types: availableTypes(detected) };
}

/**
 * 「这台机器上一个能干活的都没有」——真的什么都没装（不是探测失败、不是还没探完），
 * 也没有任何已注册 profile。建单表面据此拦提交：建出来的任务必然起不来。
 */
export function nothingRunnable(
  detected: DetectedAgent[] | null,
  failed: boolean,
  profiles: AgentExecutorProfile[],
): boolean {
  return detected !== null && !failed && availableTypes(detected).length === 0 && profiles.length === 0;
}
