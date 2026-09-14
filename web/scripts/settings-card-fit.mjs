// 「设置卡片穿模」体检：卡片里的字**要么落在内边距线内，要么就不存在**。
//
// 这类毛病在这个仓库里反复出现过（最近一次：项目设置 → 预览 →「启动范围」那段说明整段
// 贴着卡片边框排）。根子在 `.settings-card` 自己不带内边距——分隔线要画满整张卡，所以
// 内边距一向由里面的行各自带。于是每加一块**不是行**的东西（说明段、提示、空态、整块
// 表格），都得自己记着补那 16px；一忘就贴边，或者干脆把卡片顶穿。
//
// 这里把判据写成可执行的：
//  · 贴边   —— 文字离卡片左右边框不到 8px（行的内边距是 16px，贴边一眼看得出没对齐）
//  · 被裁切 —— 文字被容器切掉了，而那个容器既不能滚动、也没有省略号
//
// 两条都放过的情况（不是毛病）：横向滚动容器里的字贴着自己的容器边（滚得出来）、
// text-overflow:ellipsis 的定长单行（切得是有意的）、无障碍专用的 1×1 隐藏文字。
export const CARD_BLEED_PROBE = () => {
  const out = [];
  const desc = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 4; i++) {
      parts.unshift(node.tagName.toLowerCase() + (typeof node.className === "string" && node.className ? `.${node.className.trim().split(/\s+/).join(".")}` : ""));
      if (node.classList && node.classList.contains("settings-card")) break;
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  for (const card of document.querySelectorAll(".settings-card")) {
    const cardRect = card.getBoundingClientRect();
    if (cardRect.width < 40) continue;
    // 离这段字最近的「会裁剪/可滚动」的祖先。不是卡片本身时，贴边是那个容器的事。
    const clipper = (el) => {
      for (let node = el; node; node = node.parentElement) {
        if (node === card) return card;
        const style = getComputedStyle(node);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") return node;
      }
      return card;
    };
    const seen = new Set();
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const parentRect = parent.getBoundingClientRect();
      // 无障碍专用文字（1×1 + clip 抠掉）本来就不该被看见。
      if (parentRect.width <= 2 || parentRect.height <= 2 || (style.clip && style.clip !== "auto")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const box = clipper(parent);
      const boxRect = box.getBoundingClientRect();
      const boxStyle = getComputedStyle(box);
      const scrollable = ["auto", "scroll"].includes(boxStyle.overflowX) || ["auto", "scroll"].includes(boxStyle.overflowY);
      const cut = rect.right > boxRect.right + 1 || rect.left < boxRect.left - 1;
      const left = Math.round(rect.left - cardRect.left);
      const right = Math.round(cardRect.right - rect.right);
      const bleeding = box === card && (left < 8 || right < 8);
      if (!bleeding && (!cut || scrollable || boxStyle.textOverflow === "ellipsis")) continue;
      const kind = bleeding ? "贴边" : "被裁切";
      const key = `${kind}${desc(parent)}${left}|${right}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, left, right, where: desc(parent), text: node.nodeValue.trim().slice(0, 44) });
    }
  }
  return out;
};

/** 在当前页面上体检一遍，返回可直接打印的问题清单（空数组 = 干净）。 */
export const findCardBleed = (page) => page.evaluate(CARD_BLEED_PROBE);

/** 按一串视口宽度体检；任一宽度上出问题就抛，错误里带上是哪一块、差多少。 */
export async function assertCardsFit(page, widths, label) {
  const { default: assert } = await import("node:assert/strict");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(120);
    const findings = await findCardBleed(page);
    assert.equal(
      findings.length,
      0,
      `${label} 在 ${width}px 下有内容穿出设置卡片：\n${findings.map((f) => `  ${f.kind} 左${f.left} 右${f.right}  ${f.where}\n    「${f.text}」`).join("\n")}`,
    );
  }
}
