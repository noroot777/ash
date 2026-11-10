import assert from "node:assert/strict";
import { describeRoute, parseBypassRule, redactProxy, relayProxyPlan, routeFor } from "../src/proxy-route.js";
import {
  parseGnomeProxy, parseKdeProxy, parseScutilProxy, parseWindowsProxy,
  refreshSystemProxy, setSystemProxyReaderForTests, systemProxySettings, type SystemProxySettings,
} from "../src/system-proxy.js";

const envKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalLog = console.log;
const logs: string[] = [];
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("[ash]")) logs.push(line);
  else originalLog(...args);
};
const clearEnv = () => { for (const key of envKeys) delete process.env[key]; };
const settings = (patch: Partial<SystemProxySettings>): SystemProxySettings => ({ platform: "测试", http: null, https: null, bypass: [], unsupported: [], ...patch });
let systemReads = 0;
const useSystem = (value: SystemProxySettings | (() => Promise<SystemProxySettings>), ttlMs?: number) => {
  systemReads = 0;
  setSystemProxyReaderForTests(typeof value === "function" ? () => { systemReads += 1; return value(); } : async () => { systemReads += 1; return value; }, ttlMs);
};
const route = async (url: string) => routeFor(await relayProxyPlan(), new URL(url));
// Windows 的环境变量不分大小写（no_proxy 和 NO_PROXY 是同一个），「小写优先」只在其它平台上可测
const caseSensitiveEnv = process.platform !== "win32";

try {
  // ---- 优先级 ----
  clearEnv();
  useSystem(settings({ http: "http://sys:1", https: "http://sys:2" }));
  process.env.HTTPS_PROXY = "http://env-upper:3";
  process.env.https_proxy = "http://env-lower:3";
  let plan = await relayProxyPlan();
  assert.equal(plan.source, "env");
  if (caseSensitiveEnv) assert.equal(plan.https, "http://env-lower:3", "小写变量优先");
  assert.equal(plan.http, null, "环境变量整体优先：只配了 https 时 http 请求直连（同 undici），不混用系统代理");
  assert.equal(systemReads, 0, "配了环境变量就不读系统代理");
  assert.match(plan.label, caseSensitiveEnv ? /环境变量 https_proxy$/ : /环境变量 https_proxy$/i);
  clearEnv();
  process.env.HTTP_PROXY = "127.0.0.1:7890";
  plan = await relayProxyPlan();
  assert.equal(plan.https, "http://127.0.0.1:7890", "https 没配时沿用 HTTP_PROXY，没写 scheme 按 http 代理");
  process.env.http_proxy = "";
  plan = await relayProxyPlan();
  assert.equal(plan.source, "system", "小写变量为空也是小写优先：两个代理都为空即视为未配置");
  assert.equal((await route("https://api.example.com/v1")).proxy, "http://sys:2");
  assert.equal((await route("http://api.example.com/v1")).proxy, "http://sys:1");
  clearEnv();
  useSystem(settings({}));
  plan = await relayProxyPlan();
  assert.equal(plan.source, "none");
  assert.equal((await route("https://api.example.com")).proxy, null);
  useSystem(settings({ http: "http://sys-http-only:1" }));
  assert.equal((await route("https://api.example.com")).proxy, null, "系统只配了 HTTP 代理时 https 直连（各平台系统语义）");
  console.log("  ✓ 优先级：环境变量（小写优先、整体优先）> 系统代理 > 直连，按目标协议选代理");

  // ---- 绕过规则 ----
  for (const source of ["env", "system"] as const) {
    clearEnv();
    if (source === "env") process.env.HTTPS_PROXY = process.env.HTTP_PROXY = "http://proxy:8080";
    else useSystem(settings({ http: "http://proxy:8080", https: "http://proxy:8080" }));
    for (const local of ["http://localhost:9/x", "https://127.0.0.1/x", "http://[::1]:9/x", "http://LOCALHOST/x"]) {
      assert.deepEqual(await route(local), { proxy: null, source, bypass: "loopback" }, `${source}: ${local} 必须直连`);
    }
    assert.equal((await route("http://[::ffff:127.0.0.1]/")).proxy, "http://proxy:8080", "只有三个本机名单固定直连");
    if (caseSensitiveEnv) process.env.NO_PROXY = "ignored-because-lowercase-wins.test";
    process.env.no_proxy = "corp.example,.internal.test,api.port.test:8443";
    assert.equal((await route("https://corp.example/")).bypass, "no_proxy");
    assert.equal((await route("https://a.b.corp.example/")).bypass, "no_proxy", "NO_PROXY 匹配子域");
    assert.equal((await route("https://x.internal.test/")).bypass, "no_proxy");
    assert.equal((await route("https://notcorp.example/")).proxy, "http://proxy:8080");
    assert.equal((await route("https://api.port.test:8443/")).bypass, "no_proxy");
    assert.equal((await route("https://api.port.test/")).proxy, "http://proxy:8080", "带端口的 NO_PROXY 只管那个端口");
    assert.equal((await route("https://ignored-because-lowercase-wins.test/")).proxy, "http://proxy:8080");
    process.env.no_proxy = " * ";
    assert.equal((await route("https://anything.test/")).bypass, "no_proxy", "NO_PROXY=* 全部直连");
    delete process.env.no_proxy;
    delete process.env.NO_PROXY;
  }
  clearEnv();
  useSystem(settings({
    https: "http://proxy:8080",
    http: "http://proxy:8080",
    bypass: ["*.local", "<local>", "169.254/16", "10.0.0.0/8", "fd00::/8", ".corp.test", "build.test:8443", "https://only-https.test", "192.168.*", "[fe80::1]", "bad/cidr", ""],
  }));
  const bypassed = ["https://printer.local/", "https://intranet/", "http://169.254.1.2/", "http://10.9.8.7/", "http://[fd12::1]/",
    "https://a.corp.test/", "https://build.test:8443/", "https://only-https.test/", "http://192.168.3.4/", "http://[fe80::1]/"];
  for (const url of bypassed) assert.equal((await route(url)).bypass, "system", `${url} 应命中系统绕过列表`);
  const proxied = ["https://corp.test/", "https://build.test/", "http://only-https.test/", "http://11.0.0.1/", "https://intranet.example/", "http://[fe80::2]/"];
  for (const url of proxied) assert.equal((await route(url)).proxy, "http://proxy:8080", `${url} 不该被绕过`);
  process.env.NO_PROXY = "env-bypass.test";
  assert.equal((await route("https://env-bypass.test/")).bypass, "no_proxy", "用系统代理时 NO_PROXY 仍生效（与系统列表取并集）");
  assert.equal(parseBypassRule("<-loopback>"), null);
  console.log("  ✓ 绕过规则：本机三名单固定直连、NO_PROXY 语义不变、系统列表支持通配/子域/CIDR/端口/协议/<local>");

  // ---- 各平台解析 ----
  const mac = parseScutilProxy(`<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 169.254/16
    2 : *.local
  }
  ExcludeSimpleHostnames : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7898
  HTTPSProxy : proxy.lan
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPProxy : should-not-win
      HTTPEnable : 0
    }
  }
}`);
  assert.deepEqual(mac, { platform: "macOS", http: "http://127.0.0.1:7897", https: "http://proxy.lan:7898", bypass: ["127.0.0.1", "169.254/16", "*.local", "<local>"], unsupported: [] });
  const macPac = parseScutilProxy(`<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://user:secret@wpad.corp/proxy.pac?token=secret
  ProxyAutoDiscoveryEnable : 1
  SOCKSEnable : 1
}`);
  assert.equal(macPac.http, null);
  assert.deepEqual(macPac.unsupported, ["PAC 自动配置（http://wpad.corp/proxy.pac）", "自动发现代理（WPAD）", "SOCKS 代理"]);

  const winHeader = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n";
  const win = parseWindowsProxy(`${winHeader}    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n    ProxyOverride    REG_SZ    localhost;127.*;10.*;<local>\r\n`);
  assert.deepEqual(win, { platform: "Windows", http: "http://127.0.0.1:7890", https: "http://127.0.0.1:7890", bypass: ["localhost", "127.*", "10.*", "<local>"], unsupported: [] });
  const winSplit = parseWindowsProxy(`${winHeader}    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=web:80;https=secure:443;socks=s:1080\r\n`);
  assert.equal(winSplit.http, "http://web:80");
  assert.equal(winSplit.https, "http://secure:443");
  assert.deepEqual(winSplit.unsupported, []);
  const winDisabled = parseWindowsProxy(`${winHeader}    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n    AutoConfigURL    REG_SZ    http://pac.corp/a.pac\r\n`,
    "\r\n    DefaultConnectionSettings    REG_BINARY    460000000A0000000D000000\r\n");
  assert.equal(winDisabled.http, null, "ProxyEnable=0 时 ProxyServer 只是残留");
  assert.deepEqual(winDisabled.unsupported, ["PAC 自动配置（http://pac.corp/a.pac）", "自动检测设置（WPAD）"]);
  assert.deepEqual(parseWindowsProxy(`${winHeader}    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    socks=s:1080\r\n`).unsupported, ["SOCKS 代理"]);

  const gnome = parseGnomeProxy([
    "org.gnome.system.proxy autoconfig-url ''",
    "org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.0/8', '::1', '*.corp']",
    "org.gnome.system.proxy mode 'manual'",
    "org.gnome.system.proxy.http authentication-password 'p@ss'",
    "org.gnome.system.proxy.http authentication-user 'me'",
    "org.gnome.system.proxy.http host 'proxy.lan'",
    "org.gnome.system.proxy.http port 3128",
    "org.gnome.system.proxy.http use-authentication true",
    "org.gnome.system.proxy.https host ''",
    "org.gnome.system.proxy.https port 0",
    "org.gnome.system.proxy.socks host ''",
  ].join("\n"));
  assert.equal(gnome.http, "http://me:p%40ss@proxy.lan:3128");
  assert.equal(gnome.https, null);
  assert.deepEqual(gnome.bypass, ["localhost", "127.0.0.0/8", "::1", "*.corp"]);
  assert.deepEqual(parseGnomeProxy("org.gnome.system.proxy mode 'auto'\norg.gnome.system.proxy autoconfig-url 'http://pac/x.pac'").unsupported, ["PAC 自动配置（http://pac/x.pac）"]);
  assert.equal(parseGnomeProxy("org.gnome.system.proxy mode 'none'\norg.gnome.system.proxy.http host 'leftover'").http, null);

  const kde = parseKdeProxy("[Other]\nProxyType=2\n[Proxy Settings]\nProxyType=1\nhttpProxy=http://127.0.0.1 7890\nhttpsProxy=http://127.0.0.1:7891\nNoProxyFor=localhost,.corp\n");
  assert.deepEqual([kde.http, kde.https, kde.bypass], ["http://127.0.0.1:7890", "http://127.0.0.1:7891", ["localhost", ".corp"]]);
  const kdeReversed = parseKdeProxy("[Proxy Settings]\nProxyType=1\nhttpProxy=http://p 1\nReversedException=true\n");
  assert.equal(kdeReversed.http, null);
  assert.deepEqual(kdeReversed.unsupported, ["反向例外列表（只代理列出的地址）"]);
  console.log("  ✓ macOS scutil / Windows 注册表 / GNOME / KDE 的手动代理、绕过列表与不支持项解析正确");

  // ---- 不支持项要明说 ----
  clearEnv();
  useSystem(settings({ unsupported: ["PAC 自动配置（http://pac/x.pac）"] }));
  plan = await relayProxyPlan();
  assert.equal(plan.source, "none");
  assert.match(plan.notice ?? "", /PAC 自动配置.*未生效，当前直连/);
  assert.match(describeRoute(plan, routeFor(plan, new URL("https://api.test"))), /^直连（未配置代理）；系统代理里的PAC/);
  useSystem(settings({ https: "http://u:pw@manual:1", unsupported: ["PAC 自动配置（http://pac/x.pac）"] }));
  plan = await relayProxyPlan();
  assert.equal(plan.source, "system");
  assert.match(plan.notice ?? "", /已按系统手动代理转发（HTTP 直连，HTTPS http:\/\/\*\*\*@manual:1）/);
  useSystem(async () => { throw Object.assign(new Error("boom"), { code: "ENOENT" }); });
  plan = await relayProxyPlan();
  assert.equal(plan.source, "none");
  assert.match(plan.notice ?? "", /读取系统代理失败（ENOENT）/);
  console.log("  ✓ PAC / 自动发现 / SOCKS / 读取失败都明确提示未生效，不冒充走了系统代理");

  // ---- 缓存与刷新 ----
  let current = settings({ https: "http://first:1" });
  useSystem(async () => current, 60_000);
  for (let index = 0; index < 5; index += 1) assert.equal((await route("https://api.test")).proxy, "http://first:1");
  assert.equal(systemReads, 1, "缓存期内只读一次系统配置");
  current = settings({ https: "http://second:2" });
  assert.equal((await route("https://api.test")).proxy, "http://first:1");
  await refreshSystemProxy();
  assert.equal((await route("https://api.test")).proxy, "http://second:2", "显式刷新后立刻用新配置");
  current = settings({});
  await refreshSystemProxy();
  assert.equal((await route("https://api.test")).proxy, null, "系统代理关掉后改为直连");

  let release: (() => void) | undefined;
  const reads: string[] = [];
  useSystem(async () => {
    reads.push("read");
    if (reads.length === 1) return settings({ https: "http://cached:1" });
    await new Promise<void>((resolve) => { release = resolve; });
    return settings({ https: "http://refreshed:2" });
  }, 20);
  assert.equal((await route("https://api.test")).proxy, "http://cached:1");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const stale = await Promise.race([route("https://api.test"), new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 200))]);
  assert.notEqual(stale, "blocked", "缓存过期时请求不等子进程");
  assert.equal(stale !== "blocked" && stale.proxy, "http://cached:1");
  assert.equal((await route("https://api.test")).proxy, "http://cached:1");
  assert.equal(reads.length, 2, "后台刷新只起一次，并发请求共享");
  release!();
  await refreshSystemProxy();
  assert.equal((await systemProxySettings()).https, "http://refreshed:2");
  assert.equal((await route("https://api.test")).proxy, "http://refreshed:2");
  console.log("  ✓ 系统配置有缓存：期内不重读、过期后台刷新不阻塞请求、显式刷新立即生效");

  // ---- 日志脱敏 ----
  assert.equal(redactProxy("http://user:secret-pw@proxy.lan:3128/path?x=secret-pw"), "http://***@proxy.lan:3128");
  assert.equal(redactProxy("http://proxy.lan:3128"), "http://proxy.lan:3128");
  assert.equal(redactProxy(null), "直连");
  clearEnv();
  process.env.HTTPS_PROXY = "http://user:env-secret@envproxy:1";
  await relayProxyPlan();
  useSystem(settings({ http: "http://me:sys-secret@sysproxy:2" }));
  clearEnv();
  await relayProxyPlan();
  const configLogs = logs.join("\n");
  assert.match(configLogs, /代理来源：环境变量 HTTPS_PROXY；HTTP 直连，HTTPS http:\/\/\*\*\*@envproxy:1/);
  assert.match(configLogs, /代理来源：系统代理（测试）；HTTP http:\/\/\*\*\*@sysproxy:2/);
  assert.doesNotMatch(configLogs, /env-secret|sys-secret|secret-pw/);
  const before = logs.length;
  await relayProxyPlan();
  assert.equal(logs.length, before, "配置没变不重复打日志");
  console.log("  ✓ 诊断日志写明代理来源，凭据一律打码，配置不变不刷屏");
} finally {
  console.log = originalLog;
  setSystemProxyReaderForTests();
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

console.log("relay proxy tests passed");
