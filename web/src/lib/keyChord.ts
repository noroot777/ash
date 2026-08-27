// 两键连打的快捷键（vim 味的 `I F`、`T T`）：先按前缀键，超时前再按第二键才算数。
//
// 时序判据只有这一处 —— 各处只说「前缀是谁、第二键收哪些」，超时多长、按了别的键要不要
// 作废、连打三下算几次，全在这里回答。分头写迟早会出现「Inspector 那套等一秒、别处只等
// 半秒」这种没人说得清的差别。
//
// 前缀键本身被吞掉（返回 prefix，调用方 preventDefault），所以做前缀的键不能同时是单键
// 快捷键；超时后它自动作废，误按一下不会留下任何状态。

export const KEY_CHORD_TIMEOUT_MS = 1_000;

export type KeyChordDecision<K extends string> =
  | { kind: "none" }
  | { kind: "prefix" }
  | { kind: "chord"; key: K };

export type KeyChordSequence<K extends string> = {
  handle(rawKey: string, now?: number): KeyChordDecision<K>;
  reset(): void;
};

export function createKeyChordSequence<K extends string>(
  prefix: string,
  isChordKey: (key: string) => key is K,
  timeoutMs = KEY_CHORD_TIMEOUT_MS,
): KeyChordSequence<K> {
  let prefixStartedAt: number | null = null;

  return {
    handle(rawKey: string, now = Date.now()): KeyChordDecision<K> {
      const key = rawKey.toLowerCase();
      if (prefixStartedAt !== null) {
        const withinTimeout = now >= prefixStartedAt && now - prefixStartedAt <= timeoutMs;
        prefixStartedAt = null;
        if (withinTimeout && isChordKey(key)) return { kind: "chord", key };
      }
      if (key === prefix) {
        prefixStartedAt = now;
        return { kind: "prefix" };
      }
      return { kind: "none" };
    },
    reset(): void {
      prefixStartedAt = null;
    },
  };
}
