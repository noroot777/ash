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
 *
 * `localStorage`/`sessionStorage`/`document.cookie` 也在这张单子里，理由是**沙箱不许把应用
 * 打死**：opaque origin 下这三个 API 一碰就抛 `SecurityError`（`indexedDB.open()` 同理），
 * 而「开屏先读一次存储」是现代前端的标准动作（Pinia 的持久化插件、各家 SDK 的 token 恢复）。
 * 2026-09-09 一个 Vue/Java 项目的预览就是这么卡死的：HTTP 200、标题都出来了，Pinia 初始化
 * 抛在第一行，页面永远停在转圈——用户看到的只是「预览打不开」，控制台之外没有一点线索。
 * 这里给它们换上一份**只活在这份文档里**的实现：应用照常读写，读到的永远是自己写的那份，
 * 隔离没有松一寸（`allow-same-origin` 一加，预览页就直接拿到 ash 的 cookie 和 /api）。
 *
 * 已知的边界，别当成 bug 去「修」：① 存储不跨刷新、不跨标签页，重开就是空的；② 服务端下发
 * 的 cookie 由代理按 `ashpv_` 前缀转发，浏览器这边看不见，页面自己写的 cookie 也只留在页面
 * 里、不会跟着请求发出去；③ IndexedDB 在 opaque origin 里没法模拟，只能让它探测得出「没有」
 * 而不是探测得出、一开就炸。
 */
function previewBrowserBridge(base: string, record: PreviewRecord): string {
  return `(() => {
    // 存储那一段单独 try 起来：它塌了也不能连累下面的地址改写（那才是预览的命脉）。
    try {
      const storage = () => {
        const data = new Map();
        const api = {
          get length() { return data.size; },
          key: (i) => [...data.keys()][i] ?? null,
          getItem: (k) => data.has(String(k)) ? data.get(String(k)) : null,
          setItem: (k, v) => { data.set(String(k), String(v)); },
          removeItem: (k) => { data.delete(String(k)); },
          clear: () => { data.clear(); },
        };
        const own = (p) => typeof p === 'string' && !(p in api) && data.has(p);
        return new Proxy(api, {
          get: (t, p) => own(p) ? data.get(p) : t[p],
          set: (t, p, v) => { if (p in t) return false; data.set(String(p), String(v)); return true; },
          has: (t, p) => p in t || own(p),
          deleteProperty: (t, p) => { data.delete(String(p)); return true; },
          ownKeys: () => [...data.keys()],
          getOwnPropertyDescriptor: (t, p) => own(p)
            ? { value: data.get(p), writable: true, enumerable: true, configurable: true }
            : undefined,
        });
      };
      for (const name of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(window, name, { configurable: true, value: storage() });
      }
      let jar = '';
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: () => jar,
        set: (value) => {
          const raw = String(value);
          const pair = raw.split(';')[0];
          const equals = pair.indexOf('=');
          if (equals <= 0) return;
          const name = pair.slice(0, equals).trim();
          const rest = jar.split('; ').filter(c => c && c.slice(0, c.indexOf('=')) !== name);
          const maxAge = /;\\s*max-age\\s*=\\s*(-?\\d+)/i.exec(raw);
          const expires = /;\\s*expires\\s*=\\s*([^;]+)/i.exec(raw);
          const gone = (maxAge && Number(maxAge[1]) <= 0) || (expires && Date.parse(expires[1]) <= Date.now());
          jar = (gone ? rest : [...rest, name + '=' + pair.slice(equals + 1).trim()]).join('; ');
        },
      });
      // 模拟不了，就让它探测得出「没有」——比探测得出、一 open 就抛 SecurityError 强。
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    } catch {}
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
