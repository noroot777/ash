// 供应商转发「这个请求走不走代理、走哪个」。优先级从高到低：
//   1. localhost / 127.0.0.1 / ::1 一律直连（本机供应商绕进代理只会失败）
//   2. 环境变量：http_proxy/HTTP_PROXY、https_proxy/HTTPS_PROXY（小写优先；https 没配时沿用 http 那个），
//      NO_PROXY 按 undici 的语义（`*` 全部直连；`域名`/`.域名` 匹配自身和子域；可带 `:端口`）
//   3. 两个代理变量都没配，才用系统代理（system-proxy.ts）；此时 NO_PROXY 仍然生效，和系统的绕过列表取并集
//   4. 系统也没配就直连
// 环境变量是整体优先：只配了 HTTP_PROXY 时 https 也走它，不会一半环境变量一半系统代理。
// 选中的代理连不上就是连不上，这里不做「代理失败改直连」—— 那会让代理/直连哪条路坏了都看不出来。
import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";
import { systemProxySettings, type SystemProxySettings } from "./system-proxy.js";

export type ProxySource = "env" | "system" | "none";
export type ProxyPlan = {
  source: ProxySource;
  /** 进日志的来源说明，如 `环境变量 HTTPS_PROXY`、`系统代理（macOS）` */
  label: string;
  http: string | null;
  https: string | null;
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
  source: ProxySource;
  /** 直连的原因 */
  bypass?: "loopback" | "no_proxy" | "system";
  /** 不发出去，reason 说明为什么（整份配置没读到 / 这个协议的地址无法解析） */
  blocked?: true;
  reason?: string;
};

type BypassRule =
  | { kind: "simple" }
  | { kind: "cidr"; list: BlockList }
  | { kind: "host"; pattern: RegExp; port: number; scheme: string | null };

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

/** 日志/报错里的代理地址：只留协议和主机端口，凭据替换成 *** */
export function redactProxy(value: string | null): string {
  if (!value) return "直连";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.username || url.password ? "***@" : ""}${url.host}`;
  } catch {
    return "（无法解析的代理地址）";
  }
}

function cidrRule(entry: string): BypassRule | null {
  const [address, prefixText] = entry.split("/", 2);
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix)) return null;
  let base = address.replace(/^\[|\]$/g, "");
  // macOS 允许 `169.254/16` 这种省掉尾部 0 的写法
  if (/^\d+(\.\d+){0,2}$/.test(base)) base = [...base.split("."), "0", "0", "0"].slice(0, 4).join(".");
  const family = isIP(base);
  if (!family || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return null;
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

/** 系统绕过列表的统一语法（参照 Chromium 对各平台列表的解释）：精确主机、`*` 通配、`.域名`=所有子域、可选 `scheme://` 与 `:端口`、CIDR、`<local>`=不带点的主机名 */
export function parseBypassRule(raw: string): BypassRule | null {
  let entry = raw.trim().toLowerCase();
  if (!entry || entry === "<-loopback>") return null;
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

function systemBypassed(rules: BypassRule[], url: URL, port: number): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const family = isIP(host);
  return rules.some((rule) => {
    if (rule.kind === "simple") return !family && !host.includes(".");
    if (rule.kind === "cidr") return family !== 0 && rule.list.check(host, family === 4 ? "ipv4" : "ipv6");
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

export function routeFor(plan: ProxyPlan, url: URL): ProxyRoute {
  const hostname = url.host.replace(/:\d*$/, "").toLowerCase();
  const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol] || 0;
  if (LOOPBACK.has(hostname)) return { proxy: null, source: plan.source, bypass: "loopback" };
  if (envNoProxyBypassed(plan.envNoProxy, hostname, port)) return { proxy: null, source: plan.source, bypass: "no_proxy" };
  if (plan.unavailable) return { proxy: null, source: plan.source, blocked: true, reason: plan.unavailable };
  if (systemBypassed(plan.systemBypass, url, port)) return { proxy: null, source: plan.source, bypass: "system" };
  const scheme = url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : null;
  const invalid = scheme ? plan.invalid[scheme] : undefined;
  if (invalid) return { proxy: null, source: plan.source, blocked: true, reason: `${invalid}，不能确定这个请求该走哪个代理，为免绕过系统代理不直连` };
  return { proxy: scheme ? plan[scheme] : null, source: plan.source };
}

function systemNotice(settings: SystemProxySettings): string | null {
  const notices: string[] = [];
  if (settings.staleError) notices.push(`这次读取系统代理失败（${settings.staleError}），沿用上次读到的配置`);
  if (settings.unsupported.length) {
    const effective = settings.http || settings.https
      ? `已按系统手动代理转发（HTTP ${redactProxy(settings.http)}，HTTPS ${redactProxy(settings.https)}）`
      : "当前直连";
    notices.push(`系统代理里的${settings.unsupported.join("、")}ash 不支持、未生效，${effective}；需要时可设置 HTTPS_PROXY 指定代理`);
  }
  return notices.length ? notices.join("；") : null;
}

let lastPlan: ProxyPlan | null = null;

function describePlan(plan: ProxyPlan): string {
  const proxyFor = (scheme: "http" | "https") => (plan.invalid[scheme] ? "地址无法解析（拒绝转发）" : redactProxy(plan[scheme]));
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
    return remember({
      source: "env", label: `环境变量 ${names.join("、")}`, http: httpProxy, https: httpsProxy,
      envNoProxy, systemBypass: [], notice: null, unavailable: null, invalid: {},
      key: JSON.stringify(["env", httpProxy, httpsProxy, envNoProxy]),
    });
  }
  const settings = await systemProxySettings();
  const notice = systemNotice(settings);
  if (settings.error) {
    const unavailable = `${settings.error}，无法确定该不该走代理，为免绕过系统代理不直连；可设置 HTTPS_PROXY 指定代理或 NO_PROXY 指定直连`;
    return remember({
      source: "system", label: `系统代理（${settings.platform}）`, http: null, https: null,
      envNoProxy, systemBypass: [], notice, unavailable, invalid: {},
      key: JSON.stringify(["unavailable", settings.platform, envNoProxy, unavailable, notice]),
    });
  }
  const invalid = settings.invalid ?? {};
  if (!settings.http && !settings.https && !invalid.http && !invalid.https) {
    return remember({
      source: "none", label: "未配置代理",
      http: null, https: null, envNoProxy, systemBypass: [], notice, unavailable: null, invalid: {},
      key: JSON.stringify(["none", envNoProxy, notice]),
    });
  }
  return remember({
    source: "system", label: `系统代理（${settings.platform}）`, http: settings.http, https: settings.https,
    envNoProxy, systemBypass: settings.bypass.map(parseBypassRule).filter((rule): rule is BypassRule => rule !== null),
    notice, unavailable: null, invalid,
    key: JSON.stringify(["system", settings.platform, settings.http, settings.https, invalid, settings.bypass, envNoProxy, notice]),
  });
}

/** 报错里那半句「走的哪条路」 */
export function describeRoute(plan: ProxyPlan, route: ProxyRoute): string {
  if (route.blocked) return `未转发（${route.reason}）`;
  const path = route.proxy ? `经代理 ${redactProxy(route.proxy)}（${plan.label}）`
    : route.bypass === "loopback" ? "本机地址直连"
    : route.bypass ? `直连（命中${route.bypass === "no_proxy" ? " NO_PROXY" : "系统代理绕过列表"}）`
    : `直连（${plan.label}）`;
  return plan.notice ? `${path}；${plan.notice}` : path;
}
