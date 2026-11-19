// appcast.xml 的读写（发版脚本用；纯函数，回归测试直接调）。
//
// 每一版一个 <item>，新的在前。版本比较按 Sparkle 的口径（SUStandardVersionComparator）比
// CFBundleVersion：按点切段、逐段按数字比 —— build.sh 出的是「日期.时分」，两段都是数字。
//
// sign_update 签 appcast 时会把整份 XML 重新排版（属性顺序、开头那行都会变），并在头尾加上
// 签名注释。所以这里读旧 appcast 只认元素、不认格式：每个 <item> 原样保留，只从里面取
// <sparkle:version>；写的时候整份重新生成、去掉旧签名，交给 sign_update 重签。

const SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle";

export function compareVersions(a, b) {
  const parts = (v) => String(v).split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p < q ? -1 : 1;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}

/** 旧 appcast 里的各版本：[{ version, xml }]，按文件里的顺序。 */
export function parseItems(xml) {
  if (!xml) return [];
  const items = [];
  for (const match of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const version = match[0].match(/<sparkle:version>\s*([^<\s]+)\s*<\/sparkle:version>/)?.[1];
    if (!version) throw new Error(`appcast 里有一项没有 <sparkle:version>，认不出是哪一版：\n${match[0].slice(0, 400)}`);
    items.push({ version, xml: match[0] });
  }
  return items;
}

export function latestVersion(items) {
  return items.reduce((best, item) => (best === null || compareVersions(item.version, best) > 0 ? item.version : best), null);
}

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 新的一项。signature 是 sign_update -p 打出来的 EdDSA 签名。 */
export function renderItem({ version, shortVersion, url, length, signature, minimumSystemVersion, notes, pubDate, commit }) {
  const lines = [
    "<item>",
    `  <title>${escape(`${shortVersion}（${version}）`)}</title>`,
    `  <pubDate>${escape(pubDate.toUTCString())}</pubDate>`,
    `  <sparkle:version>${escape(version)}</sparkle:version>`,
    `  <sparkle:shortVersionString>${escape(shortVersion)}</sparkle:shortVersionString>`,
    `  <sparkle:minimumSystemVersion>${escape(minimumSystemVersion)}</sparkle:minimumSystemVersion>`,
  ];
  if (commit) lines.push(`  <navi:commit>${escape(commit)}</navi:commit>`);
  if (notes) lines.push(`  <description>${escape(notes)}</description>`);
  lines.push(
    `  <enclosure url="${escape(url)}" length="${length}" type="application/octet-stream" sparkle:edSignature="${escape(signature)}"/>`,
    "</item>",
  );
  return lines.join("\n      ");
}

/**
 * 「仅通知」的一项（Sparkle 的 informationalUpdate）：不带安装包，查到它的 app 只提示有新版、「了解更多」
 * 打开 link。给改名前的 Ash.app 用 —— 它装不了包标识不同的 Navi。
 */
export function renderInformationalItem({ version, shortVersion, link, minimumSystemVersion, notes, pubDate }) {
  return [
    "<item>",
    `  <title>${escape(`Navi ${shortVersion}（${version}）`)}</title>`,
    `  <pubDate>${escape(pubDate.toUTCString())}</pubDate>`,
    `  <sparkle:version>${escape(version)}</sparkle:version>`,
    `  <sparkle:shortVersionString>${escape(shortVersion)}</sparkle:shortVersionString>`,
    `  <sparkle:minimumSystemVersion>${escape(minimumSystemVersion)}</sparkle:minimumSystemVersion>`,
    "  <sparkle:informationalUpdate></sparkle:informationalUpdate>",
    `  <link>${escape(link)}</link>`,
    ...(notes ? [`  <description>${escape(notes)}</description>`] : []),
    "</item>",
  ].join("\n      ");
}

/** 整份 appcast：新的一项在最前，旧的原样跟在后面。不带签名（交给 sign_update）。 */
export function renderAppcast({ title, link, items }) {
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    // xmlns:ash 是兼容声明：改名前发的条目原样带过来时里面是 <ash:commit>，前缀没声明整份 XML 就解析不了。
    `<rss version="2.0" xmlns:sparkle="${SPARKLE_NS}" xmlns:navi="https://github.com/noroot777/navi" xmlns:ash="https://github.com/noroot777/ash">`,
    "  <channel>",
    `    <title>${escape(title)}</title>`,
    `    <link>${escape(link)}</link>`,
    ...items.map((xml) => `    ${xml}`),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

/** 上一版是从哪个提交出的（写在 <navi:commit> 里；改名前的条目写的是 <ash:commit>），给这一版的更新说明划范围。 */
export function previousCommit(items) {
  return items[0]?.xml.match(/<(navi|ash):commit>\s*([0-9a-f]{7,40})\s*<\/\1:commit>/)?.[2] ?? null;
}
