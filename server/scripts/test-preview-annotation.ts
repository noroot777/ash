import assert from "node:assert/strict";
import vm from "node:vm";
import { previewAnnotationRuntime } from "../src/preview-annotation-runtime.js";
import { neutralizePreviewMetaCsp } from "../src/preview-meta-csp.js";
import { rewritePreviewText } from "../src/preview-proxy-rewrite.js";
import { PREVIEW_ANNOTATION_PROTOCOL } from "../../shared/src/page-annotation.ts";
import { parsePreviewMessage } from "../../web/src/preview-workspace/previewMessages.ts";
import type { PreviewRecord } from "../src/preview-store.js";

const runtime = previewAnnotationRuntime();
new vm.Script(runtime);
const top = {};
Object.assign(top, { parent: top });
vm.runInNewContext(runtime, { window: top }); // No DOM, constructors or timers exist here.

for (const meta of [
  '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">',
  "<META content='x > y' HTTP-EQUIV = content-security-policy>",
  '<meta http-equiv="&#x63;ontent-security-policy" content="default-src none">',
  '<meta http-equiv="content-security-policy-report-only" content="default-src none"/>',
]) assert.equal(neutralizePreviewMetaCsp('<head>' + meta + '<meta charset="utf-8"></head>'), '<head><meta charset="utf-8"></head>');
for (const html of [
  '<script>const sample = `<meta http-equiv="Content-Security-Policy">`;</script>',
  '<!-- <meta http-equiv="Content-Security-Policy"> -->',
  '<textarea><meta http-equiv="Content-Security-Policy"></textarea>',
  '<meta http-equiv="refresh" content="5">',
]) assert.equal(neutralizePreviewMetaCsp(html), html);
const record = { taskId: "test", proxyToken: "a".repeat(48), services: [] } as unknown as PreviewRecord;
const rewritten = rewritePreviewText('<html><head><meta http-equiv="Content-Security-Policy" content="script-src none"></head></html>', "text/html", "/preview/test/token/web/", record);
assert(!rewritten.includes('<meta http-equiv="Content-Security-Policy"'));
assert.equal((rewritten.match(/<script>/g) ?? []).length, 2);
assert(rewritten.indexOf(PREVIEW_ANNOTATION_PROTOCOL) < rewritten.indexOf('</head>'));

// A small DOM/port model exercises the actual injected code without launching a browser.
class TestEvent {
  stopped = false;
  defaultPrevented = false;
  cancelable = true;
  type = "";
  composedPath() { return []; }
  stopImmediatePropagation() { this.stopped = true; }
  preventDefault() { this.defaultPrevented = true; }
}
class TestTarget {
  listeners = new Map<string, ((event: TestEvent) => void)[]>();
  addEventListener(type: string, fn: (event: TestEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, data: object = {}) {
    const event = Object.assign(new TestEvent(), { type }, data);
    for (const fn of this.listeners.get(type) ?? []) { fn(event); if (event.stopped) break; }
    return event;
  }
}
class TestNode extends TestTarget {
  parent: TestNode | null = null;
  nodes: TestNode[] = [];
  content = "";
  kind = 1;
  get parentElement() { return this.parent; }
  get childNodes() { return this.nodes; }
  get nodeType() { return this.kind; }
  get textContent() { return this.content; }
  set textContent(value: string) { this.content = value; this.nodes = []; }
  get isConnected(): boolean { return this === root || !!this.parent?.isConnected; }
  appendChild(child: TestNode) { child.parent = this; this.nodes.push(child); return child; }
  removeChild(child: TestNode) { child.parent = null; this.nodes = this.nodes.filter((node) => node !== child); return child; }
}
class TestStyle {
  data = new Map<string, string>();
  setProperty(key: string, value: string) { this.data.set(key, value); }
  getPropertyValue(key: string) { return this.data.get(key) ?? ""; }
}
class TestElement extends TestNode {
  name: string;
  attrs = new Map<string, string>();
  shadow: TestNode | null = null;
  box = { x: 20, y: 40, width: 120, height: 30 };
  scrollY = 0;
  scrollX = 0;
  constructor(name: string) { super(); this.name = name; }
  get localName() { return this.name; }
  get shadowRoot() { return this.shadow; }
  get scrollTop() { return this.scrollY; }
  get scrollLeft() { return this.scrollX; }
  get scrollHeight() { return 500; }
  get scrollWidth() { return 100; }
  get clientHeight() { return 100; }
  get clientWidth() { return 100; }
  scrollBy({ top, left }: { top: number; left: number }) { this.scrollY += top; this.scrollX += left; }
  scrollIntoView() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  getBoundingClientRect() { return this.box; }
  attachShadow(options: { mode: string }) { assert.equal(options.mode, "closed"); this.shadow = new TestNode(); return this.shadow; }
}
class TestHtml extends TestElement {
  styles = new TestStyle();
  get style() { return this.styles; }
}
class TestPort extends TestTarget {
  messages: unknown[] = [];
  closed = false;
  postMessage(data: unknown) { this.messages.push(JSON.parse(JSON.stringify(data))); }
  start() {}
  close() { this.closed = true; }
}
const root = new TestHtml('html');
const button = new TestHtml('button'); button.setAttribute('id', 'delete-button');
const icon = new TestHtml('svg');
const label = new TestNode(); label.kind = 3; label.content = 'Delete';
button.appendChild(icon); button.appendChild(label); root.appendChild(button);
const form = new TestHtml('form');
const input = new TestHtml('input'); input.setAttribute('type', 'password'); input.setAttribute('value', 'PRIVATE_PASSWORD');
const area = new TestHtml('textarea'); area.textContent = 'UNRELATED_FORM_CONTENT';
const token = new TestHtml('div'); token.setAttribute('data-token', 'SUPER_SECRET_DATA');
const tokenText = new TestNode(); tokenText.kind = 3; tokenText.content = 'token=SECRET_ASSIGNMENT abcdefghijklmnopqrstuvwxyz123456789'; token.appendChild(tokenText);
form.appendChild(input); form.appendChild(area); form.appendChild(token); root.appendChild(form);
let hit: TestHtml = icon;
const timers = new Set<() => void>();
const frames: Array<() => void> = [];
const parent = {};
const window = Object.assign(new TestTarget(), { parent, scrollX: 0, scrollY: 0, innerWidth: 1000, innerHeight: 700,
  String, Math, scrollBy: () => {},
  getComputedStyle: () => { const style = new TestStyle(); style.setProperty('overflow-y', 'auto'); return style; },
  setInterval: (fn: () => void) => { timers.add(fn); return fn; },
  clearInterval: (fn: () => void) => timers.delete(fn), requestAnimationFrame: (fn: () => void) => frames.push(fn),
});
const location = { pathname: '/preview/test/PRIVATE_PREVIEW_TOKEN/web/home', hash: '#section?token=hash-secret' };
const context = vm.createContext({ window, document: { documentElement: root, createElement: (tag: string) => new TestHtml(tag),
  createElementNS: (_ns: string, tag: string) => new TestElement(tag), elementFromPoint: () => hit,
  querySelectorAll: (selector: string) => selector.includes('delete-button') || selector.includes('button') ? [button] : [] },
  EventTarget: TestTarget, Event: TestEvent, Node: TestNode, Element: TestElement, HTMLElement: TestHtml,
  ShadowRoot: TestNode,
  CSSStyleDeclaration: TestStyle, MessagePort: TestPort, CSS: { escape: (value: string) => value },
  crypto: { getRandomValues: (array: Uint32Array) => crypto.getRandomValues(array) }, location,
});
vm.runInContext(runtime, context);
assert.equal(root.nodes.length, 2, 'embedded runtime is dormant before handshake');
assert.equal(timers.size, 0);
assert.equal(window.fire('click').defaultPrevented, false);
const ignored = new TestPort();
window.fire('message', { source: {}, origin: 'null', data: { protocol: PREVIEW_ANNOTATION_PROTOCOL }, ports: [ignored] });
assert.equal(ignored.messages.length, 0, 'null origin is not identity');
const port = new TestPort();
window.fire('message', { source: parent, origin: 'null', data: { protocol: PREVIEW_ANNOTATION_PROTOCOL, nextNumber: 7 }, ports: [port] });
assert.equal(root.nodes.length, 3);
assert.equal(timers.size, 1);
assert(port.messages.some((item) => (item as { type: string }).type === 'ready'));
const command = (data: object) => port.fire('message', { data });
const pointer = (type: string, x = 40, y = 60) => window.fire(type, { button: 0, pointerId: 1, clientX: x, clientY: y });
const annotations = () => port.messages.flatMap((item) => {
  const event = parsePreviewMessage(item);
  return event?.type === 'annotation' ? [event.annotation] : [];
});
command({ type: 'configure', mode: 'annotate', tool: 'element' });
let pageClicks = 0;
window.addEventListener('click', () => { pageClicks++; });
TestElement.prototype.getBoundingClientRect = () => { throw new Error('page replaced rect API'); };
TestElement.prototype.getAttribute = () => { throw new Error('page replaced attribute API'); };
pointer('pointerdown');
window.fire('click'); window.fire('keydown', { key: 'Enter' });
assert.equal(pageClicks, 0);
assert.equal(annotations().at(-1)?.element?.tag, 'svg', JSON.stringify(port.messages));
assert.equal(annotations().at(-1)?.number, 7);
command({ type: 'parent' });
assert.equal(annotations().at(-1)?.element?.tag, 'button');
assert.equal(annotations().at(-1)?.element?.text, 'Delete');
const oldButton = structuredClone(annotations().at(-1)!);
const firstId = annotations()[0].id;
assert.equal(annotations().at(-1)?.id, firstId, 'selecting parent updates the same annotation');
command({ type: 'parent' });
assert.equal(annotations().at(-1)?.element?.tag, 'html');
hit = form;
pointer('pointerdown');
const sanitized = JSON.stringify(annotations().at(-1));
for (const secret of ['PRIVATE_PASSWORD', 'UNRELATED_FORM_CONTENT', 'SUPER_SECRET_DATA', 'SECRET_ASSIGNMENT', 'abcdefghijklmnopqrstuvwxyz123456789', 'PRIVATE_PREVIEW_TOKEN', 'hash-secret']) {
  assert(!sanitized.includes(secret), `redacts ${secret}`);
}
assert(sanitized.includes('[redacted]'));
command({ type: 'configure', mode: 'annotate', tool: 'rectangle' });
pointer('pointerdown', 10, 10); pointer('pointermove', 50, 70); pointer('pointerup', 50, 70);
assert.equal(annotations().at(-1)?.tool, 'rectangle');
assert.deepEqual(annotations().at(-1)?.points, [{ x: 10, y: 10 }, { x: 50, y: 70 }]);
command({ type: 'configure', mode: 'annotate', tool: 'pen' });
pointer('pointerdown'); pointer('pointermove', 45, 70); pointer('pointerup', 50, 80);
assert.equal(annotations().at(-1)?.points.length, 3);
command({ type: 'configure', mode: 'annotate', tool: 'pin' });
pointer('pointerdown');
assert.equal(annotations().at(-1)?.tool, 'pin');
assert.equal(window.fire('wheel', { clientX: 40, clientY: 60, deltaMode: 0, deltaY: 35, deltaX: 0 }).defaultPrevented, true);
assert.equal(form.scrollY, 35, 'wheel scrolls the underlying nested container');
const latestId = annotations().at(-1)!.id;
command({ type: 'remove', id: latestId });
command({ type: 'focus', id: latestId });
assert(port.messages.map(parsePreviewMessage).some((item) => item?.type === 'selection' && item.id === null));
window.scrollY = 130; location.pathname = '/preview/test/PRIVATE_PREVIEW_TOKEN/web/next'; window.innerWidth = 800;
for (const tick of timers) tick();
const reported = port.messages.map(parsePreviewMessage).filter((item) => item?.type === 'context').at(-1);
assert.equal(reported?.context.route, '/next#section');
assert.equal(reported?.context.scroll.y, 130);
assert.equal(reported?.context.viewport.width, 800);
for (const draw of frames.splice(0)) draw();
location.pathname = '/preview/test/PRIVATE_PREVIEW_TOKEN/web/home';
window.innerWidth = 1000; window.scrollY = 130;
button.box = { x: 20, y: -90, width: 120, height: 30 };
command({ type: 'clear' });
command({ type: 'locate', annotation: oldButton, requestId: 'review-request' });
const match = port.messages.map(parsePreviewMessage).filter((event) => event?.type === 'match').at(-1);
assert(match?.match.reliable, JSON.stringify(port.messages.slice(-5)));
assert.equal(match.match.element?.rect.y, -90, 'review uses live bounds after scrolling');
window.fire('click'); assert.equal(pageClicks, 0, 'locating and reviewing do not activate the target');
for (const draw of frames.splice(0)) draw();
const overlay = root.nodes.at(-1) as TestHtml;
const surface = overlay.shadow?.nodes.at(-1);
assert(surface?.nodes.some((node) => (node as TestElement).attrs.get('y') === '-90'), 'highlight follows current bounds');
label.content = 'Remove everything';
command({ type: 'locate', annotation: oldButton, requestId: 'reused-selector' });
const missing = port.messages.map(parsePreviewMessage).filter((event) => event?.type === 'match').at(-1);
assert.equal(missing?.match.reliable, false, 'reused selector with different text falls back to the original record');
for (const draw of frames.splice(0)) draw();
assert.equal(surface?.nodes.length, 0, 'unreliable matches never draw old coordinates');
command({ type: 'configure', mode: 'browse', tool: 'element' });
assert.equal(window.fire('click').defaultPrevented, false);
assert.equal(pageClicks, 1);
command({ type: 'disconnect' });
assert.equal(root.nodes.length, 2);
assert.equal(timers.size, 0);
assert(port.closed);
assert.equal(parsePreviewMessage({ type: 'annotation', annotation: { id: 'malformed' } }), null);
assert.equal(parsePreviewMessage({ type: 'context', context: { route: '/x', scroll: { x: NaN, y: 0 } } }), null);
console.log('preview annotation: CSP rewrite, top-level dormancy, source/port handshake, modes, parent selection, shapes, pins, redaction, context and cleanup passed');
