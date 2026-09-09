import type { PreviewRecord } from "./preview-store.js";
import { previewBase } from "./preview-public.js";

export function previewAddressMap(record: PreviewRecord): Array<{ port: number; base: string }> {
  return (record.services ?? []).filter((s) => s.port !== null).map((s) => ({ port: s.port!, base: previewBase(record, s.id) }));
}

export function rewritePreviewUrl(value: string, base: string, record: PreviewRecord): string {
  if (value.startsWith(base) || value.startsWith(`/preview/${record.taskId}/${record.proxyToken}/`)) return value;
  const parts = value.split("/");
  if (parts[1] === "preview" && parts[2] === record.taskId && record.services?.some((s) => s.id === parts[4])) {
    return previewBase(record, parts[4]) + parts.slice(5).join("/");
  }
  if (value.startsWith("/") && !value.startsWith("//")) return base + value.slice(1);
  const match = /^(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)(\/.*)?$/i.exec(value);
  const target = match && previewAddressMap(record).find((s) => s.port === Number(match[1]));
  return target ? target.base + (match![2] ?? "/").slice(1) : value;
}

export function rewritePreviewText(text: string, contentType: string, base: string, record: PreviewRecord, resourcePath = ""): string {
  let rewritten = text.replace(new RegExp(`/preview/${record.taskId}/[a-f0-9]{48}/[A-Za-z0-9_-]+/`, "g"), (value) => rewritePreviewUrl(value, base, record));
  if (resourcePath.endsWith("/@vite/client")) {
    rewritten = rewritten.replace(/(const base(?:\$[\w]+)?\s*=\s*)(["'])([^"']*)\2/g,
      (_all, before: string, _quote: string, value: string) => before + JSON.stringify(rewritePreviewUrl(value || "/", base, record)));
  }
  rewritten = rewritten.replace(/(\b(?:from|import)\s*|\bimport\s*\(\s*)(["'])([^"'\r\n]+)\2/g,
    (_all, before: string, quote: string, value: string) => `${before}${quote}${rewritePreviewUrl(value, base, record)}${quote}`);
  if (/text\/css|text\/html/.test(contentType)) rewritten = rewritten.replace(/url\(\s*(["']?)([^\s)'"\u0060]+)\1\s*\)/g,
    (_all, quote: string, value: string) => `url(${quote}${rewritePreviewUrl(value, base, record)}${quote})`);
  if (contentType.includes("text/html")) rewritten = rewritten.replace(/(\b(?:src|href|action|poster)\s*=\s*)(["'])([^"']*)\2/gi,
    (_all, before: string, quote: string, value: string) => `${before}${quote}${rewritePreviewUrl(value, base, record)}${quote}`);
  if (!contentType.includes("text/html")) return rewritten;
  const bootstrap = `<script>${previewBrowserBridge(base, record).replaceAll("</script", "<\\/script")}</script>`;
  return /<head(?:\s[^>]*)?>/i.test(rewritten)
    ? rewritten.replace(/<head(?:\s[^>]*)?>/i, (head) => head + bootstrap)
    : bootstrap + rewritten;
}

/**
 * 注进被代理页面的那段桥。它把页面运行时现拼的地址（fetch / XHR / WebSocket / EventSource）
 * 一律改写回预览前缀底下 —— 服务端只改得动它发出去的那份文本，剩下的只能在浏览器里拦。
 *
 * `history.pushState/replaceState` 也在这张单子里，理由跟前几个不一样，是**地址栏不许
 * 说谎**：预览页在 CSP sandbox 的 opaque origin 里，而 `replaceState` 换的只是地址栏，
 * 文档还是原来那一份。不拦的话，任何做「URL 归一化」的前端（ash 自己的
 * `normalizedWorkspaceUrl` 就是，开屏第一件事就把非 `/` 的路径 replace 成 `/`）会让地址栏
 * 变成 ash 本尊的地址，页面却还是那份沙箱里的预览 —— 2026-09-09 用户就是这样对着
 * 「172.x.x.x:4317」的地址栏，把自己的 key 粘进了一个预览页里的登录框。改写之后地址栏
 * 始终留在 `/preview/<task>/<token>/<service>/` 底下，「我在看预览」这件事看得见。
 */
function previewBrowserBridge(base: string, record: PreviewRecord): string {
  return `(() => {
    const base = ${JSON.stringify(base)};
    const routes = ${JSON.stringify(previewAddressMap(record))};
    const origin = location.origin;
    const routeRoot = base.split('/').slice(0, 4).join('/') + '/';
    const rewrite = (value) => {
      const raw = String(value);
      if (raw.startsWith(routeRoot)) return raw;
      const parts = raw.split('/');
      if (parts[1] === 'preview' && parts[2] === base.split('/')[2]) {
        const service = routes.find(s => s.base.split('/')[4] === parts[4]);
        if (service) return service.base + parts.slice(5).join('/');
      }
      if (raw.startsWith('/') && !raw.startsWith('//')) return base + raw.slice(1);
      try {
        const url = new URL(raw, location.href);
        const local = ['localhost','127.0.0.1','[::1]','0.0.0.0'].includes(url.hostname);
        const service = local && routes.find(s => s.port === Number(url.port));
        if (service) return origin + service.base + url.pathname.slice(1) + url.search + url.hash;
        if (url.origin === origin && !url.pathname.startsWith(routeRoot)) return origin + base + url.pathname.slice(1) + url.search + url.hash;
      } catch {}
      return raw;
    };
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const target = rewrite(input instanceof Request ? input.url : input);
      return fetchOriginal(input instanceof Request ? new Request(target, input) : target, { credentials: 'include', ...init });
    };
    const xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) { return xhrOpen.call(this, method, rewrite(url), ...args); };
    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(...args) { this.withCredentials = true; return xhrSend.apply(this, args); };
    for (const name of ['WebSocket', 'EventSource']) {
      const Original = window[name];
      if (!Original) continue;
      window[name] = class extends Original {
        constructor(url, ...args) {
          const target = new URL(rewrite(String(url).replace(/^ws/, 'http')), location.href);
          if (name === 'WebSocket') target.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          super(target.href, ...args);
        }
      };
    }
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name].bind(history);
      history[name] = function (state, title, url) { return original(state, title, url == null ? url : rewrite(url)); };
    }
  })();`;
}
