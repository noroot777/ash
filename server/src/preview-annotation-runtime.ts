import { PREVIEW_ANNOTATION_PROTOCOL } from "@ash/shared/page-annotation";
import { previewAnnotationReviewRuntime } from "./preview-annotation-review-runtime.js";
import { previewAnnotationImageRuntime } from "./preview-annotation-image.js";

// Runs before application scripts. The top-level preview exits before touching DOM or APIs.
export function previewAnnotationRuntime(): string {
  return String.raw`(() => {
  if (window.parent === window) return;
  const protocol = ${JSON.stringify(PREVIEW_ANNOTATION_PROTOCOL)};
  const bind = Function.prototype.call.bind(Function.prototype.bind);
  const call = (fn) => Function.prototype.call.bind(fn);
  const add = call(EventTarget.prototype.addEventListener);
  const stop = call(Event.prototype.stopImmediatePropagation);
  const prevent = call(Event.prototype.preventDefault);
  const pathOf = call(Event.prototype.composedPath);
  const append = call(Node.prototype.appendChild);
  const remove = call(Node.prototype.removeChild);
  const attr = call(Element.prototype.getAttribute);
  const setAttr = call(Element.prototype.setAttribute);
  const rectOf = call(Element.prototype.getBoundingClientRect);
  const capturePointer = call(Element.prototype.setPointerCapture);
  const releasePointer = call(Element.prototype.releasePointerCapture);
  const attach = call(Element.prototype.attachShadow);
  const get = (proto, name) => call(Object.getOwnPropertyDescriptor(proto, name).get);
  const parentOf = get(Node.prototype, 'parentElement');
  const childrenOf = get(Node.prototype, 'childNodes');
  const nodeType = get(Node.prototype, 'nodeType');
  const textOf = get(Node.prototype, 'textContent');
  const setText = call(Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').set);
  const tagOf = get(Element.prototype, 'localName');
  const connected = get(Node.prototype, 'isConnected');
  const shadowOf = get(Element.prototype, 'shadowRoot');
  const shadowPoint = ShadowRoot.prototype.elementFromPoint && call(ShadowRoot.prototype.elementFromPoint);
  const scrollElement = call(Element.prototype.scrollBy);
  const scrollWindow = bind(window.scrollBy, window);
  const scrollTop = get(Element.prototype, 'scrollTop');
  const scrollLeft = get(Element.prototype, 'scrollLeft');
  const scrollHeight = get(Element.prototype, 'scrollHeight');
  const scrollWidth = get(Element.prototype, 'scrollWidth');
  const clientHeight = get(Element.prototype, 'clientHeight');
  const clientWidth = get(Element.prototype, 'clientWidth');
  const create = bind(document.createElement, document);
  const createNS = bind(document.createElementNS, document);
  const atPoint = bind(document.elementFromPoint, document);
  const computed = bind(window.getComputedStyle, window);
  const cssValue = call(CSSStyleDeclaration.prototype.getPropertyValue);
  const setCss = call(CSSStyleDeclaration.prototype.setProperty);
  const styleOf = get(HTMLElement.prototype, 'style');
  const post = call(MessagePort.prototype.postMessage);
  const startPort = call(MessagePort.prototype.start);
  const closePort = call(MessagePort.prototype.close);
  const interval = bind(window.setInterval, window);
  const clearTimer = bind(window.clearInterval, window);
  const frame = bind(window.requestAnimationFrame, window);
  const now = Date.now.bind(Date);
  const stringify = JSON.stringify.bind(JSON);
  const String = window.String;
  const slice = call(String.prototype.slice);
  const replace = call(String.prototype.replace);
  const trim = call(String.prototype.trim);
  const split = call(String.prototype.split);
  const matches = call(RegExp.prototype.test);
  const escapeCss = bind(CSS.escape, CSS);
  const show = HTMLElement.prototype.showPopover && call(HTMLElement.prototype.showPopover);
  const hide = HTMLElement.prototype.hidePopover && call(HTMLElement.prototype.hidePopover);
  const uid = bind(crypto.getRandomValues, crypto);
  const Uint = Uint32Array;
  const Math = { min: window.Math.min, max: window.Math.max, ceil: window.Math.ceil, hypot: window.Math.hypot, abs: window.Math.abs };
  const SVG = 'http://www.w3.org/2000/svg';
  let port = null, host = null, surface = null, timer = null;
  let mode = 'browse', tool = 'element', selected = null, gesture = null;
  let annotations = [], nextNumber = 1, scheduled = false, lastContext = '';
  let badges = [];
  let lastRoute = '', lastHeartbeat = 0;
  const clean = (value, limit = 240) => slice(trim(replace(replace(replace(replace(String(value || ''),
    /\/preview\/[^/\s]+\/[^/\s]+\/[^/\s]+\//g, '/'),
    /(?:Bearer\s+\S+|(?:password|passwd|token|secret|api[_-]?key|authorization)\s*[=:]\s*[^\s<>"']+)/gi, '[redacted]'),
    /\b[A-Za-z0-9_+\/-]{24,}(?:\.[A-Za-z0-9_+\/-]+)*={0,2}\b/g, '[redacted]'), /\s+/g, ' ')), 0, limit);
  const css = (element, name, value) => setCss(styleOf(element), name, value, 'important');
  const tag = (element) => element && nodeType(element) === 1 ? tagOf(element) : '';
  const skip = (element) => matches(/^(input|textarea|select|option|script|style|noscript|template|iframe|object|embed)$/, tag(element))
    || attr(element, 'contenteditable') !== null || matches(/password|token|secret|api[_-]?key/i, (attr(element, 'name') || '') + ' ' + (attr(element, 'id') || ''));
  const privateTree = (element) => {
    for (let node = element; node; node = parentOf(node)) if (skip(node)) return true;
    return false;
  };
  const selector = (element) => {
    const name = tag(element);
    const id = attr(element, 'id');
    if (id && clean(id) === id) return '#' + escapeCss(id);
    const testId = attr(element, 'data-testid');
    if (testId && clean(testId) === testId) return name + '[data-testid="' + escapeCss(testId) + '"]';
    const classes = split(attr(element, 'class') || '', /\s+/);
    let result = name, count = 0;
    for (const item of classes) if (item && clean(item) === item && count++ < 2) result += '.' + escapeCss(item);
    return result;
  };
  const roleOf = (element) => clean(attr(element, 'role') || ({ button: 'button', a: attr(element, 'href') ? 'link' : '',
    input: attr(element, 'type') === 'checkbox' ? 'checkbox' : 'textbox', textarea: 'textbox', select: 'combobox', img: 'img' })[tag(element)] || '', 60);
  const safeText = (element) => {
    if (privateTree(element)) return '';
    let result = '', visited = 0;
    const walk = (node) => {
      if (++visited > 100 || result.length > 500) return;
      if (nodeType(node) === 3) { result += ' ' + textOf(node); return; }
      if (nodeType(node) !== 1 || skip(node)) return;
      for (const child of childrenOf(node)) walk(child);
    };
    walk(element);
    return clean(result);
  };
  const htmlEscape = (value) => replace(replace(replace(value, /&/g, '&amp;'), /</g, '&lt;'), /"/g, '&quot;');
  const safeHtml = (element) => {
    if (privateTree(element)) return '<' + tag(element) + '>[form content omitted]</' + tag(element) + '>';
    let budget = 80;
    const walk = (node, depth) => {
      if (--budget < 0) return '…';
      if (nodeType(node) === 3) return htmlEscape(clean(textOf(node), 100));
      if (nodeType(node) !== 1) return '';
      const name = tag(node);
      if (skip(node)) return '<' + name + '>[omitted]</' + name + '>';
      let result = '<' + name;
      for (const key of ['id', 'class', 'role', 'aria-label', 'type', 'data-testid']) {
        const value = attr(node, key);
        if (value) result += ' ' + key + '="' + htmlEscape(clean(value, 100)) + '"';
      }
      result += '>';
      if (depth < 3) for (const child of childrenOf(node)) { result += walk(child, depth + 1); if (result.length > 1800) break; }
      else result += '…';
      return result + '</' + name + '>';
    };
    return slice(walk(element, 0), 0, 1800);
  };
  const bounds = (element) => {
    const r = rectOf(element);
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const card = (element) => {
    const ancestors = [], selectors = [selector(element)];
    for (let node = parentOf(element); node && ancestors.length < 4; node = parentOf(node)) {
      ancestors[ancestors.length] = { tag: tag(node), selector: selector(node), role: roleOf(node) };
    }
    if (ancestors.length) selectors[selectors.length] = ancestors[0].selector + ' > ' + selectors[0];
    const styles = computed(element), computedStyle = {};
    for (const key of ['display', 'position', 'box-sizing', 'color', 'background-color', 'font-family', 'font-size', 'font-weight',
      'line-height', 'width', 'height', 'padding', 'margin', 'gap', 'border', 'border-radius', 'align-items', 'justify-content', 'overflow', 'z-index']) {
      computedStyle[key] = clean(cssValue(styles, key), 120);
    }
    return { selectors, tag: tag(element), text: safeText(element), role: roleOf(element), rect: bounds(element),
      outerHTML: safeHtml(element), computedStyle, ancestors };
  };
  const context = () => ({
    route: clean(replace(location.pathname, /^\/preview\/[^/]+\/[^/]+\/[^/]+\//, '/') + split(location.hash, '?')[0], 500),
    scroll: { x: window.scrollX, y: window.scrollY },
    viewport: { width: window.innerWidth, height: window.innerHeight, scale: window.visualViewport?.scale || 1 }, capturedAt: now(),
  });
  const send = (message) => { if (port) try { post(port, message); } catch {} };
  ${previewAnnotationImageRuntime()}
  ${previewAnnotationReviewRuntime()}
  const parentAvailable = () => !!(selected?.target && selected.data.context.route === context().route && connected(selected.target) && parentOf(selected.target));
  const reportSelection = () => send({ type: 'selection', id: selected?.data.id || null, canSelectParent: parentAvailable() });
  const emitAnnotation = (entry) => send({ type: 'annotation', annotation: entry.data, canSelectParent: parentAvailable() });
  const svg = (name, attrs, parent = surface) => {
    const node = createNS(SVG, name);
    for (const key in attrs) setAttr(node, key, String(attrs[key]));
    append(parent, node);
    return node;
  };
  const paint = () => {
    scheduled = false;
    if (!host || !port) return;
    if (!connected(host)) append(document.documentElement, host);
    if (show) try { show(host); } catch {}
    css(host, 'pointer-events', mode === 'annotate' ? 'auto' : 'none');
    css(host, 'cursor', mode === 'annotate' ? tool === 'element' ? 'default' : 'crosshair' : 'auto');
    setText(surface, '');
    badges = [];
    const current = context();
    const draw = (entry, draft = false) => {
      if (entry.data.context.route !== current.route) return;
      const active = entry === selected;
      const color = active ? '#5e6ad2' : '#d93d4c';
      const points = entry.data.points;
      let dx = 0, dy = 0;
      if (entry.target && entry.data.element && connected(entry.target)) {
        const live = bounds(entry.target), initial = entry.data.element.rect, scroll = entry.data.context.scroll;
        dx = live.x + window.scrollX - initial.x - scroll.x;
        dy = live.y + window.scrollY - initial.y - scroll.y;
      }
      let x = points[0].x - window.scrollX + dx, y = points[0].y - window.scrollY + dy;
      if (entry.data.tool === 'element' && entry.target && connected(entry.target)) {
        const r = bounds(entry.target); x = r.x; y = r.y;
        svg('rect', { x, y, width: r.width, height: r.height, fill: '#5e6ad21a', stroke: color, 'stroke-width': 2 });
      } else if (entry.data.tool === 'rectangle') {
        const end = points[points.length - 1];
        svg('rect', { x: Math.min(x, end.x - window.scrollX + dx), y: Math.min(y, end.y - window.scrollY + dy),
          width: Math.abs(end.x - points[0].x), height: Math.abs(end.y - points[0].y), fill: 'none', stroke: color, 'stroke-width': 2 });
      } else if (entry.data.tool === 'pen') {
        let line = '';
        for (const point of points) line += (point.x - window.scrollX + dx) + ',' + (point.y - window.scrollY + dy) + ' ';
        svg('polyline', { points: line, fill: 'none', stroke: color, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      }
      if (draft) return;
      x = Math.max(13, Math.min(current.viewport.width - 13, x));
      if (y < -24 || y > current.viewport.height + 24) return;
      y = Math.max(13, Math.min(current.viewport.height - 13, y));
      badges[badges.length] = { entry, x, y };
      svg('circle', { cx: x, cy: y, r: 12, fill: color, stroke: '#fff', 'stroke-width': 2 });
      setText(svg('text', { x, y: y + 4, fill: '#fff', 'text-anchor': 'middle', 'font-size': 11, 'font-family': 'system-ui', 'font-weight': 700 }), String(entry.data.number));
    };
    for (const entry of annotations) draw(entry);
    if (gesture) draw(gesture.entry, true);
    paintReview();
  };
  const schedule = () => { if (port && !scheduled) { scheduled = true; frame(paint); } };
  const reportContext = () => {
    if (!port) return;
    const data = context();
    const key = stringify({ route: data.route, scroll: data.scroll, viewport: data.viewport });
    if (data.route !== lastRoute) { lastRoute = data.route; selected = null; gesture = null; reportSelection(); }
    if (key !== lastContext || now() - lastHeartbeat > 2000) {
      lastContext = key; lastHeartbeat = now(); send({ type: 'context', context: data });
    }
    schedule();
  };
  const mount = () => {
    host = create('div');
    setAttr(host, 'aria-hidden', 'true');
    if (show) setAttr(host, 'popover', 'manual');
    css(host, 'all', 'initial');
    for (const [key, value] of [['position', 'fixed'], ['inset', '0'], ['width', '100vw'], ['height', '100vh'], ['margin', '0'],
      ['padding', '0'], ['border', '0'], ['background', 'transparent'], ['overflow', 'hidden'], ['z-index', '2147483647'], ['pointer-events', 'none']]) css(host, key, value);
    const shadow = attach(host, { mode: 'closed' });
    const styles = create('style');
    setText(styles, ':host { color-scheme: light; } svg { display:block;width:100%;height:100%;pointer-events:none; }');
    append(shadow, styles);
    surface = createNS(SVG, 'svg');
    append(shadow, surface);
    append(document.documentElement, host);
    if (show) try { show(host); } catch {}
  };
  const targetAt = (event) => {
    css(host, 'pointer-events', 'none');
    let element;
    try { element = atPoint(event.clientX, event.clientY); } finally { css(host, 'pointer-events', 'auto'); }
    // composedPath reaches into open shadow trees when the underlying page was the event target.
    const path = pathOf(event);
    if (path[0] !== host) for (const node of path) {
      if (node !== host && node !== window && node !== document && nodeType(node) === 1) { element = node; break; }
    }
    if (shadowPoint) for (let depth = 0; element && depth < 8; depth++) {
      const shadow = shadowOf(element);
      const inner = shadow && shadowPoint(shadow, event.clientX, event.clientY);
      if (!inner || inner === element) break;
      element = inner;
    }
    return element === host ? null : element;
  };
  const point = (event) => ({ x: event.clientX + window.scrollX, y: event.clientY + window.scrollY });
  const newEntry = (event) => {
    const target = targetAt(event);
    const random = uid(new Uint(4));
    const entry = { target, data: { id: 'pa-' + random[0] + '-' + random[1] + '-' + random[2] + '-' + random[3], number: nextNumber++,
      tool, points: [point(event)], element: target ? card(target) : null, context: context() } };
    captureImage(entry);
    return entry;
  };
  const commit = (entry) => {
    if (annotations.length >= 100) { send({ type: 'error', message: '当前页面最多暂存 100 条标注，请先删除部分标注。' }); return; }
    annotations[annotations.length] = entry; selected = entry; entry.committed = true; emitAnnotation(entry);
    if (entry.image) send({ type: 'image', id: entry.data.id, image: entry.image });
    schedule();
  };
  const capture = (event) => {
    if (!port || mode !== 'annotate') return;
    stop(event);
    if (event.cancelable) prevent(event);
    try {
      if (event.type === 'pointerdown' && event.button === 0 && !gesture) {
        paint();
        for (let index = badges.length - 1; index >= 0; index--) {
          const badge = badges[index];
          if (Math.hypot(event.clientX - badge.x, event.clientY - badge.y) <= 14) {
            selected = badge.entry; reportSelection(); schedule(); return;
          }
        }
        const entry = newEntry(event);
        if (tool === 'element' || tool === 'pin') commit(entry);
        else { gesture = { pointerId: event.pointerId, entry }; capturePointer(host, event.pointerId); }
      } else if ((event.type === 'pointermove' || event.type === 'pointerup') && gesture?.pointerId === event.pointerId) {
        const points = gesture.entry.data.points, next = point(event), last = points[points.length - 1];
        if (gesture.entry.data.tool === 'rectangle') points[1] = next;
        else if (points.length < 1000 && Math.hypot(next.x - last.x, next.y - last.y) >= 2) points[points.length] = next;
        if (event.type === 'pointerup') {
          const entry = gesture.entry; gesture = null;
          releasePointer(host, event.pointerId);
          const end = points[points.length - 1];
          if (points.length > 1 && (entry.data.tool === 'pen' || Math.hypot(end.x - points[0].x, end.y - points[0].y) >= 3)) commit(entry);
        }
      } else if (event.type === 'keydown' && (event.key === 'z' || event.key === 'Z') && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
        if (gesture) { releasePointer(host, gesture.pointerId); gesture = null; }
        else send({ type: 'undo' });
      } else if (event.type === 'pointercancel' || (event.type === 'keydown' && event.key === 'Escape')) gesture = null;
      schedule();
    } catch { gesture = null; send({ type: 'error', message: '无法读取这个页面对象，请选择外层容器或改用截图批注。' }); }
  };
  // These listeners precede page listeners but remain inert until a transferred parent port arrives.
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout',
    'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'keydown', 'keyup', 'keypress', 'beforeinput', 'submit', 'dragstart', 'drop']) {
    add(window, type, capture, { capture: true, passive: false });
  }
  add(window, 'wheel', (event) => {
    if (!port || mode !== 'annotate') return;
    stop(event); prevent(event);
    try {
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      const dx = event.deltaX * factor, dy = event.deltaY * factor;
      for (let node = targetAt(event); node; node = parentOf(node)) {
        const styles = computed(node);
        const vertical = dy && matches(/auto|scroll|overlay/, cssValue(styles, 'overflow-y'))
          && (dy < 0 ? scrollTop(node) > 0 : scrollTop(node) + clientHeight(node) < scrollHeight(node));
        const horizontal = dx && matches(/auto|scroll|overlay/, cssValue(styles, 'overflow-x'))
          && (dx < 0 ? scrollLeft(node) > 0 : scrollLeft(node) + clientWidth(node) < scrollWidth(node));
        if (vertical || horizontal) { scrollElement(node, { left: dx, top: dy, behavior: 'instant' }); return; }
      }
      scrollWindow({ left: dx, top: dy, behavior: 'instant' });
    } catch {}
  }, { capture: true, passive: false });
  const disconnect = () => {
    mode = 'browse'; gesture = null; selected = null; annotations = []; badges = []; reviewTarget = null;
    if (timer) clearTimer(timer);
    timer = null;
    if (host) {
      if (hide) try { hide(host); } catch {}
      if (parentOf(host)) remove(parentOf(host), host);
    }
    host = null; surface = null;
    if (port) closePort(port);
    port = null;
  };
  add(window, 'message', (event) => {
    if (event.source !== window.parent || event.data?.protocol !== protocol || event.ports.length !== 1) return;
    stop(event);
    if (port) disconnect();
    if (typeof event.data.nextNumber === 'number' && event.data.nextNumber > 0 && event.data.nextNumber < 1e9) nextNumber = Math.ceil(event.data.nextNumber);
    port = event.ports[0];
    add(port, 'message', (event) => {
      const command = event.data;
      try {
        if (command?.type === 'configure' && (command.mode === 'browse' || command.mode === 'annotate')
          && matches(/^(element|rectangle|pen|pin)$/, command.tool)) {
          mode = command.mode; tool = command.tool; gesture = null;
          paint(); send({ type: 'configured', mode, tool });
        } else if (command?.type === 'locate') {
          mode = 'annotate'; gesture = null;
          locate(command); paint(); send({ type: 'configured', mode, tool });
        } else if (command?.type === 'clear-review') { reviewTarget = null;
        } else if (command?.type === 'parent' && selected?.target && parentAvailable()) {
          selected.target = parentOf(selected.target);
          selected.data.element = card(selected.target);
          selected.data.tool = 'element'; selected.data.context = context();
          const r = selected.data.element.rect;
          selected.data.points = [{ x: r.x + window.scrollX, y: r.y + window.scrollY }];
          emitAnnotation(selected);
          captureImage(selected);
        } else if (command?.type === 'focus') {
          selected = null;
          for (const entry of annotations) if (entry.data.id === command.id) selected = entry;
          reportSelection();
        } else if (command?.type === 'remove') {
          const remaining = [];
          for (const entry of annotations) if (entry.data.id !== command.id) remaining[remaining.length] = entry;
          annotations = remaining;
          if (selected?.data.id === command.id) { selected = null; reportSelection(); }
        } else if (command?.type === 'clear') { annotations = []; selected = null; reportSelection(); }
        else if (command?.type === 'disconnect') { disconnect(); return; }
        schedule();
      } catch { send({ type: 'error', message: '页面对象已变化，请重新点选。' }); }
    });
    startPort(port);
    try {
      mount(); send({ type: 'ready', context: context() });
      reportContext(); timer = interval(reportContext, 250);
    } catch { send({ type: 'error', message: '这个页面无法启用标注，请改用截图批注。' }); disconnect(); }
  }, true);
  add(window, 'scroll', reportContext, true);
  add(window, 'resize', reportContext, true);
  add(window, 'pagehide', disconnect, true);
  })();`;
}
