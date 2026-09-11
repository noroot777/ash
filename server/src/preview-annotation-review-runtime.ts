import { reliableAnnotationMatch, scoreAnnotationCandidate } from "@ash/shared/page-annotation-review";

export function previewAnnotationReviewRuntime(): string {
  return String.raw`
  const scoreCandidate = ${scoreAnnotationCandidate.toString()};
  const reliableMatch = ${reliableAnnotationMatch.toString()};
  const query = document.querySelectorAll && bind(document.querySelectorAll, document);
  const scrollIntoView = Element.prototype.scrollIntoView && call(Element.prototype.scrollIntoView);
  let reviewTarget = null;
  const locate = (command) => {
    reviewTarget = null;
    const old = command.annotation, requestId = command.requestId;
    if (!old || typeof old.id !== 'string' || typeof requestId !== 'string') return;
    const reply = (reason, score = 0, element = null) => send({ type: 'match', match: {
      id: old.id, requestId, reliable: !!element, score, reason, element,
    } });
    const current = context();
    if (!old.element || !old.context || !query) { reply('缺少可靠的元素特征，请回看原记录并重新圈选'); return; }
    if (old.context.route !== current.route) { reply('当前路径与原记录不同，请先浏览到原路径后重新查找'); return; }
    const candidates = new Map();
    for (const selector of old.element.selectors || []) {
      if (typeof selector !== 'string' || selector.length > 1000) continue;
      try { for (const node of query(selector)) { if (candidates.size >= 1200) break; candidates.set(node, true); } } catch {}
    }
    const name = /^[a-z][a-z0-9-]*$/.test(old.element.tag) ? old.element.tag : 'button';
    for (const node of query(name + ',[role],button,a,img')) {
      if (candidates.size >= 1200) break;
      if (!candidates.has(node)) candidates.set(node, false);
    }
    const ranked = [];
    for (const [node, selectorMatch] of candidates) {
      if (node === host || !connected(node)) continue;
      const rect = bounds(node), style = computed(node);
      if (rect.width <= 0 || rect.height <= 0 || cssValue(style, 'visibility') === 'hidden' || cssValue(style, 'display') === 'none') continue;
      const features = { tag: tag(node), text: safeText(node), role: roleOf(node), rect };
      ranked.push({ node, score: scoreCandidate(old.element, features, old.context, current, selectorMatch) });
    }
    ranked.sort((a, b) => b.score - a.score);
    if (!reliableMatch(ranked.map((item) => item.score))) {
      reply('匹配不可靠或有多个相似对象；保留原图与目标摘要，不显示旧坐标', ranked[0]?.score || 0); return;
    }
    const best = ranked[0];
    reviewTarget = { target: best.node, route: current.route, number: old.number };
    if (scrollIntoView) scrollIntoView(best.node, { block: 'center', inline: 'nearest', behavior: 'instant' });
    reply('已结合文字、角色、位置与候选 selector 重找，请逐条核对', best.score, card(best.node));
  };
  const paintReview = () => {
    if (!reviewTarget || reviewTarget.route !== context().route || !connected(reviewTarget.target)) return;
    const r = bounds(reviewTarget.target);
    svg('rect', { x: r.x, y: r.y, width: r.width, height: r.height, fill: '#159b751a', stroke: '#159b75', 'stroke-width': 3 });
    setText(svg('text', { x: r.x + 4, y: Math.max(14, r.y - 6), fill: '#159b75', 'font-size': 13, 'font-family': 'system-ui' }), '复看 #' + reviewTarget.number);
  };
  `;
}
