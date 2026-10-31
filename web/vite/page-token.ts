// 真人专属动作的页面凭据:**凡是交出这个应用 HTML 文档的入口,都得把它盖上**。
//
// 机制本体与能力边界写在 `server/src/auth/human-action-token.ts`;后端自己那条交付路径
// (`server/src/index.ts` 的 `serveSpa`)在交出文档那一刻盖一份。缺口在于**那不是唯一的
// 交付入口**:`npm -w web run dev`(本仓说「起个预览」指的就是它)和 `npm -w web run preview`
// 交出的是 vite 自己的文档,上面一个字都没有 —— 于是这两种页面上只有用户按得动的那几个开关
// (放开回合占位、杀 CUA 旁路会话)一律 403「这个动作需要本次会话的页面凭据」,而页面给出的
// 恢复路径「重新加载页面」也救不回来:重新加载换来的还是一份没凭据的文档(本轮审查 F2 实测)。
//
// ## 这里不发凭据,只是把后端那一份搬过来
//
// 发凭据的权力只留在后端那一处(它刻意不开「领凭据」的 JSON 端点 —— 那等于把「先拿到页面
// 文档」这一步也省掉,理由见那个文件)。所以这个插件每要交出一份 HTML,就去后端取一份**页面
// 文档**、把上面的 meta 抬过来:dev/preview 页手里那一份与后端自己交付的页面完全同源 ——
// 同样一次性、同样带着它那次启动的前缀、同样随重启整批作废。取的必须是**同一个实例**,
// 所以后端地址与 `/api` 代理共用一份解析(`ashBackendUrl`)。
//
// 取不到就**什么都不盖**,并在终端里说清是哪一步没成(后端没起 / 后端没有 web/dist)。
// 编一份假的只会把一句准确的 403 换成一句看不懂的,而前端那边拿不出凭据时压根不编
// (`web/src/lib/humanActionToken.ts`)。
//
// 只在 `serve` 下挂(dev + preview)。**不许进 build**:打进 `web/dist/index.html` 的凭据是
// 一份死号,而它排在 `serveSpa` 追加的那一份前面,`fromDocument()` 读到的就是它 —— 那会把
// 后端自己交付的每一个页面也一起弄坏。
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { HUMAN_ACTION_TOKEN_META } from "@ash/shared/human-action";

/**
 * dev / preview 把 `/api` 代理到哪个后端。凭据要从**同一个实例**取,所以这一份解析由
 * 代理配置和本插件共用 —— 两边各写一份的话,`ASH_PROXY` 指到别的实例上时,页面拿着 A 的
 * 凭据去按 B 的开关,403 的原因还查不出来。
 */
export function ashBackendUrl(): string {
  return process.env.ASH_PROXY ?? process.env.HARNESS_PROXY ?? "http://localhost:4317";
}

/** 取凭据的超时。页面文档等不起 —— 后端卡住时宁可不盖(开关会如实 403),不要让整个页面打不开。 */
const TIMEOUT_MS = 2_000;

const metaTag = new RegExp(`<meta\\b[^>]*\\bname=["']${HUMAN_ACTION_TOKEN_META}["'][^>]*>`, "i");

/** 这份文档自己已经带着一份凭据了吗(回归用的 fixture 文档就是这种)—— 带了就不叠第二份。 */
export function carriesPageToken(html: string): boolean {
  return metaTag.test(html);
}

let lastComplaint: string | null = null;

function complain(reason: string): void {
  if (lastComplaint === reason) return; // 每次页面加载都抱怨一遍就没人看了;原因变了再说
  lastComplaint = reason;
  console.warn(`[ash] 这个页面拿不到真人动作凭据(${reason})——「放开回合占位」这类开关会 403。`);
}

/** 去后端取一份页面文档,把上面的凭据抬下来。 */
async function borrowToken(): Promise<string | null> {
  const base = ashBackendUrl();
  let response: Response;
  try {
    response = await fetch(new URL("/", base), {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    complain(`连不上后端 ${base}:${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const body = await response.text().catch(() => "");
  const tag = metaTag.exec(body)?.[0];
  const token = tag ? /\bcontent=["']([^"']+)["']/i.exec(tag)?.[1]?.trim() : undefined;
  if (!token) {
    complain(response.ok
      // 后端起着、却交不出带凭据的文档:几乎只有一种原因 —— 它那边没有 web/dist 可交。
      ? `后端 ${base} 交出的文档上没有凭据(它那边大概没有 web/dist:先跑一次 npm -w web run build)`
      : `后端 ${base} 回了 ${response.status}`);
    return null;
  }
  lastComplaint = null;
  return token;
}

const metaFor = (token: string) => `<meta name="${HUMAN_ACTION_TOKEN_META}" content="${token}">`;

/**
 * 把后端那一份凭据盖到 vite 交出的文档上。
 *
 * dev 走 `transformIndexHtml`(它对 dev server 交出的**每一份** HTML 都生效,包括回归
 * fixture);preview 自己把 `dist/index.html` 当静态文件发,钩子不过那条路,所以另挂一段
 * 中间件 —— 两条路交出的文档都得有凭据,少一条就是「照着文档起的预览按不动开关」。
 */
export function pageTokenPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "ash-page-token",
    apply: "serve",
    configResolved(resolved) { config = resolved; },
    transformIndexHtml: {
      order: "pre",
      async handler(html) {
        if (carriesPageToken(html)) return;
        const token = await borrowToken();
        if (!token) return;
        return { html, tags: [{ tag: "meta", attrs: { name: HUMAN_ACTION_TOKEN_META, content: token }, injectTo: "head" }] };
      },
    },
    configurePreviewServer(server) {
      const index = resolve(config.root, config.build.outDir, "index.html");
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        // 只接「交出文档」那种请求:没有扩展名的路径(SPA 路由)和 index.html 本身。
        const path = (req.url ?? "/").split("?")[0]!.split("#")[0]!;
        const last = path.slice(path.lastIndexOf("/") + 1);
        if (last.includes(".") && !last.endsWith(".html")) return next();
        let html: string;
        try { html = await readFile(index, "utf8"); } catch { return next(); }
        const token = carriesPageToken(html) ? null : await borrowToken();
        const body = token ? html.replace("</head>", `${metaFor(token)}</head>`) : html;
        // 带凭据的文档一律 no-cache(同 `serveSpa` 的理由):浏览器端出一份用过的凭据,
        // 开关就按不动了,而那一步看起来跟「开关坏了」一模一样。
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.end(req.method === "HEAD" ? undefined : body);
      });
    },
  };
}
