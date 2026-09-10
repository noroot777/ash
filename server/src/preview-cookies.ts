// 预览代理自己的那个 cookie 罐子。
//
// 为什么要有它：预览文档带 `CSP: sandbox`（没有 `allow-same-origin`），origin 是 `null`，
// 浏览器把它发出的每个请求都当跨站。明文 http + 局域网 IP（用户访问 ash 的常态）下
// `SameSite` 的五种写法 —— Lax / Strict / 不写 / None（缺 Secure 被丢）/ None+Secure
// （非可信来源同样被丢）—— **一条都带不回来**。也就是说「把 cookie 改写一下发回浏览器、
// 指望它下次带上」这条路在用户的部署形态里根本走不通，预览里的应用永远保不住会话。
// 所以 cookie 由代理自己记着、每次转发自己贴。
//
// 既然是代替浏览器记，就得**照浏览器的规矩记**，否则会从「登录不上」换成一种更难看的坏：
// 少了 Path 就是把 `Path=/private` 的凭证也发给 `/public`（凭证作用域凭空放大），少了到期
// 就是过期的会话继续被发出去，一直发到 grant 那 8 小时寿命结束。规矩按 RFC 6265 的
// §5.1.4（default-path、path-match）和 §5.4（发哪些、什么顺序）来，只裁掉这里用不上的
// 那两维：
//
// · **Domain**：一个罐子只服务一个上游服务（`preview.json` 里那一条 url），没有第二个主机
//   可言，域名匹配无从谈起，也就不给应用「把 cookie 撒到别的域上」的机会。
// · **Secure / HttpOnly / SameSite**：这三个约束的是**浏览器**该不该交出 cookie。这里没有
//   浏览器，是代理直连上游，本来就没有「跨站」「明文链路」这回事；照抄反而会把预览里那份
//   HttpOnly 的会话判成不能发。
//
// 罐子的寿命跟着 grant 走（见 preview-access.ts），所以「再打开一次预览」= 换一张凭证 =
// 换一个会话，不会渗到下一次打开，也不会让别人从任务页点开就坐进你登录好的那个会话。

/** 罐子里的一条。`expires` 为 null 就是会话 cookie —— 跟着 grant 一起没。 */
export interface PreviewCookie {
  name: string;
  value: string;
  path: string;
  expires: number | null;
}

/** key 是 `name\npath`：**同名不同 Path 是两条**（RFC 6265 §5.3），不许互相覆盖。 */
export type PreviewCookieJar = Map<string, PreviewCookie>;

const NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const keyOf = (name: string, path: string) => `${name}\n${path}`;

/**
 * RFC 6265 §5.1.4 的 default-path：没写 `Path` 时，按**发出这个请求的路径**推。
 * `/a/b` → `/a`；`/a/` → `/a`；`/a` → `/`。注意不是「就用请求路径」——那会把
 * `/login` 设的 cookie 锁死在 `/login` 上，之后一个请求都带不上。
 */
export function defaultPath(requestPath: string): string {
  const path = requestPath.split("?")[0].split("#")[0];
  if (!path.startsWith("/")) return "/";
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/** RFC 6265 §5.1.4 的 path-match：请求路径落在 cookie 的 Path 底下才算数。 */
export function pathMatches(cookiePath: string, requestPath: string): boolean {
  const path = requestPath.split("?")[0].split("#")[0] || "/";
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || path[cookiePath.length] === "/";
}

function attributeOf(attributes: readonly string[], want: string): string | undefined {
  const hit = attributes.find((s) => s.trim().toLowerCase().startsWith(`${want}=`));
  return hit?.slice(hit.indexOf("=") + 1).trim();
}

/**
 * 把上游这一条 `Set-Cookie` 记进罐子。`requestPath` 是**发出这个请求的上游路径**
 * （default-path 要用它）。写的是「删掉我」（Max-Age ≤ 0 / Expires 已过）就照删。
 */
export function rememberCookie(
  jar: PreviewCookieJar, setCookie: string, requestPath: string, now = Date.now(),
): void {
  const [pair, ...attributes] = setCookie.split(";");
  const equals = pair.indexOf("=");
  if (equals <= 0) return;
  const name = pair.slice(0, equals).trim();
  if (!NAME_RE.test(name)) return;

  const declared = attributeOf(attributes, "path");
  const path = declared?.startsWith("/") ? declared : defaultPath(requestPath);
  // Max-Age 压过 Expires（§5.2.2）；Expires 解析不动就当没写过（§5.2.1），而不是当成已过期。
  const maxAge = attributeOf(attributes, "max-age");
  const expiresAt = attributeOf(attributes, "expires");
  let expires: number | null = null;
  if (maxAge !== undefined && maxAge !== "" && Number.isFinite(Number(maxAge))) expires = now + Number(maxAge) * 1000;
  else if (expiresAt !== undefined && !Number.isNaN(Date.parse(expiresAt))) expires = Date.parse(expiresAt);

  const key = keyOf(name, path);
  if (expires !== null && expires <= now) jar.delete(key);
  else jar.set(key, { name, value: pair.slice(equals + 1), path, expires });
}

/**
 * 这次转发该带上的 `Cookie` 头；没有就返回 null。
 *
 * 顺带把过期的清掉 —— 到期判断必须在**发之前**做，不能只在收下那一刻做：`Max-Age=1` 的
 * 会话如果只在收到时判一次，之后会一直被发出去，直到 grant 那 8 小时寿命结束。
 *
 * 排序按 §5.4.2：Path 长的在前（更具体的先），同长的按记进来的先后。
 */
export function cookieHeaderFor(jar: PreviewCookieJar, requestPath: string, now = Date.now()): string | null {
  const send: PreviewCookie[] = [];
  for (const [key, cookie] of jar) {
    if (cookie.expires !== null && cookie.expires <= now) { jar.delete(key); continue; }
    if (pathMatches(cookie.path, requestPath)) send.push(cookie);
  }
  if (!send.length) return null;
  return send
    .map((cookie, index) => ({ cookie, index }))
    .sort((a, b) => b.cookie.path.length - a.cookie.path.length || a.index - b.index)
    .map(({ cookie }) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
