// 改名脚本 --report 的「更早一代 harness」那一节：整词搜 harness，每处按下面的规则说清为什么留着。
// 规则按顺序认，命中第一条就算；一条都不中的归到 unclassified，清单里单独列出来等人看。
// 本文件整份不进改名（scripts/rename-navi.mjs 的 SKIP_FILES）：这里的旧名是规则本身。

const B = String.raw`(?<![A-Za-z0-9])`;
export const HARNESS_TOKEN = new RegExp(String.raw`${B}harness(?![a-z0-9])|${B}Harness(?![a-z0-9])|(?<=[a-z0-9])Harness(?![a-z0-9])|${B}HARNESS(?![A-Za-z0-9])|${B}HARNESS(?=[A-Z][a-z])`);

const REGISTRY = new Set(["shared/src/legacy-names.ts", "scripts/legacy-names.mjs"]);

export const HARNESS_RULES = [
  { id: "legacy-registry", why: "旧名登记处：更早一代的名字只在这两份里登记，别处要认就从这里取", test: (path) => REGISTRY.has(path) },
  { id: "legacy-env", why: "环境变量的更早一代前缀 HARNESS_：读的时候在 NAVI_、ASH_ 之后兜底认（scripts/env.mjs、shared/src/env-names.ts），测试里照旧名喂进去", re: /HARNESS_/ },
  { id: "legacy-db", why: "更早一代的库文件名 harness.db：启动时就地改名成 ash.db（server/src/db/path.ts）", re: /harness\\?\.db|HARNESS_DB_FILE/ },
  { id: "legacy-stored-keys", why: "浏览器、手机本机存储里更早一代的键（harness.baseURL、harness-next: 前缀）：升级时整批挪到 navi 前缀", re: /harness[.-](?:baseURL|apiKey|next)|harness\.\*|harness-next:/ },
  { id: "repo-dir", why: "仓库检出目录的路径或以目录命名的项目（本机 ~/code/harness）：那是文件夹名，不是产品名；挪目录是本地目录迁移那一步的事", re: /code[\\/]+harness|[\\/]harness[\\/](?:data|\.worktrees)|name: "harness", (?:repoPath|myRole)|projectName: "harness"|^\s*name: "harness",$|projectOf\([^)]*"harness"|query === "harness"|\["harness", "project:/ },
  { id: "legacy-branch-prefix", why: "更早一代的任务分支前缀 harness/：升级前建的分支照样认得", re: /harness\/|\|harness\)\\?\/|harness\/\*|harness branches/ },
  { id: "legacy-mcp-name", why: "MCP 服务更早一代的登记名 harness：setup 迁成新名、注入检查与多来源解析都认它", re: /mcp_servers|mcp__|MCP|登记|legacyName|serverName|disabled_mcp_servers|name: "harness", status|harness: \{|listed\("harness"/, files: /mcp|review-channel-gap/i },
  { id: "test-harness-word", why: "英文词 test harness（测试台子）：文件名、函数名里的这个词不是产品名", re: /harness\.(?:js|ts|mjs)|startHarness|baselineHarness|function harness\(|= harness\(|[hH]arness\(\)|<Harness|harness\.\w+\(|const harness\b|= harness;|\bharness,|function Harness/ },
  { id: "generation-list", why: "逐代列出产品名：兼容逻辑的说明，或测试里把每一代名字都喂一遍", re: /harness → ash|ash[、 /|]+harness|harness[、 /]+ash|"ash", "harness"|三代|两代|历史名|旧名|旧键|Harness_Task_Id/ },
  { id: "older-prose", why: "更早改名（harness → ash）那次没换掉的叙述、示例和临时目录名：说的是产品，但不是兼容值；本次只换 ash，这些不在范围里，原样留着", re: /\?q=harness|harness 一条消息|harness 自己的|tmpdir\(\), "harness-/ },
  { id: "history", why: "事故记录：写的是当时的名字", test: (path) => path === "docs/incidents.md" },
];

/** 逐行认 harness：返回 { id → [{ path, line, text }] }，没认出来的在 unclassified 下。 */
export function harnessInventory(files, readText) {
  const groups = new Map();
  for (const path of files) {
    const text = readText(path);
    if (text === null) continue;
    text.split("\n").forEach((line, i) => {
      if (!HARNESS_TOKEN.test(line)) return;
      const rule = HARNESS_RULES.find((r) => (r.test ? r.test(path) : r.re.test(line) || Boolean(r.files?.test(path))));
      const id = rule?.id ?? "unclassified";
      groups.set(id, [...(groups.get(id) ?? []), { path, line: i + 1, text: line }]);
    });
  }
  return groups;
}

/** 清单里 harness 那一节的各行。 */
export function harnessSection(files, readText) {
  const groups = harnessInventory(files, readText);
  const total = [...groups.values()].reduce((n, items) => n + items.length, 0);
  const lines = [`# 二、更早一代 harness（${total} 处）`, ""];
  for (const [id, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${id}（${items.length} 处）`, "", HARNESS_WHY[id], "");
    for (const k of items) lines.push(`- ${k.path}:${k.line}  ${k.text.trim().slice(0, 160)}`);
    lines.push("");
  }
  return lines;
}

export const HARNESS_WHY = Object.fromEntries([...HARNESS_RULES.map((r) => [r.id, r.why]), ["unclassified", "没有一条规则认得：要么补规则说清为什么留，要么它是漏改，该换掉"]]);
