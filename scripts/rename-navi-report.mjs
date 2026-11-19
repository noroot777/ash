// 改名脚本 --report 的输出：ash 那一部分的分组由 scripts/rename-navi.mjs 认好交过来，这里排版。
// 「更早一代 harness」那一节在这里认：整词搜 harness，每处按下面的规则说清为什么留着。
// 规则按顺序认，命中第一条就算；一条都不中的归到 unclassified，清单里单独列出来等人看。
// 本文件整份不进改名（scripts/rename-navi.mjs 的 SKIP_FILES）：这里的旧名是规则本身。

const B = String.raw`(?<![A-Za-z0-9])`;
export const HARNESS_TOKEN = new RegExp(String.raw`${B}harness(?![a-z0-9])|${B}Harness(?![a-z0-9])|(?<=[a-z0-9])Harness(?![a-z0-9])|${B}HARNESS(?![A-Za-z0-9])|${B}HARNESS(?=[A-Z][a-z])`);

const REGISTRY = new Set(["shared/src/legacy-names.ts", "scripts/legacy-names.mjs"]);

export const HARNESS_RULES = [
  { id: "legacy-registry", why: "旧名登记处：更早一代的名字只在这两份里登记，别处要认就从这里取", test: (path) => REGISTRY.has(path) },
  { id: "legacy-env", why: "环境变量的更早一代前缀 HARNESS_：读的时候在 NAVI_、ASH_ 之后兜底认（scripts/env.mjs、shared/src/env-names.ts），测试里照旧名喂进去", re: /HARNESS_/ },
  { id: "legacy-db", why: "更早一代的库文件名 harness.db：启动时就地改名成 navi.db（server/src/db/path.ts）", re: /harness\\?\.db|HARNESS_DB_FILE/ },
  { id: "legacy-stored-keys", why: "浏览器、手机本机存储里更早一代的键（harness.baseURL、harness-next: 前缀）：升级时整批挪到 navi 前缀", re: /harness[.-](?:baseURL|apiKey|next)|harness\.\*|harness-next:/ },
  { id: "repo-dir", why: "仓库检出目录的路径或以目录命名的项目（本机 ~/code/harness）：那是文件夹名，不是产品名；挪目录是本地目录迁移那一步的事", re: /code[\\/]+harness|[\\/]harness[\\/](?:data|\.worktrees)|name: "harness", (?:repoPath|myRole)|projectName: "harness"|^\s*name: "harness",$|projectOf\([^)]*"harness"|query === "harness"|\["harness", "project:/ },
  { id: "legacy-branch-prefix", why: "更早一代的任务分支前缀 harness/：升级前建的分支照样认得", re: /harness\/|\|harness\)\\?\/|harness\/\*|harness branches/ },
  { id: "legacy-mcp-name", why: "MCP 服务更早一代的登记名 harness：setup 迁成新名、注入检查与多来源解析都认它", re: /mcp_servers|mcp__|MCP|登记|legacyName|serverName|disabled_mcp_servers|name: "harness", status|harness: \{|listed\("harness"/, files: /mcp|review-channel-gap/i },
  { id: "test-harness-word", why: "英文词 test harness（测试台子）：文件名、函数名里的这个词不是产品名", re: /harness\.(?:js|ts|mjs)|startHarness|baselineHarness|function harness\(|= harness\(|[hH]arness\(\)|<Harness|harness\.\w+\(|const harness\b|= harness;|\bharness,|function Harness/ },
  { id: "generation-list", why: "逐代列出产品名：兼容逻辑的说明，或测试里把每一代名字都喂一遍", re: /harness → ash|ash[、 /|]+harness|harness[、 /]+ash|"ash", "harness"|三代|两代|历史名|旧名|旧键|Harness_Task_Id/ },
  { id: "older-prose", why: "更早改名（harness → ash）那次没换掉的叙述、示例和临时目录名：说的是产品，但不是兼容值；本次只换 ash，这些不在范围里，原样留着", re: /\?q=harness|harness 一条消息|harness 自己的|tmpdir\(\), "harness-/ },
  { id: "repo-dir-migration", why: "本地目录迁移（改名第 ⑥ 步）的脚本、回归和说明：讲的是把检出目录 harness 搬成 navi，harness 是那个目录（和它的兄弟目录、会话目录）的名字；测试里各代环境变量前缀一并擦掉",
    test: (path) => /^(docs\/relocate-checkout\.md|scripts\/(test-)?relocate-checkout[\w-]*\.mjs)$/.test(path) },
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

// 正文认不准、改名和核对都整次拒绝的（返回 2）：理由和出路。分类见 scripts/rename-navi.mjs 的 decode。
const FIX_HINT = "是二进制就把扩展名登记进 BINARY（scripts/rename-navi.mjs），是文本就转成 UTF-8、NUL 写成转义（\\u0000）";
export const OPAQUE_WHY = {
  nul: `含 NUL 字节，认不准是文本还是二进制（二进制里有长度字段，换了名会坏；UTF-16 文本里的 ash 字节不连着）。${FIX_HINT}`,
  undecodable: `不是合法的 UTF-8，按文本改写会毁掉别的字节，里面有没有 ash 也认不准。${FIX_HINT}`,
};

/**
 * 整份剩余清单。第一个参数是 scripts/rename-navi.mjs 规划的结果，第二个是它那边的名单、理由与认词。
 */
export function renderReport({ kept, ruleFiles, files, readText, opaque }, { registryFiles, toolingFiles, remaining, why, token }) {
  const groups = new Map();
  for (const k of kept) groups.set(k.why, [...(groups.get(k.why) ?? []), k]);
  const tokenLines = (path) => (readText(path) ?? "").split("\n").flatMap((text, i) => (token.test(text) ? [{ path, line: i + 1, text }] : []));
  const registry = registryFiles.flatMap(tokenLines);
  if (registry.length) groups.set("legacy-registry", registry);
  const lines = [
    "# 改名剩余清单",
    "",
    "由 `node scripts/rename-navi.mjs --report` 生成，是生成那一刻的快照：行号会随后续改动漂移，要最新的就重新生成。",
    "第一部分是整词 ash（产品的上一代名字），第二部分单列更早一代 harness。",
    "",
    `# 一、ash（${kept.length + registry.length + ruleFiles.length} 处）`,
    "",
  ];
  for (const [id, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${id}（${items.length} 处）`, "", why[id], "");
    for (const k of items) lines.push(`- ${k.path}:${k.line}  ${k.text.trim().slice(0, 160)}`);
    lines.push("");
  }
  lines.push(`## rule-file（${ruleFiles.length} 处）`, "", "规则文件由人改写（每处多一个字节，脚本不碰，见 scripts/rule-guard.mjs）；这里是改完之后仍留着的", "");
  for (const k of ruleFiles) lines.push(`- ${k.path}:${k.line}  ${k.text.trim().slice(0, 160)}`);
  lines.push("", "## rename-tooling", "", "改名自己的脚本和交付文档：旧名是规则与说明本身，只记数，不逐行列", "");
  for (const path of toolingFiles) if (path !== remaining && files.includes(path)) lines.push(`- ${path}：${tokenLines(path).length} 行`);
  // 正文没按文本读的（文件名照常挪，不在这里说）：认不准的每一份都列；登记过的二进制只列字节里出现了 ash 的。
  const unread = [...opaque].filter(([, { kind, tokens }]) => kind !== "binary" || tokens);
  if (unread.length) {
    lines.push("", `## not-text（${unread.length} 份）`, "", "正文没有按文本读的文件", "");
    for (const [path, { kind }] of unread) lines.push(`- ${path}：${OPAQUE_WHY[kind] ?? "登记过的二进制格式，正文不看；字节里出现了 ash"}`);
  }
  lines.push("", ...harnessSection(files.filter((path) => !toolingFiles.includes(path)), readText));
  return lines.join("\n") + "\n";
}
