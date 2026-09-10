// 预览代理那个 cookie 罐子（server/src/preview-cookies.ts）。
//
// 这条测试钉的是「代理替浏览器记 cookie」时**不能少记的两样**：Path 和到期。少了它们，
// 症状不是「登不上」而是更难看的两种：
//
//   · 少 Path = `Path=/private` 的凭证也发给 `/public`。作用域凭空放大，而且一路无声无息
//     —— 页面照常工作，只有那个不该收到 cookie 的处理器知道自己多拿了点东西。
//   · 少到期 = `Max-Age=1` 的会话到点了还在发，一直发到 grant 那 8 小时寿命结束。「我退出
//     了 / 我的短会话过期了」在预览里变成一句空话。
//
// 到期这一维用注入的 `now` 钉，不靠 sleep：靠等就只能试大概，试不了「差 1 毫秒」的边界。
//
// 跑法：npm -w server run test:preview-cookies
import assert from "node:assert/strict";
import { cookieHeaderFor, defaultPath, pathMatches, rememberCookie, type PreviewCookieJar } from "../src/preview-cookies.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
const jarWith = (...lines: [string, string][]): PreviewCookieJar => {
  const jar: PreviewCookieJar = new Map();
  for (const [setCookie, at] of lines) rememberCookie(jar, setCookie, at, 1_000);
  return jar;
};

// —— default-path（RFC 6265 §5.1.4）——
// 没写 Path 时按**发出请求的路径**推，而且要砍掉最后一段。直接拿请求路径当 Path 是个
// 很容易犯的错：`/login` 设的 cookie 会被锁死在 `/login` 上，登录完跳走就再没带上过。
check("/a/b 的 default-path 是 /a", defaultPath("/a/b"), "/a");
check("/a/ 的 default-path 是 /a", defaultPath("/a/"), "/a");
check("/a 的 default-path 是 /", defaultPath("/a"), "/");
check("/ 的 default-path 是 /", defaultPath("/"), "/");
check("查询串不参与推算", defaultPath("/a/b?x=1"), "/a");

// —— path-match（RFC 6265 §5.1.4）——
// 前缀相同不等于匹配：`/private` 不该匹配 `/privateer`，否则名字撞车就把凭证漏出去了。
check("完全相同算匹配", pathMatches("/private", "/private"), true);
check("子路径算匹配", pathMatches("/private", "/private/x"), true);
check("Path 以斜杠结尾时同理", pathMatches("/private/", "/private/x"), true);
check("只是前缀撞了字不算匹配", pathMatches("/private", "/privateer"), false);
check("兄弟路径不算匹配", pathMatches("/private", "/public"), false);
check("根 Path 匹配一切", pathMatches("/", "/anything/deep"), true);

// —— 复现审查报告里的第 1 条：Path=/private 的 cookie 不许发到 /public ——
const scoped = jarWith(["narrow=secret; Path=/private; HttpOnly", "/private/set"]);
check("发到 /private 上", cookieHeaderFor(scoped, "/private/whoami", 1_000), "narrow=secret");
check("不许发到 /public", cookieHeaderFor(scoped, "/public/whoami", 1_000), null);
check("也不许发到根上", cookieHeaderFor(scoped, "/", 1_000), null);

// —— 复现审查报告里的第 2 条：到期必须在**发之前**判 ——
const short = jarWith(["short=lived; Path=/; Max-Age=1", "/set"]);
check("没到点照发", cookieHeaderFor(short, "/whoami", 1_500), "short=lived");
check("到点了就不发了", cookieHeaderFor(short, "/whoami", 2_001), null);
check("而且顺手从罐子里清掉", short.size, 0);
check(
  "Expires 到点同理",
  cookieHeaderFor(jarWith([`gone=x; Path=/; Expires=${new Date(5_000).toUTCString()}`, "/set"]), "/", 9_000),
  null,
);
check(
  "Max-Age 压过 Expires（§5.2.2）",
  cookieHeaderFor(jarWith([`a=1; Path=/; Expires=${new Date(0).toUTCString()}; Max-Age=100`, "/set"]), "/", 2_000),
  "a=1",
);
check(
  "Expires 解析不动就当没写过，不是当成已过期",
  cookieHeaderFor(jarWith(["a=1; Path=/; Expires=不是个日期", "/set"]), "/", 9_999_999),
  "a=1",
);

// —— 上游说删就删 ——
check("Max-Age=0 是删", jarWith(["a=1; Path=/", "/set"], ["a=; Path=/; Max-Age=0", "/set"]).size, 0);
check("Max-Age 负数也是删", jarWith(["a=1; Path=/", "/set"], ["a=; Path=/; Max-Age=-1", "/set"]).size, 0);
check(
  "过去的 Expires 也是删",
  jarWith(["a=1; Path=/", "/set"], [`a=; Path=/; Expires=${new Date(0).toUTCString()}`, "/set"]).size,
  0,
);
// 删的时候 Path 也得对上，否则「退出登录」会把另一条同名 cookie 误删（或者删不掉该删的那条）。
const twoPaths = jarWith(["s=root; Path=/", "/set"], ["s=deep; Path=/admin", "/admin/set"]);
check("同名不同 Path 是两条，不许互相覆盖", twoPaths.size, 2);
check("各自只在自己的作用域里出现", cookieHeaderFor(twoPaths, "/other", 1_000), "s=root");
rememberCookie(twoPaths, "s=; Path=/admin; Max-Age=0", "/admin/logout", 1_000);
check("删掉 /admin 那条之后，根上那条还在", cookieHeaderFor(twoPaths, "/admin/x", 1_000), "s=root");

// —— 都命中时的顺序（§5.4.2）：Path 长的在前 ——
// 服务端按「第一个同名」取值的实现不少，顺序错了就等于把更具体的那条盖掉。
const nested = jarWith(["s=root; Path=/", "/set"], ["s=deep; Path=/admin", "/admin/set"]);
check("更具体的排前面", cookieHeaderFor(nested, "/admin/panel", 1_000), "s=deep; s=root");

// —— 同名同 Path 就是覆盖（§5.3）——
check(
  "重设同一条就是改值",
  cookieHeaderFor(jarWith(["a=old; Path=/", "/set"], ["a=new; Path=/", "/set"]), "/", 1_000),
  "a=new",
);

// —— 不合法的名字不收 ——
check("名字带分隔符的不收", jarWith(["a b=1; Path=/", "/set"]).size, 0);
check("没有等号的不收", jarWith(["justaname; Path=/", "/set"]).size, 0);
check("空名字的不收", jarWith(["=1; Path=/", "/set"]).size, 0);
// 相对 Path 不是合法写法，按「没写」处理走 default-path，而不是原样信了它。
check(
  "Path 不以斜杠开头就当没写",
  cookieHeaderFor(jarWith(["a=1; Path=relative", "/deep/set"]), "/deep/other", 1_000),
  "a=1",
);

console.log(failures ? `\n${failures} 条没过` : "\n全过");
process.exit(failures ? 1 : 0);
