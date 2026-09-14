export interface PreviewServiceConfig {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
  kind: "web" | "service";
}

/**
 * 启动命令跑起来之后，**它自己**该起多大一摊。ash 只把这个选择作为 `$ASH_PREVIEW_MODE`
 * 递给命令，起不起后端是命令自己的事 —— 不认这个变量的项目，四档全都一样。
 *
 * 值域里那几个「独立新库 / 测试库快照」的说法是照 ash 自带的 `scripts/dev.mjs` 写的：
 * 它是目前唯一认这个变量的脚本，而这几档正是照着「验一个 ash 分支要什么」定的。
 */
export const PREVIEW_MODE = ["command", "frontend", "full", "test"] as const;
export type PreviewMode = (typeof PREVIEW_MODE)[number];
export const PREVIEW_MODE_LABELS: Record<PreviewMode, string> = {
  command: "按项目启动命令",
  frontend: "只启动前端",
  full: "前后端全启动（独立新库）",
  test: "前后端 + 测试库快照",
};

export interface ProjectPreviewConfig {
  mode: "script" | "services";
  proxy: "auto" | "on" | "off";
  primaryServiceId: string | null;
  services: PreviewServiceConfig[];
  /**
   * 递给启动命令的 `$ASH_PREVIEW_MODE`。**老配置里没有这个字段**，读出来一律补
   * `"frontend"` —— 那是这个字段存在之前写死的值，补别的会让所有存量项目的预览
   * 在一次升级里悄悄换一种起法。
   */
  launch: PreviewMode;
}

export interface DetectedPreviewService extends PreviewServiceConfig {
  directory: string;
}

export interface WorkspacePreviewInput {
  workspace: true;
  command?: string;
  config?: ProjectPreviewConfig;
  stepId?: string;
}

export interface WorkspacePreviewLaunch {
  kind: "free" | "workflow";
  reason: string;
  directory: string | null;
  candidates: Array<DetectedPreviewService & { requiresSelection?: boolean }>;
  configured: { command: string; config?: ProjectPreviewConfig } | null;
  steps: Array<{ id: string; command: string }>;
  truncated: boolean;
}

export interface PreviewServiceState {
  id: string;
  name: string;
  command: string;
  status: "starting" | "ready" | "stopped" | "failed";
  url: string | null;
  port: number | null;
  /**
   * ash 借给这个服务的端口。跟 `port` 不一样时说明**命令没吃它**，自己挑了一个 —— 那正是
   * 「$PORT 没写进命令」的唯一症状（判读与后果见 previewPortDrift）。老记录里没有这个字段，
   * 读出来是 null，那时一律当成「不知道」，不提任何意见。
   */
  lentPort: number | null;
}

export const MAX_PREVIEW_SCRIPT_LENGTH = 16_000;
export const MAX_PREVIEW_SERVICES = 8;

export function previewProxyEnabled(setting: ProjectPreviewConfig["proxy"] | undefined, multi: boolean): boolean {
  return setting === "on" || (setting !== "off" && multi);
}

/**
 * 存着的项目预览配置里那一档启动范围，**宽容读**：整份配置坏掉、字段没有、值不认识，
 * 一律当 `"frontend"`。
 *
 * 为什么不复用会抛的 `parsePreviewConfig`：这个值的用处是「递一个 env 给启动命令」，
 * 一份历史遗留的坏配置不该因此挡住任务里临时填的那条命令 —— 真要报配置错，是保存
 * 那一刻的事，不是开预览这一刻。
 */
export function previewLaunchOf(stored: unknown): PreviewMode {
  const value = stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as Record<string, unknown>).launch : undefined;
  return PREVIEW_MODE.includes(value as PreviewMode) ? value as PreviewMode : "frontend";
}

export function parsePreviewConfig(value: unknown): ProjectPreviewConfig | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("预览配置格式不正确");
  const v = value as Record<string, unknown>;
  if (v.mode !== "script" && v.mode !== "services") throw new Error("请选择脚本或服务列表");
  if (v.proxy !== "auto" && v.proxy !== "on" && v.proxy !== "off") throw new Error("请选择预览访问方式");
  if (!Array.isArray(v.services) || v.services.length > 40) throw new Error("服务列表最多保存 40 项");
  const ids = new Set<string>();
  const services = v.services.map((item): PreviewServiceConfig => {
    if (!item || typeof item !== "object") throw new Error("服务配置格式不正确");
    const s = item as Record<string, unknown>;
    if (typeof s.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.id) || ids.has(s.id)) throw new Error("服务标识无效或重复");
    ids.add(s.id);
    if (typeof s.name !== "string" || !s.name.trim() || s.name.length > 160) throw new Error("请填写服务名称（最多 160 字）");
    if (typeof s.command !== "string" || s.command.length > MAX_PREVIEW_SCRIPT_LENGTH || s.command.includes("\0")) throw new Error("服务脚本无效或过长");
    if (typeof s.enabled !== "boolean" || (s.kind !== "web" && s.kind !== "service")) throw new Error("服务类型或选择状态不正确");
    if (s.enabled && !s.command.trim()) throw new Error(`请填写「${s.name}」的启动脚本`);
    return { id: s.id, name: s.name.trim(), command: s.command.trim(), enabled: s.enabled, kind: s.kind };
  });
  const selected = services.filter((s) => s.enabled);
  if (selected.length > MAX_PREVIEW_SERVICES) throw new Error(`一次最多启动 ${MAX_PREVIEW_SERVICES} 个服务`);
  if (v.mode === "services" && !selected.length) throw new Error("请至少选择一个服务");
  const primary = v.primaryServiceId;
  if (primary !== null && (typeof primary !== "string" || !selected.some((s) => s.id === primary))) throw new Error("默认预览服务必须在已选服务中");
  // 缺省而不是报错：这个字段是后加的，存量配置里一条都没有，按老行为补齐。
  const launch = v.launch === undefined || v.launch === null ? "frontend" : v.launch;
  if (!PREVIEW_MODE.includes(launch as PreviewMode)) throw new Error("请选择预览的启动范围");
  return withoutBlankServices({ mode: v.mode, proxy: v.proxy, primaryServiceId: primary as string | null, services, launch: launch as PreviewMode });
}

// ── 端口怎么写进启动命令 ────────────────────────────────────────────────────
//
// 新用户在「自填启动命令」里写的第一条命令几乎一定是 `npm run dev`，然后预览要么起在一个
// ash 不知道的端口上，要么跟他自己已经在跑的那份撞车。这不是他填错了 —— 是**填字的地方
// 没人告诉他这件事**：`$PORT` 的完整说明只在设置页的「配置说明与示例」对话框里，而打开
// 预览的人根本不会路过那儿。
//
// 所以下面这几样东西给**两个填字现场共用**（任务里的自填框、项目设置的启动脚本）：
//
//   · 变量引用按 shell 方言写（POSIX `$PORT`、Windows cmd `%PORT%`）。写错方言不会报错，
//     `$PORT` 在 cmd 上就是个**字面量**，端口静默失效 —— 那正是 preview-shell.ts 顶上记的
//     那次漏判，所以示例文案一个字都不硬编码方言。
//   · 一句判据排在示例前面。判据比示例要紧得多：运行时分两半，**一半自己读 PORT 环境
//     变量、根本不用写**（Next / Nest / Express / Spring Boot / Go），另一半只认命令行参数、
//     不写就白借（Vite / Angular / Astro / Django / Rails / Laravel）。只给示例不给判据，
//     用户要么照抄一条不适合自己框架的，要么以为所有命令都得加 `--port`——给只认 PORT 的
//     程序多塞一个未知参数，有的直接报错退出（见 server/src/preview-command.ts 的 PORT_ARG_TOOLS）。
//
// 这里**故意不做「命令里没写 $PORT 就报警」那种检查**：那一半不用写的命令会全部被误报，
// 而误报会让用户学到一条错规则（「都得加 --port」），比不提示更糟。唯一确定无疑、因此值得
// 当场拦的只有方言错配 —— 见 wrongPortDialectHint。

export type PreviewPortDialect = "posix" | "cmd";

/** 服务端那台机器的 shell 方言。预览命令跑在 server 上，浏览器所在的系统不算数。 */
export function previewPortDialect(platform: string | null | undefined): PreviewPortDialect {
  return platform === "win32" ? "cmd" : "posix";
}

/** 一个预览变量的引用写法：`$PORT` / `%PORT%`。 */
export function previewPortRef(name: string, dialect: PreviewPortDialect): string {
  return dialect === "cmd" ? `%${name}%` : `$${name}`;
}

/**
 * 「这条命令要不要写端口」的判据。
 *
 * 拆成「引子 + 两个分支」而不是一整句话，是因为这块的价值全在**对照**上：用户要在自己的
 * 框架属于哪一半上做一次判断，而一段三行长的连续散文读不出「这是二选一」。放得下的地方
 * 摆成两行（任务里的自填框），只有一行小字的地方用 previewPortRuleText 拼回一句。
 */
export interface PreviewPortRule {
  lead: string;
  branches: Array<{ when: string; then: string }>;
}

export function previewPortRule(dialect: PreviewPortDialect): PreviewPortRule {
  const port = previewPortRef("PORT", dialect);
  return {
    lead: `ash 每次开预览都借一个空闲端口，用 ${port} 传给你的命令。`,
    branches: [
      {
        when: "服务自己读 PORT 环境变量（Next、Nest、Express、Spring Boot、Go…）",
        then: "不用写，npm run dev 就行",
      },
      {
        when: "服务只认命令行参数（Vite、Angular、Astro、Django、Rails、Laravel…）",
        then: `必须把 ${port} 写进命令，否则它照配置里写死的端口起 —— 同一个项目已经有一份在跑时必然撞车`,
      },
    ],
  };
}

/** 判据拼成一句话。给只放得下一行小字的地方（项目设置里的脚本说明）。 */
export function previewPortRuleText(dialect: PreviewPortDialect): string {
  const rule = previewPortRule(dialect);
  return `${rule.lead}${rule.branches.map(({ when, then }) => `${when}：${then}`).join("；")}。`;
}

export interface PreviewCommandSample {
  /** 这条示例适用于哪一类。 */
  label: string;
  /** 整行命令，可以直接填进输入框。 */
  command: string;
}

/** 可以直接点进输入框的起手式。三条覆盖两类运行时 + 一条进子目录的写法。 */
export function previewCommandSamples(dialect: PreviewPortDialect): PreviewCommandSample[] {
  const port = previewPortRef("PORT", dialect);
  return [
    { label: "Vite / Angular / Astro", command: `npm run dev -- --port ${port}` },
    { label: "Next / Nest / Express（读 PORT，不用写）", command: "npm run dev" },
    { label: "前端在子目录里", command: `cd web && npm run dev -- --port ${port}` },
  ];
}

/**
 * 方言写反了就当场说。**这是唯一一条零误报的静态检查**，所以也是唯一一条填字时会主动弹
 * 出来的：`$PORT` 在 cmd 上、`%PORT%` 在 sh 上都不是「引用一个变量」，而是一串原样传下去
 * 的字面量，跑起来不报任何错，只是端口没进去。照抄别处文档的人一定会踩，而踩了看不出来。
 */
export function wrongPortDialectHint(command: string, dialect: PreviewPortDialect): string | null {
  if (dialect === "cmd" && /\$\{?PORT\d?\}?/.test(command)) {
    return "这台 ash 跑在 Windows 上，命令交给 cmd 执行：$PORT 在那儿是一串字面量，不是变量。请改写成 %PORT%。";
  }
  if (dialect === "posix" && /%PORT\d?%/.test(command)) {
    return "这台 ash 跑在类 Unix 系统上，命令交给 sh 执行：%PORT% 在那儿是一串字面量，不是变量。请改写成 $PORT。";
  }
  return null;
}

// ── 端口漂移：命令没吃 ash 借的那个端口 ────────────────────────────────────
//
// 填字时的那些提示（判据、起手式、方言检查）本质都是**说明**——用户可以不读，而且大部分
// 时候他确实不读。这一节是另一回事：它不是推断出来的规则，是**已经发生的事实**——服务此刻
// 真的听在 5173 上，ash 借出去的 45843 真的没人要。
//
// 这条信号有三个别处都拿不到的性质：
//   · **零误报**，因为它不是猜的。静态看命令永远分不清 `npm run dev` 背后是 vite 还是 next；
//     跑起来之后不用分——端口对不上就是对不上。
//   · **不挑语言**。不用读 package.json、不用认框架，Java / Go / Rails / 一段私有脚本全都覆盖。
//   · **平时完全不出现**。命令写对了就没有这回事，所以它不占版面、不构成噪音——这正是
//     「常驻文案」做不到的：文案永远在那儿，久了就成了背景。
//
// 代价是它只能**事后**说。但事后说反而更值：这时候用户正看着一个刚起好的预览，话里的
// 两个端口号都是他自己的，比任何通用示例都具体。
//
// `fixed` 是这一节真正的分量所在：命令文本里出现过那个写死的端口号时，把它换成 $PORT 是
// 一次**确定的改写**——那个数字就是服务实际绑上的端口，不是猜的。换不出来（端口写在
// vite.config.ts / application.yml 里）就老实给 null，由界面改口说「它来自配置文件」，
// 而不是编一条看着像对的命令。

export interface PreviewPortDrift {
  serviceId: string;
  serviceName: string;
  /** ash 借出去的那个。 */
  lent: number;
  /** 服务实际听的那个。 */
  actual: number;
  /** 把命令里写死的那个端口号换成端口变量之后的整行命令；命令里没有它就是 null。 */
  fixed: string | null;
}

/**
 * 哪些服务没吃 ash 借的端口。`lentPort` 缺失（老记录）或状态不是 ready 的一律跳过 ——
 * 还没起来的服务谈不上「起在哪儿」。
 */
export function previewPortDrift(
  services: readonly PreviewServiceState[],
  dialect: PreviewPortDialect,
): PreviewPortDrift[] {
  return services.flatMap((service) => {
    const { lentPort: lent, port: actual } = service;
    // 用真值判断而不是 `=== null`：这两个字段的来源是盘上的 preview.json 和跨版本的接口，
    // 老记录里 lentPort 压根不存在（是 undefined，`=== null` 拦不住），漏过去就会渲染出一条
    // 「起在 5173，不是 ash 借的 undefined」。端口不可能是 0，所以真值判断在这里没有代价。
    if (service.status !== "ready" || !lent || !actual || lent === actual) return [];
    return [{
      serviceId: service.id,
      serviceName: service.name,
      lent,
      actual,
      fixed: rewritePinnedPort(service.command, actual, dialect),
    }];
  });
}

/**
 * 命令里那个写死的端口号 → 端口变量。命令里根本没有这个数字就返回 null。
 *
 * 边界只用一条 `\b`：`--port 5173`、`-p 5173`、`PORT=5173`、`0.0.0.0:5173`、
 * `http://localhost:5173/` 全都该换，而 `cd project5173` 不该 —— 后者的 `5173` 两边都是
 * 词字符，`\b` 天然不匹配。多处出现就全换：一条命令里同一个端口号出现两次（自己听 + 打给
 * 自己的地址），换一处留一处才是坏的。
 */
function rewritePinnedPort(command: string, actual: number, dialect: PreviewPortDialect): string | null {
  const pattern = new RegExp(`\\b${actual}\\b`, "g");
  if (!pattern.test(command)) return null;
  return command.replace(new RegExp(`\\b${actual}\\b`, "g"), previewPortRef("PORT", dialect));
}

// 「手动添加」后没填脚本又没勾选就离开，会留下一条空壳服务。它启动不了任何东西，
// 却会被存进配置、下次打开「选择服务」时凭空出现，看着像系统自动加的。存取两头都丢掉。
export function withoutBlankServices(config: ProjectPreviewConfig): ProjectPreviewConfig {
  const services = config.services.filter((s) => s.command.trim() || s.enabled);
  if (services.length === config.services.length) return config;
  return { ...config, services, primaryServiceId: services.some((s) => s.id === config.primaryServiceId) ? config.primaryServiceId : null };
}
