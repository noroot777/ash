// 本机存储（localStorage / sessionStorage）里的键一律挂在 `navi:` / `navi.` 前缀下。项目改过两次名
// （harness → ash → navi），老版本页面存下的偏好、草稿、布局还挂在旧前缀上：页面一启动、任何模块读存储
// 之前（main.tsx 第一行 import 的 storageRenameBoot.ts），把它们整批挪到新前缀。之后各处只认新键，不必
// 每读一处就回头找一次旧的。
//
// 同一个新键可能同时有好几代旧值（`ash:x` 和更早的 `harness-next:x` 都在）：按代数定胜负，新键 > ash >
// harness-next，跟存储枚举的先后无关 —— 浏览器枚举键的顺序不是版本信息。新键已经在（比如另一个已升级
// 的标签页先写过）就以新的为准。挪完旧键就删掉：还开着的老版本标签页读到的会是空值，只是那一页的偏好
// 回到默认，刷新一下就是新版本、读得到挪过来的那份。
//
// 写不进去（存储快满）时先腾出旧键自己那块地方再写；还是写不进去，旧值留在原处等下次启动再挪，这一次
// 由 `keepLegacyReadable` 让读新键的地方照样读到它 —— 只留着不让读，草稿在用户眼里就是没了。
//
// 下面这张表里的旧前缀是兼容值：批量改名时别把它们也换成 navi，不然旧数据就没人认了。
export const LEGACY_STORAGE_PREFIXES: readonly (readonly [legacy: string, current: string])[] = [
  // 排在前面的那一代更新：同一个新键有好几份旧值时取最前面那份。
  ["ash:", "navi:"],
  ["ash.", "navi."],
  ["harness-next:", "navi:"],
];

type KeyValueStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

/** 这一次没挪成的那一条：新键名、旧值还在的旧键名，以及值本身（连旧键都写不回去时只剩这一份）。 */
export interface StuckKey {
  key: string;
  legacyKey: string;
  value: string;
}

export interface RenameResult {
  /** 处理掉的旧键数（挪过去的，和因为有更新的一代而丢掉的）。 */
  moved: number;
  stuck: StuckKey[];
}

/** 把一份存储里挂在旧前缀下的键挪到新前缀。 */
export function renameLegacyStorageKeys(storage: KeyValueStorage): RenameResult {
  // 先把键名抄下来再动：边遍历边增删，key(i) 的顺序会变。按新键归拢，每个新键下的旧键按代数排好。
  const byTarget = new Map<string, { rank: number; key: string }[]>();
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key === null) continue;
    const rank = LEGACY_STORAGE_PREFIXES.findIndex(([legacy]) => key.startsWith(legacy));
    if (rank < 0) continue;
    const [legacy, current] = LEGACY_STORAGE_PREFIXES[rank];
    const target = current + key.slice(legacy.length);
    byTarget.set(target, [...(byTarget.get(target) ?? []), { rank, key }]);
  }
  const result: RenameResult = { moved: 0, stuck: [] };
  for (const [target, sources] of byTarget) {
    sources.sort((a, b) => a.rank - b.rank);
    let winner: { key: string; value: string } | null = null;
    if (storage.getItem(target) === null) {
      for (const { key } of sources) {
        const value = storage.getItem(key);
        if (value !== null) { winner = { key, value }; break; }
      }
    }
    // 输掉的那几代先删：既是该删的，也给赢的那份腾地方。
    for (const { key } of sources) {
      if (key === winner?.key) continue;
      storage.removeItem(key);
      result.moved++;
    }
    if (!winner) continue;
    if (move(storage, winner.key, target, winner.value)) result.moved++;
    else result.stuck.push({ key: target, legacyKey: winner.key, value: winner.value });
  }
  return result;
}

function move(storage: KeyValueStorage, from: string, to: string, value: string): boolean {
  try {
    storage.setItem(to, value);
    storage.removeItem(from);
    return true;
  } catch { /* 写不进去：腾出旧键那块地方再试一次 */ }
  storage.removeItem(from);
  try {
    storage.setItem(to, value);
    return true;
  } catch {
    try { storage.setItem(from, value); } catch { /* 连原处都放不回去：只剩 StuckKey 里那份，这一次照样读得到 */ }
    return false;
  }
}

type StoragePrototype = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const pending = new WeakMap<object, Map<string, StuckKey>>();
const patched = new WeakSet<object>();

/**
 * 这一次没挪成的那几条，让读新键的地方照样读到旧值，直到这个新键被写过或删过（那时用户已经在旧值上
 * 动过手了，旧值随之作废）。各处读存储都直接调 `localStorage.getItem`，所以垫在 Storage 的原型上；
 * 只有这一次真的有没挪成的键才垫，垫的也只是那几个键，别的键一概原样。
 */
export function keepLegacyReadable(storage: object, stuck: readonly StuckKey[], proto: StoragePrototype = Storage.prototype): void {
  if (stuck.length === 0) return;
  const entries = pending.get(storage) ?? new Map<string, StuckKey>();
  for (const entry of stuck) entries.set(entry.key, entry);
  pending.set(storage, entries);
  if (patched.has(proto)) return;
  patched.add(proto);
  const { getItem, setItem, removeItem } = proto;
  proto.getItem = function (this: Storage, key: string) {
    const value = getItem.call(this, key);
    if (value !== null) return value;
    const entry = pending.get(this)?.get(String(key));
    return entry ? (getItem.call(this, entry.legacyKey) ?? entry.value) : null;
  };
  proto.setItem = function (this: Storage, key: string, value: string) {
    const entry = pending.get(this)?.get(String(key));
    if (!entry) return setItem.call(this, key, value);
    // 存储本来就快满了，旧值自己占着那块地方：先让出来再写；写不进去就放回去，照常把错抛给调用方。
    removeItem.call(this, entry.legacyKey);
    try {
      setItem.call(this, key, value);
    } catch (error) {
      try { setItem.call(this, entry.legacyKey, entry.value); } catch { /* 还有内存里那份 */ }
      throw error;
    }
    pending.get(this)?.delete(String(key));
  };
  proto.removeItem = function (this: Storage, key: string) {
    removeItem.call(this, key);
    const entry = pending.get(this)?.get(String(key));
    if (!entry) return;
    pending.get(this)?.delete(String(key));
    removeItem.call(this, entry.legacyKey);
  };
}
