// 手机端本机存储改名：服务器地址、key 从 ash.* / harness.* 挪到 navi.*。跑：cd mobile && npm run test:stored-keys
// 钉住：只有旧键时读得到、挪到新键、旧键删掉；新旧都在时以新键为准、旧键作废；都没有时是 null、不写任何东西；
// 两代旧名（harness → ash）按顺序都认；挪或删失败时读到的值照样返回、不拖住启动，旧键留着下次再挪；
// config.ts 读写的就是这里的新键。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readStoredKey, STORED_KEYS } from "../src/lib/storedKeys.ts";

function memory(entries = {}, failing = { set: false, remove: false }) {
  const map = new Map(Object.entries(entries));
  const writes = [];
  return {
    map,
    writes,
    failing,
    async getItem(key) { return map.has(key) ? map.get(key) : null; },
    async setItem(key, value) { if (failing.set) throw new Error("disk full"); writes.push(key); map.set(key, value); },
    async removeItem(key) { if (failing.remove) throw new Error("io error"); writes.push(`-${key}`); map.delete(key); },
  };
}

{
  const store = memory({ "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" });
  assert.equal(await readStoredKey(store, STORED_KEYS.baseURL), "http://192.168.1.5:4317");
  assert.equal(await readStoredKey(store, STORED_KEYS.apiKey), "ash_secret");
  assert.deepEqual(Object.fromEntries(store.map), { "navi.baseURL": "http://192.168.1.5:4317", "navi.apiKey": "ash_secret" });
}

{
  const store = memory({ "harness.baseURL": "http://old:4317" });
  assert.equal(await readStoredKey(store, STORED_KEYS.baseURL), "http://old:4317", "更早那一代的键也认");
  assert.deepEqual(Object.fromEntries(store.map), { "navi.baseURL": "http://old:4317" });
}

{
  const store = memory({ "navi.baseURL": "http://new:4317", "ash.baseURL": "http://stale:4317", "harness.baseURL": "http://older:4317" });
  assert.equal(await readStoredKey(store, STORED_KEYS.baseURL), "http://new:4317", "新键在就以新键为准");
  assert.deepEqual(Object.fromEntries(store.map), { "navi.baseURL": "http://new:4317" }, "旧键作废");
}

{
  const store = memory({ "ash.baseURL": "http://ash:4317", "harness.baseURL": "http://harness:4317" });
  assert.equal(await readStoredKey(store, STORED_KEYS.baseURL), "http://ash:4317", "两代都在时取较新的 ash 那一份");
  assert.deepEqual(Object.fromEntries(store.map), { "navi.baseURL": "http://ash:4317" });
}

{
  const store = memory();
  assert.equal(await readStoredKey(store, STORED_KEYS.apiKey), null);
  assert.deepEqual(store.writes, [], "什么都没有就什么都不写");
}

// 迁移写不进去 / 旧键删不掉：读到的地址和 key 照样能用，启动不被拖住；旧键留着，恢复之后下次启动挪完。
{
  const warn = console.warn;
  console.warn = () => {};
  try {
    const store = memory({ "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" }, { set: true, remove: false });
    assert.equal(await readStoredKey(store, STORED_KEYS.baseURL), "http://192.168.1.5:4317", "写新键失败也返回读到的地址");
    assert.equal(await readStoredKey(store, STORED_KEYS.apiKey), "ash_secret");
    assert.deepEqual(Object.fromEntries(store.map), { "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" }, "没挪成就不删旧键");
    store.failing.set = false;
    assert.equal(await readStoredKey(store, STORED_KEYS.baseURL), "http://192.168.1.5:4317");
    assert.deepEqual(Object.fromEntries(store.map), { "ash.apiKey": "ash_secret", "navi.baseURL": "http://192.168.1.5:4317" }, "下次启动挪完");

    const stuck = memory({ "navi.apiKey": "navi_key", "ash.apiKey": "stale" }, { set: false, remove: true });
    assert.equal(await readStoredKey(stuck, STORED_KEYS.apiKey), "navi_key", "删不掉旧键也不影响读新键");
    assert.equal(stuck.map.get("ash.apiKey"), "stale", "留着下次再删");
  } finally {
    console.warn = warn;
  }
}

{
  const config = readFileSync(new URL("../src/lib/config.ts", import.meta.url), "utf8");
  assert.match(config, /readStoredKey\(AsyncStorage, STORED_KEYS\.baseURL\)/);
  assert.match(config, /readStoredKey\(AsyncStorage, STORED_KEYS\.apiKey\)/);
  assert.doesNotMatch(config, /"(ash|harness)\.(baseURL|apiKey)"/, "旧键名只留在 storedKeys.ts");
  const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")).expo;
  assert.deepEqual([app.name, app.slug, app.scheme], ["Navi", "navi", "navi"]);
}
console.log("PASS stored keys: server address and key move from ash.* / harness.* to navi.*, and a failed move never blocks startup");
