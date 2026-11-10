// 供应商转发「这个请求走不走代理、走哪个」。优先级从高到低：
//   1. localhost / 127.0.0.1 / ::1 一律直连（本机供应商绕进代理只会失败）
//   2. 环境变量：http_proxy/HTTP_PROXY、https_proxy/HTTPS_PROXY（小写优先；https 没配时沿用 http 那个），
//      NO_PROXY 按 undici 的语义（`*` 全部直连；`域名`/`.域名` 匹配自身和子域；可带 `:端口`）
//   3. 两个代理变量都没配，才用系统代理（system-proxy.ts）；此时 NO_PROXY 仍然生效，和系统的绕过列表取并集
//   4. 系统也没配就直连
// 环境变量是整体优先：只配了 HTTP_PROXY 时 https 也走它，不会一半环境变量一半系统代理。
// 选中的代理连不上就是连不上，这里不做「代理失败改直连」—— 那会让代理/直连哪条路坏了都看不出来。
import { BlockList, isIP } from "node:net";
import { domainToASCII, domainToUnicode } from "node:url";
import { systemProxySettings, type BypassSyntax, type ProxyCredentials, type SystemProxySettings } from "./system-proxy.js";

export type ProxySource = "env" | "system" | "none";
export type ProxyPlan = {
  source: ProxySource;
  /** 进日志的来源说明，如 `环境变量 HTTPS_PROXY`、`系统代理（macOS）` */
  label: string;
  /** 代理地址，一律不含凭据 */
  http: string | null;
  https: string | null;
  /** 有 = 这个协议的代理要认证，值就是 Proxy-Authorization 头；凭据不放进地址（见 SystemProxySettings.credentials） */
  authorization: Partial<Record<"http" | "https", string>>;
  envNoProxy: string;
  systemBypass: BypassRule[];
  /** 系统里配了但没生效的设置（PAC 等），要原样告诉用户 */
  notice: string | null;
  /** 不知道系统要走哪个代理（读不到/地址写坏了）：除本机和 NO_PROXY 外一律拒绝，不能拿直连顶上 */
  unavailable: string | null;
  /** 读到了配置、但这个协议的代理地址无法解析：只拒绝这个协议、且没命中绕过列表的请求 */
  invalid: Partial<Record<"http" | "https", string>>;
  /** 同一份配置同一个 key，dispatcher 按它判断要不要重建 */
  key: string;
};
export type ProxyRoute = {
  proxy: string | null;
  authorization?: string;
  source: ProxySource;
  /** 直连的原因 */
  bypass?: "loopback" | "no_proxy" | "system";
  /** 不发出去，reason 说明为什么（整份配置没读到 / 这个协议的地址无法解析） */
  blocked?: true;
  reason?: string;
};

type BypassRule =
  | { kind: "simple"; ipToo?: true }
  | { kind: "cidr"; list: BlockList }
  | { kind: "host"; pattern: RegExp; port: number; scheme: string | null }
  /** GNOME：域名自身和点边界上的子域，可带端口 */
  | { kind: "domain"; name: string; port: number }
  /** KDE：原文按字符做后缀比较；exact 是 `scheme://主机` 那种只认整个主机的写法 */
  | { kind: "suffix"; text: string; exact: boolean };

const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function envValue(lower: string, upper: string): { name: string; value: string } {
  const lowerValue = process.env[lower];
  // Windows 的环境变量不分大小写，读 http_proxy 也会读到 HTTP_PROXY；日志里报用户实际写的那个名字
  const name = process.platform === "win32" ? Object.keys(process.env).find((key) => key.toLowerCase() === lower) ?? lower : lower;
  if (lowerValue !== undefined) return { name, value: lowerValue.trim() };
  return { name: upper, value: (process.env[upper] ?? "").trim() };
}

/** 没写 scheme 的按 http 代理处理（curl、Go 的约定），免得 `127.0.0.1:7890` 被当成 scheme 为 127.0.0.1 的地址 */
function normalizeProxy(value: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

/**
 * 要路由的那一跳。URL 规范化会把显式写出的默认端口（`:80`/`:443`）抹掉，而 GNOME、KDE 的端口规则分「写了端口」
 * 和「没写」（`port.test:80` 只配 `http://port.test:80/`，不配 `http://port.test/`），所以端口的写法从请求原文
 * （重定向那一跳从 Location 原文）单独带过来；0 = 没写。
 */
export type RouteTarget = { url: URL; explicitPort: number };

/** 地址原文里明写的端口；没有主机部分（相对地址）返回 null */
export function explicitPortOf(raw: string): number | null {
  const authority = raw.trim().match(/^(?:[a-z][a-z0-9+.-]*:)?[/\\]{2}([^/\\?#]*)/i)?.[1];
  if (authority === undefined) return null;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const port = hostPort.startsWith("[") ? hostPort.match(/^\[[^\]]*\]:(\d+)$/)?.[1] : hostPort.match(/:(\d+)$/)?.[1];
  return port ? Number(port) : 0;
}

export function routeTarget(raw: string): RouteTarget {
  return { url: new URL(raw), explicitPort: explicitPortOf(raw) ?? 0 };
}

const basicAuthorization = ({ user, password }: ProxyCredentials) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

/**
 * 代理地址 → 不含凭据的地址 + 认证头。credentials 是系统单独给的认证（有就是开了认证，两项都空也照发）；
 * 没给就看地址自己的 userinfo（环境变量、KDE 的写法），它是转义形式，解出原文再编码，解不开的按原文用。
 * 地址本身解析不了的原样留着，由 ProxyAgent 报错。
 */
function proxyEndpoint(proxy: string | null, credentials?: ProxyCredentials): { proxy: string | null; authorization?: string } {
  if (!proxy) return { proxy };
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    return { proxy };
  }
  const decode = (value: string) => {
    try { return decodeURIComponent(value); } catch { return value; }
  };
  const auth = credentials ?? (url.username || url.password ? { user: decode(url.username), password: decode(url.password) } : null);
  if (!auth) return { proxy };
  url.username = "";
  url.password = "";
  return { proxy: url.pathname === "/" && !url.search ? url.href.replace(/\/$/, "") : url.href, authorization: basicAuthorization(auth) };
}

function authorizations(http: { authorization?: string }, https: { authorization?: string }): ProxyPlan["authorization"] {
  return { ...(http.authorization ? { http: http.authorization } : {}), ...(https.authorization ? { https: https.authorization } : {}) };
}

/** 日志/报错里的代理地址：只留协议和主机端口，要认证的（地址里带凭据或 authorized）替换成 *** */
export function redactProxy(value: string | null, authorized = false): string {
  if (!value) return "直连";
  try {
    const url = new URL(value);
    return `${url.protocol}//${authorized || url.username || url.password ? "***@" : ""}${url.host}`;
  } catch {
    return "（无法解析的代理地址）";
  }
}

/** 掩码可以写成前缀长度，也可以写成点分掩码（KDE 认 `10.0.0.0/255.0.0.0`）；没写掩码（undefined）的是单个地址 */
function maskPrefix(mask: string | undefined, family: number): number {
  if (mask === undefined) return family === 6 ? 128 : 32;
  if (/^\d{1,3}$/.test(mask)) return Number(mask);
  if (isIP(mask) !== 4) return NaN;
  const bits = mask.split(".").map((part) => Number(part).toString(2).padStart(8, "0")).join("");
  return /^1*0*$/.test(bits) ? bits.replace(/0+$/, "").length : NaN;
}

function cidrRule(entry: string): BypassRule | null {
  const [address, mask] = entry.split("/", 2);
  let base = address.replace(/^\[|\]$/g, "");
  // macOS 允许 `169.254/16` 这种省掉尾部 0 的写法
  if (/^\d+(\.\d+){0,2}$/.test(base)) base = [...base.split("."), "0", "0", "0"].slice(0, 4).join(".");
  const family = isIP(base);
  const prefix = maskPrefix(mask, family);
  if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return null;
  const list = new BlockList();
  list.addSubnet(base, prefix, family === 4 ? "ipv4" : "ipv6");
  return { kind: "cidr", list };
}

/**
 * 规则里的字面主机和请求 URL 的 hostname 用同一种写法：国际化域名转 punycode（URL 本身就这么规范化），
 * IPv6 写成压缩形式。带通配的只逐段转换不含 `*` 的非 ASCII 段；纯 ASCII 段只小写，免得 `192` 这种数字段被当成 IPv4 改写。
 */
function canonicalHost(entry: string): string {
  if (isIP(entry) === 6) return new URL(`http://[${entry}]`).hostname.slice(1, -1);
  const host = entry.replace(/\.$/, "");
  if (!/[^\x00-\x7f]/.test(host)) return host;
  if (!host.includes("*")) return domainToASCII(host) || host;
  return host.split(".").map((label) => (/[^\x00-\x7f]/.test(label) && !label.includes("*") ? domainToASCII(label) || label : label)).join(".");
}

/**
 * GNOME（GSimpleProxyResolver）：IP 和 `IP/长度` 按网段判；`[v6]:端口`、`主机:端口` 只配 URL 里写明的那个端口
 * （没写端口的规则不限端口；URL 里写的默认端口会被 URL 规范化掉，按没写算）；其余去掉开头的 `*.` 或 `.`，
 * 不分大小写地配域名自身和点边界上的子域。GLib 只把请求主机转成 ASCII、规则原文不转，于是写成中文的规则在 GLib 里
 * 一条也配不上；这里规则也转，只多配上用户本来想直连的那些，GLib 判直连的一个不少。
 */
function gnomeBypassRule(entry: string): BypassRule | null {
  const [address, mask] = entry.split("/", 2);
  if (isIP(address) && (mask === undefined || /^\d+$/.test(mask))) return cidrRule(entry);
  let port = 0;
  const withPort = entry.match(/^\[([^\]]*)\]:(\d+)$/) ?? entry.match(/^([^:]*):(\d+)$/);
  if (withPort) [entry, port] = [withPort[1], Number(withPort[2])];
  const name = canonicalHost(isIP(entry) === 6 ? entry : entry.replace(/^\*?\./, ""));
  return name ? { kind: "domain", name, port } : null;
}

/**
 * KDE（KProtocolManager::shouldIgnoreProxyFor + revmatch）：每条从尾部逐字符比，规则先比完就算命中 ——
 * 没有点边界（`kde.org` 也配 `evilkde.org`）、`*` 不是通配、`.kde.org` 不配 `kde.org` 本身；`http://主机`
 * 只配整个主机。没配上且 URL 写了端口，再拿 `主机:端口` 比一次。`<local>` = 不带点的主机，网段只对 IP 字面量判
 * （KDE 会先把主机名解析成 IP 再判网段，这里不在转发路径上做 DNS，所以这种情况会走代理而不是直连）。
 */
function kdeBypassRule(entry: string): BypassRule | null {
  if (entry === "<local>") return { kind: "simple", ipToo: true };
  const schemeMatch = entry.match(/^[a-z][a-z0-9+.-]*:\/\/(.+)$/);
  if (schemeMatch) return { kind: "suffix", text: schemeMatch[1].replace(/\/+$/, ""), exact: true };
  if (entry.includes("/")) return cidrRule(entry);
  return { kind: "suffix", text: entry, exact: false };
}

/**
 * 系统绕过列表的一条规则，照它所在平台的语义编译（见 BypassSyntax）。macOS/Windows 用 Chromium 对这两处列表的
 * 解释：精确主机、`*` 通配、`.域名`=所有子域、可选 `scheme://` 与 `:端口`、CIDR、`<local>`=不带点的主机名
 */
export function parseBypassRule(raw: string, syntax?: BypassSyntax): BypassRule | null {
  let entry = raw.trim().toLowerCase();
  if (!entry) return null;
  if (syntax === "gnome") return gnomeBypassRule(entry);
  if (syntax === "kde") return kdeBypassRule(entry);
  if (entry === "<-loopback>") return null;
  if (entry === "<local>") return { kind: "simple" };
  let scheme: string | null = null;
  const schemeMatch = entry.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/);
  if (schemeMatch) [, scheme, entry] = schemeMatch;
  if (entry.includes("/")) return cidrRule(entry);
  let port = 0;
  const bracketed = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    entry = bracketed[1];
    port = Number(bracketed[2] ?? 0);
  } else if (!isIP(entry)) {
    const withPort = entry.match(/^(.+):(\d+)$/);
    if (withPort) [entry, port] = [withPort[1], Number(withPort[2])];
  }
  entry = canonicalHost(entry);
  if (entry.startsWith(".")) entry = `*${entry}`;
  const pattern = new RegExp(`^${entry.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return { kind: "host", pattern, port, scheme: scheme ? `${scheme}:` : null };
}

function systemBypassed(rules: BypassRule[], { url, explicitPort }: RouteTarget, port: number): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const family = isIP(host);
  // KDE 拿 Qt 显示用的主机名比（国际化域名是 Unicode），规则里写哪种形式都可能
  const kdeHosts = [...new Set([host, domainToUnicode(host) || host])];
  return rules.some((rule) => {
    if (rule.kind === "simple") return (rule.ipToo || !family) && !host.includes(".");
    if (rule.kind === "cidr") return family !== 0 && rule.list.check(host, family === 4 ? "ipv4" : "ipv6");
    if (rule.kind === "domain") return (!rule.port || rule.port === explicitPort) && (host === rule.name || host.endsWith(`.${rule.name}`));
    if (rule.kind === "suffix") {
      const candidates = explicitPort ? kdeHosts.flatMap((name) => [name, `${name}:${explicitPort}`]) : kdeHosts;
      return candidates.some((name) => (rule.exact ? name === rule.text : name.endsWith(rule.text)));
    }
    if (rule.scheme && rule.scheme !== url.protocol) return false;
    if (rule.port && rule.port !== port) return false;
    return rule.pattern.test(host);
  });
}

/** 与 undici EnvHttpProxyAgent 的 NO_PROXY 判定逐条一致（hostname 保留 IPv6 方括号） */
function envNoProxyBypassed(value: string, hostname: string, port: number): boolean {
  if (value.trim() === "*") return true;
  for (const entry of value.split(/[,\s]/)) {
    if (!entry) continue;
    const parsed = entry.match(/^(.+):(\d+)$/);
    const entryHost = (parsed ? parsed[1] : entry).replace(/^\*?\./, "").toLowerCase();
    const entryPort = parsed ? Number.parseInt(parsed[2], 10) : 0;
    if (entryPort && entryPort !== port) continue;
    if (hostname === entryHost || hostname.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

export function routeFor(plan: ProxyPlan, target: RouteTarget): ProxyRoute {
  const { url } = target;
  const hostname = url.host.replace(/:\d*$/, "").toLowerCase();
  const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol] || 0;
  if (LOOPBACK.has(hostname)) return { proxy: null, source: plan.source, bypass: "loopback" };
  if (envNoProxyBypassed(plan.envNoProxy, hostname, port)) return { proxy: null, source: plan.source, bypass: "no_proxy" };
  if (plan.unavailable) return { proxy: null, source: plan.source, blocked: true, reason: plan.unavailable };
  if (systemBypassed(plan.systemBypass, target, port)) return { proxy: null, source: plan.source, bypass: "system" };
  const scheme = url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : null;
  const invalid = scheme ? plan.invalid[scheme] : undefined;
  if (invalid) return { proxy: null, source: plan.source, blocked: true, reason: `${invalid}，不能确定这个请求该走哪个代理，为免绕过系统代理不直连` };
  const authorization = scheme ? plan.authorization[scheme] : undefined;
  return { proxy: scheme ? plan[scheme] : null, ...(authorization ? { authorization } : {}), source: plan.source };
}

function systemNotice(settings: SystemProxySettings): string | null {
  const notices: string[] = [];
  if (settings.staleError) notices.push(`这次读取系统代理失败（${settings.staleError}），沿用上次读到的配置`);
  if (settings.unsupported.length) {
    const effective = settings.http || settings.https
      ? `已按系统手动代理转发（HTTP ${redactProxy(settings.http, !!settings.credentials?.http)}，HTTPS ${redactProxy(settings.https, !!settings.credentials?.https)}）`
      : "当前直连";
    notices.push(`系统代理里的${settings.unsupported.join("、")}ash 不支持、未生效，${effective}；需要时可设置 HTTPS_PROXY 指定代理`);
  }
  return notices.length ? notices.join("；") : null;
}

let lastPlan: ProxyPlan | null = null;

function describePlan(plan: ProxyPlan): string {
  const proxyFor = (scheme: "http" | "https") => (plan.invalid[scheme] ? "地址无法解析（拒绝转发）" : redactProxy(plan[scheme], !!plan.authorization[scheme]));
  const target = plan.unavailable ? `远端请求暂停转发：${plan.unavailable}`
    : plan.source === "none" ? "直连" : `HTTP ${proxyFor("http")}，HTTPS ${proxyFor("https")}`;
  return `代理来源：${plan.label}；${target}${plan.notice ? `；${plan.notice}` : ""}`;
}

function remember(plan: ProxyPlan): ProxyPlan {
  if (lastPlan?.key === plan.key) return lastPlan;
  lastPlan = plan;
  console.log(`[ash][llm-relay] ${describePlan(plan)}`);
  return plan;
}

/** 当前生效的代理方案。环境变量配了代理就不读系统；系统那份走缓存，不让请求等子进程 */
export async function relayProxyPlan(): Promise<ProxyPlan> {
  const http = envValue("http_proxy", "HTTP_PROXY");
  const https = envValue("https_proxy", "HTTPS_PROXY");
  const envNoProxy = envValue("no_proxy", "NO_PROXY").value;
  if (http.value || https.value) {
    const httpProxy = http.value ? normalizeProxy(http.value) : null;
    const httpsProxy = https.value ? normalizeProxy(https.value) : httpProxy;
    const names = [...new Set([https.value ? https.name : null, http.value ? http.name : null].filter(Boolean))];
    const [httpEnd, httpsEnd] = [proxyEndpoint(httpProxy), proxyEndpoint(httpsProxy)];
    return remember({
      source: "env", label: `环境变量 ${names.join("、")}`, http: httpEnd.proxy, https: httpsEnd.proxy, authorization: authorizations(httpEnd, httpsEnd),
      envNoProxy, systemBypass: [], notice: null, unavailable: null, invalid: {},
      key: JSON.stringify(["env", httpProxy, httpsProxy, envNoProxy]),
    });
  }
  const settings = await systemProxySettings();
  const notice = systemNotice(settings);
  if (settings.error) {
    const unavailable = `${settings.error}，无法确定该不该走代理，为免绕过系统代理不直连；可设置 HTTPS_PROXY 指定代理或 NO_PROXY 指定直连`;
    return remember({
      source: "system", label: `系统代理（${settings.platform}）`, http: null, https: null, authorization: {},
      envNoProxy, systemBypass: [], notice, unavailable, invalid: {},
      key: JSON.stringify(["unavailable", settings.platform, envNoProxy, unavailable, notice]),
    });
  }
  const invalid = settings.invalid ?? {};
  if (!settings.http && !settings.https && !invalid.http && !invalid.https) {
    return remember({
      source: "none", label: "未配置代理",
      http: null, https: null, authorization: {}, envNoProxy, systemBypass: [], notice, unavailable: null, invalid: {},
      key: JSON.stringify(["none", envNoProxy, notice]),
    });
  }
  const [httpEnd, httpsEnd] = [proxyEndpoint(settings.http, settings.credentials?.http), proxyEndpoint(settings.https, settings.credentials?.https)];
  return remember({
    source: "system", label: `系统代理（${settings.platform}）`, http: httpEnd.proxy, https: httpsEnd.proxy, authorization: authorizations(httpEnd, httpsEnd),
    envNoProxy, systemBypass: settings.bypass.map((rule) => parseBypassRule(rule, settings.bypassSyntax)).filter((rule): rule is BypassRule => rule !== null),
    notice, unavailable: null, invalid,
    key: JSON.stringify(["system", settings.platform, settings.http, settings.https, settings.credentials ?? null, invalid, settings.bypassSyntax ?? null, settings.bypass, envNoProxy, notice]),
  });
}

/** 报错里那半句「走的哪条路」 */
export function describeRoute(plan: ProxyPlan, route: ProxyRoute): string {
  if (route.blocked) return `未转发（${route.reason}）`;
  const path = route.proxy ? `经代理 ${redactProxy(route.proxy, !!route.authorization)}（${plan.label}）`
    : route.bypass === "loopback" ? "本机地址直连"
    : route.bypass ? `直连（命中${route.bypass === "no_proxy" ? " NO_PROXY" : "系统代理绕过列表"}）`
    : `直连（${plan.label}）`;
  return plan.notice ? `${path}；${plan.notice}` : path;
}
