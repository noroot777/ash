// kimi 的宿主登记 —— 现在只是 `mcp-hosts.mjs` 那张通用表的一个薄壳。
//
// 为什么留着这个名字:`setup.mjs` 和 `test-kimi-mcp.mjs` 都在用它,而 kimi 这一家本身没有
// 任何特殊性(`<KIMI_CODE_HOME>/mcp.json` + `mcpServers`,跟 gemini/cursor 同一个格式族)。
// 2026-10-31 把实现收进通用那份:原来这里是**唯一**一家有写入器的「其它 CLI」,再多接一家
// 就会变成第二份拷贝。
import { registerHostMcp } from "./mcp-hosts.mjs";

export function registerKimiMcp({ configDir, mcpEntry, url, nodeBin = process.execPath }) {
  return registerHostMcp({
    agentType: "kimi",
    mcpEntry,
    url,
    nodeBin,
    // 调用方给的就是最终那个配置目录,所以直接当 KIMI_CODE_HOME 交进去。
    env: { KIMI_CODE_HOME: configDir },
  });
}
