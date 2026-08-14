import { useEffect, useState } from "react";
import { NO_CLI_HOST_ENV, type CliHostEnv } from "@harness/shared/cli-overrides";
import { api } from "../lib/api.ts";

// harness 起 CLI 时子进程会看到的环境事实（只读，不是配置项）。压缩触发点的换算里
// 有一项（CLAUDE_CODE_MAX_OUTPUT_TOKENS）住在 **server 进程**的环境里，前端算不出来；
// 不拿真值的话，设置页写的水位会跟 CLI 的实际行为差出几个百分点。
//
// 全局只读事实 → 进程内缓存一份 Promise：设置页里每个 profile 行都会用到它，一行一次
// 请求纯属浪费，而它在 server 重启前也不会变。
let cached: Promise<CliHostEnv> | null = null;

export function useCliHostEnv(): CliHostEnv {
  const [host, setHost] = useState<CliHostEnv>(NO_CLI_HOST_ENV);
  useEffect(() => {
    let alive = true;
    cached ??= api.cliHostEnv();
    // 取不到就退回默认（= 按 20k 预留算，绝大多数机器的真实情况），
    // 为了一行提示文案在设置页弹个错，不值当。
    cached.then((value) => { if (alive) setHost(value); }).catch(() => { cached = null; });
    return () => { alive = false; };
  }, []);
  return host;
}
