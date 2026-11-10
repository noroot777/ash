import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describeRoute, parseBypassRule, redactProxy, relayProxyPlan, routeFor } from "../src/proxy-route.js";
import {
  decodeWindowsProxyOutput, gvariantStrings, parseGnomeProxy, parseKdeProxy, parseScutilProxy, parseWindowsProxy, readWindowsProxy,
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
  // 规则和请求主机按同一种写法比：国际化域名转 punycode、IPv6 压缩
  useSystem(settings({ https: "http://proxy:8080", bypass: ["例子.测试", "*.公司.测试", "[2001:0db8:0:0:0:0:0:1]", "2001:0DB8:0::2", "Example.TEST."] }));
  for (const url of ["https://例子.测试/", "https://xn--fsqu00a.xn--0zwm56d/", "https://api.公司.测试/", "https://[2001:db8::1]/", "https://[2001:db8::2]/", "https://example.test/"]) {
    assert.equal((await route(url)).bypass, "system", `${url} 应命中规范化后的绕过规则`);
  }
  assert.equal((await route("https://公司.测试/")).proxy, "http://proxy:8080", "`*.域名` 不含域名自身");

  // 同一行规则在不同平台直连的范围不同，各按原平台的语义解释
  const expectRoutes = async (label: string, direct: string[], proxied: string[]) => {
    for (const url of direct) assert.equal((await route(url)).bypass, "system", `${label}：${url} 应直连`);
    for (const url of proxied) assert.equal((await route(url)).proxy, "http://proxy:8080", `${label}：${url} 应走代理`);
  };
  // GNOME（GSimpleProxyResolver）：三种写法都配域名自身 + 点边界上的子域；端口只认 URL 里写明的
  useSystem(settings({ https: "http://proxy:8080", http: "http://proxy:8080", bypassSyntax: "gnome",
    bypass: ["corp.test", ".dot.test", "*.star.test", "port.test:8080", "10.1.2.3", "10.9.0.0/16", "[fd00::1]:8443", "Upper.TEST", "例子.测试", "<local>"] }));
  await expectRoutes("GNOME",
    ["https://corp.test/", "https://api.corp.test/", "https://dot.test/", "https://a.dot.test/", "https://star.test/", "https://b.star.test/",
      "https://port.test:8080/", "https://api.port.test:8080/", "http://10.1.2.3:81/", "http://10.9.4.4/", "https://[fd00::1]:8443/", "https://upper.test/", "https://例子.测试/"],
    ["https://notcorp.test/", "https://port.test/", "https://port.test:8081/", "http://10.1.2.4/", "https://[fd00::1]/", "https://intranet/"]);
  // KDE（revmatch）：按字符做后缀比较、没有点边界、`*` 不是通配；写了端口的 URL 再拿「主机:端口」比；`scheme://主机` 只配整个主机
  useSystem(settings({ https: "http://proxy:8080", http: "http://proxy:8080", bypassSyntax: "kde",
    bypass: ["kde.org", ".dot.test", "*.star.test", "port.test:8080", "http://exact.test", "10.0.0.0/255.0.0.0", "<local>", "子.测试"] }));
  await expectRoutes("KDE",
    ["https://kde.org/", "https://bugs.kde.org/", "https://evilkde.org/", "https://a.dot.test/", "https://port.test:8080/", "https://api.port.test:8080/",
      "https://exact.test/", "https://exact.test/x", "http://10.2.3.4/", "https://intranet/", "https://例子.测试/"],
    ["https://dot.test/", "https://b.star.test/", "https://port.test/", "https://sub.exact.test/", "http://11.0.0.1/"]);
  // macOS / Windows 的 Chromium 语义不受影响：裸域名精确匹配、`.域名` 只配子域
  useSystem(settings({ https: "http://proxy:8080", bypass: ["corp.test", ".dot.test"] }));
  await expectRoutes("Chromium", ["https://corp.test/", "https://a.dot.test/"], ["https://api.corp.test/", "https://dot.test/"]);
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

  const win = parseWindowsProxy({ ProxyEnable: 1, ProxyServer: "127.0.0.1:7890", ProxyOverride: "localhost;127.*;10.*;<local>" });
  assert.deepEqual(win, { platform: "Windows", http: "http://127.0.0.1:7890", https: "http://127.0.0.1:7890", bypass: ["localhost", "127.*", "10.*", "<local>"], unsupported: [] });
  const winSplit = parseWindowsProxy({ ProxyEnable: 1, ProxyServer: "http=web:80;https=secure:443;socks=s:1080" });
  assert.equal(winSplit.http, "http://web", "URL 规范化去掉默认端口");
  assert.equal(winSplit.https, "http://secure:443");
  assert.deepEqual(winSplit.unsupported, []);
  const winBroken = parseWindowsProxy({ ProxyEnable: 1, ProxyServer: "bad host:1" });
  assert.deepEqual(Object.keys(winBroken.invalid ?? {}).sort(), ["http", "https"], "Windows 单一代理写坏，两个协议都无法确定");
  const winDisabled = parseWindowsProxy({ ProxyEnable: 0, ProxyServer: "127.0.0.1:7890", AutoConfigURL: "http://pac.corp/a.pac",
    DefaultConnectionSettings: Buffer.from("460000000A0000000D000000", "hex").toString("base64") });
  assert.equal(winDisabled.http, null, "ProxyEnable=0 时 ProxyServer 只是残留");
  assert.deepEqual(winDisabled.unsupported, ["PAC 自动配置（http://pac.corp/a.pac）", "自动检测设置（WPAD）"]);
  assert.deepEqual(parseWindowsProxy({ ProxyEnable: 1, ProxyServer: "socks=s:1080" }).unsupported, ["SOCKS 代理"]);
  assert.equal(parseWindowsProxy({ ProxyEnable: "1", ProxyServer: "p:1" }).http, "http://p:1", "ProxyEnable 存成 REG_SZ 也认");
  // 读取脚本的输出：JSON 包一层 UTF-8 base64，非 ASCII 值原样到达匹配器
  const winOutput = Buffer.from(JSON.stringify({ ProxyEnable: 1, ProxyServer: "127.0.0.1:7890", ProxyOverride: "例子.测试;<local>", AutoConfigURL: null, DefaultConnectionSettings: null })).toString("base64");
  const winUnicode = parseWindowsProxy(decodeWindowsProxyOutput(`${winOutput}\r\n`));
  assert.deepEqual(winUnicode.bypass, ["例子.测试", "<local>"]);
  useSystem(winUnicode);
  assert.equal((await route("https://例子.测试/")).bypass, "system", "Windows 里写成中文的绕过规则生效");
  assert.throws(() => decodeWindowsProxyOutput("not base64 json"), (error: { code?: string }) => error.code === "输出无法解析");

  const gnome = parseGnomeProxy([
    "org.gnome.system.proxy autoconfig-url ''",
    "org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.0/8', '::1', '*.corp']",
    "org.gnome.system.proxy mode 'manual'",
    "org.gnome.system.proxy.http authentication-password \"p@ss'w\\\\d\\u00e9\"",
    "org.gnome.system.proxy.http authentication-user 'me'",
    "org.gnome.system.proxy.http host 'proxy.lan'",
    "org.gnome.system.proxy.http port 3128",
    "org.gnome.system.proxy.http use-authentication true",
    "org.gnome.system.proxy.https host ''",
    "org.gnome.system.proxy.https port 0",
    "org.gnome.system.proxy.socks host ''",
  ].join("\n"));
  assert.deepEqual([new URL(gnome.http!).host, new URL(gnome.http!).username], ["proxy.lan:3128", "me"]);
  assert.equal(decodeURIComponent(new URL(gnome.http!).password), "p@ss'w\\dé", "含单引号的密码按 GVariant 双引号写法原样解出");
  assert.equal(gnome.https, gnome.http, "GNOME 的 HTTPS 主机留空时沿用 HTTP 代理（含认证），同 glib-networking");
  // 凭据原文进 URL 前转义：`%40` 不能在用的时候被解成 `@`；开了认证就带两个字段，哪个留空也照带
  const gnomeAuth = (user: string, password: string) => {
    const url = new URL(parseGnomeProxy([
      "org.gnome.system.proxy mode 'manual'", "org.gnome.system.proxy.http host 'proxy.lan'", "org.gnome.system.proxy.http port 3128",
      "org.gnome.system.proxy.http use-authentication true",
      `org.gnome.system.proxy.http authentication-user '${user}'`, `org.gnome.system.proxy.http authentication-password '${password}'`,
    ].join("\n")).http!);
    return [decodeURIComponent(url.username), decodeURIComponent(url.password)];
  };
  assert.deepEqual(gnomeAuth("u%41:@", "p%40ss"), ["u%41:@", "p%40ss"]);
  assert.deepEqual(gnomeAuth("me", ""), ["me", ""]);
  assert.deepEqual(gnomeAuth("", "secret"), ["", "secret"], "用户名留空也照带密码");
  const gnomeSplit = parseGnomeProxy("org.gnome.system.proxy mode 'manual'\norg.gnome.system.proxy.http host 'h'\norg.gnome.system.proxy.http port 1\norg.gnome.system.proxy.https host 's'\norg.gnome.system.proxy.https port 2");
  assert.deepEqual([gnomeSplit.http, gnomeSplit.https], ["http://h:1", "http://s:2"]);
  const gnomeBroken = parseGnomeProxy("org.gnome.system.proxy mode 'manual'\norg.gnome.system.proxy.http host 'bad host'\norg.gnome.system.proxy.http port 1");
  assert.deepEqual(Object.keys(gnomeBroken.invalid ?? {}).sort(), ["http", "https"], "GNOME HTTPS 沿用的 HTTP 代理写坏了，HTTPS 也无法确定");
  assert.deepEqual(gvariantStrings(`['a', "it's", 'tab\\there', '\\'q\\'', 'emoji \\U0001f600', 'nl\\n']`), ["a", "it's", "tab\there", "'q'", "emoji 😀", "nl\n"]);
  assert.deepEqual(gnome.bypass, ["localhost", "127.0.0.0/8", "::1", "*.corp"]);
  assert.deepEqual(parseGnomeProxy("org.gnome.system.proxy mode 'auto'\norg.gnome.system.proxy autoconfig-url 'http://pac/x.pac'").unsupported, ["PAC 自动配置（http://pac/x.pac）"]);
  assert.equal(parseGnomeProxy("org.gnome.system.proxy mode 'none'\norg.gnome.system.proxy.http host 'leftover'").http, null);

  const kde = parseKdeProxy("[Other]\nProxyType=2\n[Proxy Settings]\nProxyType=1\nhttpProxy=http://127.0.0.1 7890\nhttpsProxy=http://127.0.0.1:7891\nNoProxyFor=localhost,.corp\n");
  assert.deepEqual([kde.http, kde.https, kde.bypass], ["http://127.0.0.1:7890", "http://127.0.0.1:7891", ["localhost", ".corp"]]);
  const kdeReversed = parseKdeProxy("[Proxy Settings]\nProxyType=1\nhttpProxy=http://p 1\nReversedException=true\n");
  assert.equal(kdeReversed.http, null);
  assert.deepEqual(kdeReversed.unsupported, ["反向例外列表（只代理列出的地址）"]);

  // IPv6 代理主机：单独给端口时补方括号，不拿末段「:1」当端口
  const scutil = (host: string, port: string) => parseScutilProxy(`<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : ${port}\n  HTTPSProxy : ${host}\n}`);
  assert.equal(scutil("::1", "7890").https, "http://[::1]:7890");
  assert.equal(scutil("fe80::1:2", "3128").https, "http://[fe80::1:2]:3128");
  assert.equal(scutil("proxy.lan", "80").https, "http://proxy.lan", "默认端口不算无效");
  assert.equal(parseGnomeProxy("org.gnome.system.proxy mode 'manual'\norg.gnome.system.proxy.http host '::1'\norg.gnome.system.proxy.http port 3128").http, "http://[::1]:3128");
  assert.equal(parseKdeProxy("[Proxy Settings]\nProxyType=1\nhttpsProxy=http://[::1] 7890\n").https, "http://[::1]:7890");
  assert.equal(parseWindowsProxy({ ProxyEnable: 1, ProxyServer: "[::1]:7890" }).https, "http://[::1]:7890");
  for (const broken of [scutil("bad host", "1"), scutil("proxy.lan", "99999"), scutil("proxy.lan", "abc")]) {
    assert.equal(broken.https, null);
    assert.equal(broken.error, undefined, "地址写坏只记在那个协议上，不算整份没读到");
    assert.match(broken.invalid?.https ?? "", /系统 HTTPS 代理地址无法解析/);
  }
  console.log("  ✓ macOS scutil / Windows 注册表 / GNOME / KDE 的手动代理、绕过列表与不支持项解析正确");

  // ---- Windows：经真实读取通道读一个临时键，非 ASCII 值原样到达（本机真实设置只读不改） ----
  if (process.platform === "win32") {
    const tempKey = `Software\\AshProxyTest_${process.pid}`;
    const reg = (args: string[]) => execFileSync("reg.exe", args, { windowsHide: true, stdio: "ignore" });
    try {
      reg(["add", `HKCU\\${tempKey}`, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"]);
      reg(["add", `HKCU\\${tempKey}`, "/v", "ProxyServer", "/t", "REG_SZ", "/d", "http=127.0.0.1:7890;https=127.0.0.1:7891", "/f"]);
      reg(["add", `HKCU\\${tempKey}`, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", "例子.测试;<local>", "/f"]);
      reg(["add", `HKCU\\${tempKey}`, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", "http://代理.例子/a.pac", "/f"]);
      reg(["add", `HKCU\\${tempKey}\\Connections`, "/v", "DefaultConnectionSettings", "/t", "REG_BINARY", "/d", "460000000A0000000D000000", "/f"]);
      const read = await readWindowsProxy(`HKCU:\\${tempKey}`);
      assert.deepEqual(read, {
        platform: "Windows", http: "http://127.0.0.1:7890", https: "http://127.0.0.1:7891", bypass: ["例子.测试", "<local>"],
        unsupported: [`PAC 自动配置（http://${new URL("http://代理.例子/").host}/a.pac）`, "自动检测设置（WPAD）"],
      });
      useSystem(read);
      assert.equal((await route("https://例子.测试/")).bypass, "system", "Windows 真实读取的中文绕过规则生效");
    } finally {
      execFileSync("reg.exe", ["delete", `HKCU\\${tempKey}`, "/f"], { windowsHide: true, stdio: "ignore" });
    }
    const startedAt = Date.now();
    const real = await readWindowsProxy();
    assert.equal(real.platform, "Windows");
    console.log(`  ✓ Windows 注册表经 PowerShell 无损读取（含中文值），读本机真实设置耗时 ${Date.now() - startedAt}ms`);
  }

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
  console.log("  ✓ PAC / 自动发现 / SOCKS 都明确提示未生效，不冒充走了系统代理");

  // ---- 读不到系统代理：不能当成没配去直连 ----
  let failRead: Error | null = Object.assign(new Error("boom"), { code: "EACCES" });
  let good = settings({ https: "http://good:1" });
  useSystem(async () => { if (failRead) throw failRead; return good; });
  plan = await relayProxyPlan();
  assert.equal(plan.source, "system");
  assert.match(plan.unavailable ?? "", /读取系统代理失败（EACCES）.*不直连/);
  assert.deepEqual(routeFor(plan, new URL("https://api.test/")), { proxy: null, source: "system", blocked: true, reason: plan.unavailable }, "第一次就读不到：远端请求拒绝");
  assert.match(describeRoute(plan, routeFor(plan, new URL("https://api.test/"))), /^未转发（读取系统代理失败/);
  assert.equal(routeFor(plan, new URL("http://localhost:1/")).bypass, "loopback", "本机供应商不受影响");
  process.env.NO_PROXY = "direct-ok.test";
  assert.equal((await route("https://direct-ok.test/")).bypass, "no_proxy", "用户明说直连的地址照常直连");
  delete process.env.NO_PROXY;
  failRead = null;
  await refreshSystemProxy();
  assert.equal((await route("https://api.test/")).proxy, "http://good:1", "读取恢复后照常走代理");
  failRead = Object.assign(new Error("boom"), { code: "ETIMEDOUT" });
  good = settings({});
  await refreshSystemProxy();
  plan = await relayProxyPlan();
  assert.equal(routeFor(plan, new URL("https://api.test/")).proxy, "http://good:1", "后来读失败：沿用上次读到的有效配置，不改直连");
  assert.match(plan.notice ?? "", /这次读取系统代理失败（ETIMEDOUT），沿用上次读到的配置/);
  useSystem(settings({ http: "http://good-http:1", invalid: { https: "系统 HTTPS 代理地址无法解析（bad host 端口 1）" }, bypass: ["bypass.test"] }));
  plan = await relayProxyPlan();
  const brokenHttps = routeFor(plan, new URL("https://api.test/"));
  assert.equal(brokenHttps.blocked, true, "HTTPS 地址写坏了：HTTPS 请求拒绝，不直连");
  assert.match(describeRoute(plan, brokenHttps), /^未转发（系统 HTTPS 代理地址无法解析（bad host 端口 1），不能确定/);
  assert.equal(routeFor(plan, new URL("http://api.test/")).proxy, "http://good-http:1", "HTTP 代理是好的，照常走");
  assert.equal(routeFor(plan, new URL("https://bypass.test/")).bypass, "system", "已读到的绕过列表照常生效");
  assert.match(logs.at(-1) ?? "", /HTTPS 地址无法解析（拒绝转发）/);
  console.log("  ✓ 系统代理读不到：首次即拒绝远端请求，之后失败沿用上次有效配置；某个协议地址写坏只拒绝那个协议，均不降级直连");

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
