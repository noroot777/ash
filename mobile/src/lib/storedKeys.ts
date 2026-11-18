// 手机端本机存储（AsyncStorage）里的键。项目改过两次名（harness → ash → navi），老版本存下的
// 服务器地址和 key 还挂在旧名上：读的时候新键没有就按顺序找旧键，找到了挪到新键、旧的删掉。
//
// 旧键是兼容值：批量改名时别把它们也换成 navi，不然旧数据就没人认了。
// 注意它管不到的那一种：Expo Go 按 app.json 的 slug 给每个应用分一块存储，slug 从 ash 换成 navi
// 之后，Expo Go 里打开的是另一块地，旧的那块这里读不到 —— 那种情况只能在设置页重填一次。
export const STORED_KEYS = {
  baseURL: { current: "navi.baseURL", legacy: ["ash.baseURL", "harness.baseURL"] },
  apiKey: { current: "navi.apiKey", legacy: ["ash.apiKey"] },
} as const;

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * 读一个键；新键没有时从旧键里取，取到就挪到新键（新键已经有了，旧的直接作废）。
 *
 * 挪和删只是顺手的兼容清理，失败了不能拖住启动：读到的值照样返回，写不进新键时旧键留着（它就是「下次
 * 再挪」的记号），删不掉的旧键下次再删。只有读本身出错才往外抛。
 */
export async function readStoredKey(
  store: KeyValueStore,
  { current, legacy }: { current: string; legacy: readonly string[] },
): Promise<string | null> {
  let value = await store.getItem(current);
  for (const key of legacy) {
    const old = await store.getItem(key);
    if (old === null) continue;
    try {
      if (value === null) {
        value = old;
        await store.setItem(current, old);
      }
      await store.removeItem(key);
    } catch (error) {
      console.warn(`[navi] ${key} → ${current} 这次没挪成，下次启动再挪`, error);
    }
  }
  return value;
}
