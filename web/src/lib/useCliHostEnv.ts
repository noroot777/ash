import { useEffect, useState } from "react";
import { NO_CLI_HOST_ENV, type CliHostEnv } from "@ash/shared/cli-overrides";
import { api } from "../lib/api.ts";

// ash 起 CLI 时子进程会看到的环境事实（只读，不是配置项）。压缩触发点的换算里
// 有一项（CLAUDE_CODE_MAX_OUTPUT_TOKENS）住在 **server 进程**的环境里，前端算不出来；
// 不拿真值的话，设置页写的水位会跟 CLI 的实际行为差出几个百分点。
//
// 设置页里每个 profile 行都会用到它，同一时刻只发一份请求（各行共用这个 Promise）；
// 但**不永久缓存**：里面的百分比、输出预留来自用户自己的 claude 配置文件，在页面外随时
// 会被改（审查 SaouXWB_jEuw 第 2 轮 N1），所以请求一结束就作废，下次打开重新取。
let cached: Promise<CliHostEnv> | null = null;

/**
 * `refreshKey` 一变就重取:挂着不卸载的调用方(执行器设置的一整行)拿弹层的开合当这个 key,
 * 每次打开都是新值;弹层里的子组件别再自己调一份,从父级拿同一个值(审查 7pDLIAokZRHH N1)——
 * 两份各取各的,同一个弹层里就会一处写新百分比、一处写旧的。
 */
export function useCliHostEnv(refreshKey?: unknown): CliHostEnv {
  const [host, setHost] = useState<CliHostEnv>(NO_CLI_HOST_ENV);
  useEffect(() => {
    let alive = true;
    const pending = (cached ??= api.cliHostEnv());
    const settle = () => { if (cached === pending) cached = null; };
    // 取不到就退回默认（= 按 20k 预留算，绝大多数机器的真实情况），
    // 为了一行提示文案在设置页弹个错，不值当。
    pending.then((value) => { if (alive) setHost(value); }, () => {}).finally(settle);
    return () => { alive = false; };
  }, [refreshKey]);
  return host;
}
