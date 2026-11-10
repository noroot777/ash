// 读「当前系统代理」：只在没配 HTTP(S)_PROXY 时才被用到（优先级在 proxy-route.ts）。
//
// 各平台都只读**手动代理**那一档（主机 + 端口 + 绕过列表），因为 undici 只会走 HTTP CONNECT 代理：
// - macOS：`scutil --proxy`（系统设置里「网络 → 代理」的那份，Clash 等工具的「设置系统代理」也写这里）
// - Windows：WinINET 的 `Internet Settings`（系统设置「代理」页）；WinHTTP 那份是给服务用的，不是用户眼里的系统代理
// - Linux：KDE 读 kioslaverc，其它桌面读 GNOME gsettings；都没有就是没配
// PAC、自动发现（WPAD）、只有 SOCKS 这几种 ash 不解析，记进 unsupported 由调用方明说「未生效」，
// 而不是装作走了系统代理。
//
// 读一次要起子进程，所以结果缓存 SYSTEM_PROXY_TTL_MS：过期后的请求先用旧值、后台刷新（不让任何一次
// 转发等子进程），只有进程里的第一次读取要等。
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileText } from "./exec.js";
import { encodePowerShellCommand } from "./platform.js";

/**
 * 绕过列表照哪个平台的语义解释（proxy-route.ts 按它编译规则）。不写 = macOS/Windows 那套
 * （Chromium 的解释：精确主机、`*` 通配、`.域名` 只配子域）；GNOME、KDE 各有自己的匹配法，
 * 同一行 `corp.test` 在三处直连的范围都不一样，不能统一成一种。
 */
export type BypassSyntax = "gnome" | "kde";
/** 代理认证的原文。有这一项 = 开了认证，两项都空也照发（`Basic Og==`）；没有 = 不认证 */
export type ProxyCredentials = { user: string; password: string };

export type SystemProxySettings = {
  /** 读的是哪一份配置，进诊断日志 */
  platform: string;
  http: string | null;
  https: string | null;
  /**
   * 认证开关和凭据单独放，不塞进代理 URL：URL 的 userinfo 两项都空时会整段消失，「开了认证、两项留空」
   * 就和「没开认证」变成同一个 URL。代理 URL 里自带 userinfo 的（KDE 允许这么写）由 proxy-route.ts 拆出来
   */
  credentials?: Partial<Record<"http" | "https", ProxyCredentials>>;
  /** 系统里写的绕过规则原文，按 bypassSyntax 解释 */
  bypass: string[];
  bypassSyntax?: BypassSyntax;
  /** 读到了但 ash 不支持、因而没有生效的设置 */
  unsupported: string[];
  /**
   * 整份配置没读到（第一次读就失败）：不知道系统要走哪个代理，也不知道绕过列表，
   * 远端请求一律拒绝而不是直连 —— 系统代理可能正开着，直连就是绕过它。
   */
  error?: string;
  /**
   * 读到了，但某个协议的代理地址拼不成合法 URL：只有这个协议的请求无法确定走法、要拒绝；
   * 另一个协议的代理和绕过列表都是确知的，照常生效。
   */
  invalid?: Partial<Record<"http" | "https", string>>;
  /** 这次读取失败了、沿用的是上次读到的配置，记下失败原因 */
  staleError?: string;
};

const SYSTEM_PROXY_TTL_MS = 15_000;
const READ_TIMEOUT_MS = 3_000;
// Windows PowerShell 冷启动本身就要一两秒，不是读得慢
const WINDOWS_READ_TIMEOUT_MS = 10_000;
const readTimeoutMs = () => (process.platform === "win32" ? WINDOWS_READ_TIMEOUT_MS : READ_TIMEOUT_MS);
const NONE = (platform: string): SystemProxySettings => ({ platform, http: null, https: null, bypass: [], unsupported: [] });

/**
 * 系统设置里的代理主机（+ 单独的端口）→ 代理 URL。单独给了端口时 host 只当主机名，裸 IPv6 补方括号
 * （不能拿末尾的「:数字」猜有没有端口，`::1` 的末段就长这样）；没给端口时 host 可以是 `主机:端口`、
 * `[v6]:端口` 或带 scheme 的完整地址。拼不成合法 URL 就按协议记进 settings.invalid，绝不当成「没配代理」。
 * `scheme` 为 null 的（只用来判断「有没有配 SOCKS」）不记。
 */
function proxyUrl(settings: SystemProxySettings, scheme: "http" | "https" | null, host: string, port?: string | number): string | null {
  const raw = host.trim();
  if (!raw) return null;
  const portText = String(port ?? "").trim();
  const prefix = raw.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  let authority = (prefix ? prefix[2] : raw).replace(/\/+$/, "");
  if (portText && portText !== "0") {
    const hostname = authority.replace(/^\[(.*)\]$/, "$1");
    authority = `${isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${portText}`;
  } else if (isIP(authority) === 6) {
    authority = `[${authority}]`;
  }
  try {
    const url = new URL(`${prefix ? prefix[1] : "http"}://${authority}`);
    if (!url.hostname || url.pathname !== "/" || url.search || url.hash || (portText && !/^\d{1,5}$/.test(portText))) throw new Error("bad");
    return url.href.replace(/\/$/, "");
  } catch {
    if (scheme) (settings.invalid ??= {})[scheme] ??= `系统 ${scheme.toUpperCase()} 代理地址无法解析（${raw.includes("@") ? "含凭据，已隐藏" : raw}${portText && portText !== "0" ? ` 端口 ${portText}` : ""}）`;
    return null;
  }
}

function describeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return "地址无法解析";
  }
}

// ---- macOS ----

/** 只取顶层字典的键：`__SCOPED__` 等嵌套字典里有同名的按网卡配置，不能覆盖全局那份 */
export function parseScutilProxy(text: string): SystemProxySettings {
  const scalars = new Map<string, string>();
  const arrays = new Map<string, string[]>();
  let depth = 0;
  let arrayKey: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "}") {
      depth -= 1;
      if (depth < 2) arrayKey = null;
      continue;
    }
    const entry = line.match(/^([^:]+?) : (.*)$/);
    const opens = line.endsWith("{");
    if (entry && depth === 1) {
      const [, key, value] = entry;
      if (value.startsWith("<array>")) arrayKey = key;
      else if (!opens) scalars.set(key, value.trim());
    } else if (entry && depth === 2 && arrayKey) {
      arrays.set(arrayKey, [...(arrays.get(arrayKey) ?? []), entry[2].trim()]);
    }
    if (opens) depth += 1;
  }
  const on = (key: string) => scalars.get(key) === "1";
  const settings = NONE("macOS");
  if (on("HTTPEnable")) settings.http = proxyUrl(settings, "http", scalars.get("HTTPProxy") ?? "", scalars.get("HTTPPort"));
  if (on("HTTPSEnable")) settings.https = proxyUrl(settings, "https", scalars.get("HTTPSProxy") ?? "", scalars.get("HTTPSPort"));
  settings.bypass = [...(arrays.get("ExceptionsList") ?? [])];
  if (on("ExcludeSimpleHostnames")) settings.bypass.push("<local>");
  if (on("ProxyAutoConfigEnable")) settings.unsupported.push(`PAC 自动配置（${describeUrl(scalars.get("ProxyAutoConfigURLString") ?? "")}）`);
  if (on("ProxyAutoDiscoveryEnable")) settings.unsupported.push("自动发现代理（WPAD）");
  if (on("SOCKSEnable") && (!settings.http || !settings.https)) settings.unsupported.push("SOCKS 代理");
  return settings;
}

// ---- Windows ----

/** `Internet Settings` 键里用到的几个值，原样（DefaultConnectionSettings 是二进制，base64） */
export type WindowsInternetSettings = {
  ProxyEnable?: number | string | null;
  ProxyServer?: string | null;
  ProxyOverride?: string | null;
  AutoConfigURL?: string | null;
  DefaultConnectionSettings?: string | null;
};

// 不用 reg query：它按控制台代码页（中文系统是 GBK）输出，按什么解码都会把某种系统上的非 ASCII 值
// （`例子.测试` 这种绕过规则、带中文的 PAC 地址）读坏，坏了之后下游再规范化也救不回来。
// PowerShell 读到的是注册表里的 UTF-16 原值，转成 JSON 再包一层 UTF-8 base64，管道里只有 ASCII。
const WINDOWS_PROXY_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const windowsProxyScript = (key: string) => [
  "$ErrorActionPreference = 'Stop'",
  `$key = '${key.replace(/'/g, "''")}'`,
  "$p = Get-ItemProperty -LiteralPath $key",
  "$c = Get-ItemProperty -LiteralPath \"$key\\Connections\" -Name DefaultConnectionSettings -ErrorAction SilentlyContinue",
  "$out = [ordered]@{ ProxyEnable = $p.ProxyEnable; ProxyServer = $p.ProxyServer; ProxyOverride = $p.ProxyOverride; AutoConfigURL = $p.AutoConfigURL",
  "  DefaultConnectionSettings = $(if ($c) { [Convert]::ToBase64String([byte[]]$c.DefaultConnectionSettings) } else { $null }) }",
  "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($out | ConvertTo-Json -Compress)))",
].join("\n");

/** windowsProxyScript 的输出 → 注册表值 */
export function decodeWindowsProxyOutput(stdout: string): WindowsInternetSettings {
  let decoded: unknown = null;
  try {
    decoded = JSON.parse(Buffer.from(stdout.trim(), "base64").toString("utf8"));
  } catch { /* 下面统一报 */ }
  if (!decoded || typeof decoded !== "object") throw Object.assign(new Error("bad output"), { code: "输出无法解析" });
  return decoded as WindowsInternetSettings;
}

/** DefaultConnectionSettings 第 8 字节是标志位：0x08=自动检测设置 */
export function parseWindowsProxy(values: WindowsInternetSettings): SystemProxySettings {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const settings = NONE("Windows");
  if (Number(values.ProxyEnable ?? 0) !== 0) {
    const server = text(values.ProxyServer);
    if (server.includes("=")) {
      // `http=h:p;https=h:p;socks=h:p`：按协议分配，没写的协议 WinINET 也是直连
      const byScheme = new Map<string, string>();
      for (const part of server.split(";")) {
        const [scheme, address] = part.split("=", 2).map((item) => item.trim());
        if (scheme && address) byScheme.set(scheme.toLowerCase(), address);
      }
      settings.http = proxyUrl(settings, "http", byScheme.get("http") ?? "");
      settings.https = proxyUrl(settings, "https", byScheme.get("https") ?? "");
      if (byScheme.has("socks") && (!settings.http || !settings.https)) settings.unsupported.push("SOCKS 代理");
    } else {
      settings.http = settings.https = proxyUrl(settings, "http", server);
      if (settings.invalid?.http) settings.invalid.https = settings.invalid.http.replace("HTTP", "HTTPS");
    }
    settings.bypass = text(values.ProxyOverride).split(";").map((item) => item.trim()).filter(Boolean);
  }
  const pac = text(values.AutoConfigURL);
  if (pac) settings.unsupported.push(`PAC 自动配置（${describeUrl(pac)}）`);
  const flags = Buffer.from(text(values.DefaultConnectionSettings), "base64")[8];
  if (flags !== undefined && (flags & 0x08) !== 0) settings.unsupported.push("自动检测设置（WPAD）");
  return settings;
}

/** 读 WinINET 代理设置。key 只给 Windows 上的回归测试换成临时键用 */
export async function readWindowsProxy(key = WINDOWS_PROXY_KEY): Promise<SystemProxySettings> {
  const exe = process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
  const { stdout } = await execFileText(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(windowsProxyScript(key))],
    { timeout: readTimeoutMs() });
  return parseWindowsProxy(decodeWindowsProxyOutput(stdout));
}

// ---- Linux ----

const GVARIANT_ESCAPES: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/**
 * GVariant 文本格式里的全部字符串字面量。g_variant_print 的写法：串里有单引号就改用双引号包，
 * 引号和反斜杠前加 `\`，不可打印字符写成 `\n`、`\uXXXX`、`\UXXXXXXXX`。密码里什么字符都可能有，得按完整语法解。
 */
export function gvariantStrings(value: string): string[] {
  const strings: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const quote = value[index];
    if (quote !== "'" && quote !== '"') continue;
    let text = "";
    for (index += 1; index < value.length && value[index] !== quote; index += 1) {
      if (value[index] !== "\\") {
        text += value[index];
        continue;
      }
      const next = value[++index] ?? "";
      const width = next === "u" ? 4 : next === "U" ? 8 : 0;
      const hex = width ? value.slice(index + 1, index + 1 + width) : "";
      if (GVARIANT_ESCAPES[next]) {
        text += GVARIANT_ESCAPES[next];
      } else if (width && hex.length === width && /^[0-9a-f]+$/i.test(hex) && Number.parseInt(hex, 16) <= 0x10ffff) {
        text += String.fromCodePoint(Number.parseInt(hex, 16));
        index += width;
      } else {
        text += next;
      }
    }
    strings.push(text);
  }
  return strings;
}

/** `gsettings list-recursively org.gnome.system.proxy` 的输出 */
export function parseGnomeProxy(text: string): SystemProxySettings {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^org\.gnome\.system\.proxy(\.[a-z]+)?\s+(\S+)\s+(.*)$/);
    if (match) values.set(`${(match[1] ?? "").slice(1)}/${match[2]}`, match[3].trim());
  }
  const text1 = (key: string) => gvariantStrings(values.get(key) ?? "")[0] ?? "";
  const settings = NONE("Linux（GNOME）");
  const mode = text1("/mode");
  if (mode === "auto") {
    const pac = text1("/autoconfig-url");
    settings.unsupported.push(pac ? `PAC 自动配置（${describeUrl(pac)}）` : "自动发现代理（WPAD）");
  }
  if (mode !== "manual") return settings;
  const manual = (scheme: "http" | "https") => {
    const host = text1(`${scheme}/host`);
    const port = (values.get(`${scheme}/port`) ?? "").replace(/^\D+/, "");
    return proxyUrl(settings, scheme, host, port);
  };
  settings.http = manual("http");
  // 同 glib-networking：只看 use-authentication，开了就带上两个字段的原文（哪个留空、两个都空也照带）
  if (settings.http && values.get("http/use-authentication") === "true") {
    settings.credentials = { http: { user: text1("http/authentication-user"), password: text1("http/authentication-password") } };
  }
  // 同 glib-networking：HTTPS 主机留空时 HTTPS 也走 HTTP 代理（连同认证信息）
  settings.https = text1("https/host") ? manual("https") : settings.http;
  if (!text1("https/host") && settings.credentials?.http) settings.credentials.https = settings.credentials.http;
  if (!text1("https/host") && settings.invalid?.http) settings.invalid.https = settings.invalid.http;
  settings.bypass = gvariantStrings(values.get("/ignore-hosts") ?? "");
  settings.bypassSyntax = "gnome";
  if (text1("socks/host") && (!settings.http || !settings.https)) settings.unsupported.push("SOCKS 代理");
  return settings;
}

/** `~/.config/kioslaverc` 的 `[Proxy Settings]` 节 */
export function parseKdeProxy(text: string): SystemProxySettings {
  const values = new Map<string, string>();
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inSection = trimmed === "[Proxy Settings]";
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (inSection && eq > 0) values.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  const settings = NONE("Linux（KDE）");
  const type = values.get("ProxyType") ?? "0";
  if (type === "2") settings.unsupported.push(`PAC 自动配置（${describeUrl(values.get("Proxy Config Script") ?? "")}）`);
  if (type === "3") settings.unsupported.push("自动发现代理（WPAD）");
  if (type !== "1") return settings; // 0=直连，4=「使用环境变量」—— 环境变量那一档 proxy-route.ts 已经先看过了
  // KDE 把端口用空格隔开写：`http://127.0.0.1 7890`
  const manual = (key: string, scheme: "http" | "https" | null) => {
    const [host = "", port] = (values.get(key) ?? "").split(/\s+/);
    return proxyUrl(settings, scheme, host, port);
  };
  settings.http = manual("httpProxy", "http");
  settings.https = manual("httpsProxy", "https");
  settings.bypass = (values.get("NoProxyFor") ?? "").split(/[,\s]+/).filter(Boolean);
  settings.bypassSyntax = "kde";
  if (values.get("ReversedException") === "true") {
    // 「只有列表里的走代理」，这种反向语义不套用，宁可整份不生效也不猜
    settings.unsupported.push("反向例外列表（只代理列出的地址）");
    settings.http = settings.https = null;
    settings.bypass = [];
    delete settings.invalid;
  }
  // KDE 会先把主机名解析成 IP 再判网段；转发路径上不做 DNS，网段只对 IP 地址生效
  if (settings.bypass.some((entry) => entry.includes("/") && !entry.includes("://"))) settings.unsupported.push("网段例外对主机名的匹配（KDE 先解析成 IP 再判，ash 只判 IP 地址）");
  if (manual("socksProxy", null) && (!settings.http || !settings.https)) settings.unsupported.push("SOCKS 代理");
  return settings;
}

// ---- 读取与缓存 ----

async function readPlatformProxy(): Promise<SystemProxySettings> {
  const run = (file: string, args: string[]) => execFileText(file, args, { timeout: READ_TIMEOUT_MS }).then((result) => result.stdout);
  if (process.platform === "darwin") return parseScutilProxy(await run("/usr/sbin/scutil", ["--proxy"]));
  if (process.platform === "win32") return readWindowsProxy();
  if (process.platform === "linux") {
    if (/kde/i.test(process.env.XDG_CURRENT_DESKTOP ?? "")) {
      const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
      const text = await readFile(join(configHome, "kioslaverc"), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return parseKdeProxy(text);
    }
    try {
      return parseGnomeProxy(await run("gsettings", ["list-recursively", "org.gnome.system.proxy"]));
    } catch (error) {
      // 没装桌面（服务器、容器）就是没有系统代理，不算读取失败
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return NONE("Linux");
      throw error;
    }
  }
  return NONE(process.platform);
}

let reader: () => Promise<SystemProxySettings> = readPlatformProxy;
let ttlMs = SYSTEM_PROXY_TTL_MS;
let snapshot: { settings: SystemProxySettings; readAt: number } | null = null;
let reading: Promise<SystemProxySettings> | null = null;
let readGeneration = 0;

/** 立刻重读系统代理；并发调用共享同一次读取。读取失败也落一份「未配置 + 失败原因」，免得每个请求都重试起子进程 */
export function refreshSystemProxy(): Promise<SystemProxySettings> {
  if (reading) return reading;
  const generation = readGeneration;
  const current = reader()
    .catch((error: unknown): SystemProxySettings => {
      const code = (error as { code?: unknown })?.code;
      const killed = (error as { killed?: unknown })?.killed === true;
      const reason = killed ? `读取超过 ${readTimeoutMs()}ms` : typeof code === "string" ? code : `退出码 ${String(code ?? "未知")}`;
      // 读不到不等于没配：有上次读到的就接着用；第一次就失败则标成 error，远端请求拒绝而不是直连
      const previous = generation === readGeneration ? snapshot?.settings : undefined;
      if (previous && !previous.error) return { ...previous, staleError: reason };
      return { ...NONE(process.platform), error: `读取系统代理失败（${reason}）` };
    })
    .then((settings) => {
      if (generation === readGeneration) snapshot = { settings, readAt: Date.now() };
      return settings;
    })
    .finally(() => {
      if (reading === current) reading = null;
    });
  reading = current;
  return current;
}

/** 当前的系统代理：有缓存就直接给（过期则顺手后台刷新），只有进程里第一次要等读取 */
export async function systemProxySettings(): Promise<SystemProxySettings> {
  if (!snapshot) return refreshSystemProxy();
  if (Date.now() - snapshot.readAt >= ttlMs) void refreshSystemProxy();
  return snapshot.settings;
}

/** 测试用：换掉平台读取器 / 缓存时长，并清空缓存。不传参数即恢复真实读取 */
export function setSystemProxyReaderForTests(next?: () => Promise<SystemProxySettings>, nextTtlMs?: number): void {
  reader = next ?? readPlatformProxy;
  ttlMs = nextTtlMs ?? SYSTEM_PROXY_TTL_MS;
  snapshot = null;
  reading = null;
  readGeneration += 1;
}
