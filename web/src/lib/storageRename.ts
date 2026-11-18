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
// 写不进去（存储快满）时**旧键一个字都不动**：先删旧的再写新的，一旦新的也写不进、旧的又放不回去，
// 用户存下的唯一一份就只剩这一页的内存，一刷新就没了。所以只有新键确实写进去了才删旧键；写不进就把这一条
// 暂缓改名，由 `keepLegacyReadable` 让读新键的地方读旧键、写新键写不下时在旧键原地更新，下次启动再挪。
// 按前缀枚举键的地方要用 `storageKeys`：它把这些暂缓的旧键按新名列出来，`Object.keys(localStorage)` 列的是
// 物理上的旧名，拿新前缀一过滤就漏了。
//
// 下面这张表里的旧前缀是兼容值：批量改名时别把它们也换成 navi，不然旧数据就没人认了。
export const LEGACY_STORAGE_PREFIXES: readonly (readonly [legacy: string, current: string])[] = [
  // 排在前面的那一代更新：同一个新键有好几份旧值时取最前面那份。
  ["ash:", "navi:"],
  ["ash.", "navi."],
  ["harness-next:", "navi:"],
];

type KeyValueStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

/** 这一次没挪成的那一条：新键名，和旧值原样留着的旧键名。 */
export interface StuckKey {
  key: string;
  legacyKey: string;
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
    try {
      storage.setItem(target, winner.value);
    } catch {
      result.stuck.push({ key: target, legacyKey: winner.key }); // 写不进去：旧键原样留着，见文件头
      continue;
    }
    storage.removeItem(winner.key);
    result.moved++;
  }
  return result;
}

type StoragePrototype = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const pending = new WeakMap<object, Map<string, StuckKey>>();
const patched = new WeakSet<object>();

/**
 * 这一次没挪成的那几条：读新键的地方照样读到旧键里的值；写新键时能写进新键就写进去、旧键随之作废，写不下
 * 就在旧键原地更新（旧键本来就占着那块地方，名字还短一点）；原地也写不下就照常把错抛给调用方，旧内容不动。
 * 删新键连旧键一起删。各处读存储都直接调 `localStorage.getItem`，所以垫在 Storage 的原型上；只有这一次真的
 * 有没挪成的键才垫，垫的也只是那几个键，别的键一概原样。
 */
export function keepLegacyReadable(storage: object, stuck: readonly StuckKey[], proto: StoragePrototype = Storage.prototype): void {
  if (stuck.length === 0) return;
  const entries = pending.get(storage) ?? new Map<string, StuckKey>();
  for (const entry of stuck) entries.set(entry.key, entry);
  pending.set(storage, entries);
  if (patched.has(proto)) return;
  patched.add(proto);
  const { getItem, setItem, removeItem } = proto;
  const entryFor = (self: object, key: string) => pending.get(self)?.get(String(key));
  proto.getItem = function (this: Storage, key: string) {
    const value = getItem.call(this, key);
    if (value !== null) return value;
    const entry = entryFor(this, key);
    return entry ? getItem.call(this, entry.legacyKey) : null;
  };
  proto.setItem = function (this: Storage, key: string, value: string) {
    const entry = entryFor(this, key);
    if (!entry) return setItem.call(this, key, value);
    try {
      setItem.call(this, key, value);
    } catch {
      setItem.call(this, entry.legacyKey, value); // 新键写不下：旧键原地更新；这也写不下就抛给调用方
      return;
    }
    pending.get(this)?.delete(String(key));
    removeItem.call(this, entry.legacyKey);
  };
  proto.removeItem = function (this: Storage, key: string) {
    removeItem.call(this, key);
    const entry = entryFor(this, key);
    if (!entry) return;
    pending.get(this)?.delete(String(key));
    removeItem.call(this, entry.legacyKey);
  };
}

/** 这份存储里的键，按新名列：还没挪成、暂留在旧键上的那几条列成新键名（同 `getItem` 看到的一致）。 */
export function storageKeys(storage: Pick<Storage, "length" | "key">): string[] {
  const renamed = new Map([...(pending.get(storage)?.values() ?? [])].map((entry) => [entry.legacyKey, entry.key]));
  const keys = new Set<string>();
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) keys.add(renamed.get(key) ?? key);
  }
  return [...keys];
}
