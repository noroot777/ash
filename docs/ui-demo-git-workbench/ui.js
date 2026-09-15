/* Git 工作台 demo · 通用 UI：DOM 工具、图标、toast、分级确认、弹出菜单、diff 渲染。 */
window.GW = window.GW || {};

(function () {
  /* ---------- DOM ---------- */
  GW.el = function (tag, cls, children) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null) return;
        node.append(c.nodeType ? c : document.createTextNode(String(c)));
      });
    }
    return node;
  };
  GW.btn = function (cls, children, onClick) {
    const b = GW.el("button", cls, children);
    if (onClick) b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
    return b;
  };
  GW.html = function (tag, cls, html) {
    const node = GW.el(tag, cls);
    node.innerHTML = html;
    return node;
  };

  /* ---------- 图标（16px 线性，stroke 继承 currentColor） ---------- */
  const P = {
    changes: '<path d="M3 5.5h7M3 8h10M3 10.5h6"/><circle cx="12.5" cy="5.5" r="1.6"/>',
    history: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.2 1.4"/>',
    branch: '<circle cx="4.5" cy="4" r="1.7"/><circle cx="4.5" cy="12" r="1.7"/><circle cx="11.5" cy="6.5" r="1.7"/><path d="M4.5 5.7v4.6M11.5 8.2c0 2.6-4 1.6-6.2 3"/>',
    stash: '<path d="M2.5 6.5 8 3.5l5.5 3L8 9.5z"/><path d="M2.5 9.5 8 12.5l5.5-3"/>',
    tag: '<path d="M8.6 2.5H13v4.4l-6 6a1.2 1.2 0 0 1-1.7 0L2.6 10a1.2 1.2 0 0 1 0-1.7z"/><circle cx="10.6" cy="5" r="1" fill="currentColor" stroke="none"/>',
    worktree: '<rect x="2.5" y="2.5" width="4.6" height="11" rx="1"/><rect x="9" y="2.5" width="4.6" height="5" rx="1"/><rect x="9" y="9.5" width="4.6" height="4" rx="1"/>',
    oplog: '<path d="M3 3.5h10M3 8h10M3 12.5h6.5"/><circle cx="12.5" cy="12.5" r="1.4"/>',
    sync: '<path d="M13 8a5 5 0 0 1-8.7 3.4M3 8a5 5 0 0 1 8.7-3.4"/><path d="M11.6 2.5v2.3H14M4.4 13.5v-2.3H2"/>',
    down: '<path d="M8 3v8M4.8 8 8 11.2 11.2 8"/>',
    up: '<path d="M8 13V5M4.8 8 8 4.8 11.2 8"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    trash: '<path d="M3.5 5h9M6.5 5V3.5h3V5M5 5l.5 8h5L11 5M7 7.5v3.5M9 7.5v3.5"/>',
    check: '<path d="M3 8.5 6.5 12 13 4.5"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    dots: '<circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none"/>',
    undo: '<path d="M6.5 3.5 3 7l3.5 3.5"/><path d="M3 7h6a4 4 0 0 1 0 8H7"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7"/>',
    ai: '<path d="M8 2.5 9.3 6 13 7.3 9.3 8.6 8 12.2 6.7 8.6 3 7.3 6.7 6z"/><path d="M12.6 11.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/>',
    merge: '<circle cx="4.5" cy="4" r="1.7"/><circle cx="4.5" cy="12" r="1.7"/><circle cx="11.5" cy="12" r="1.7"/><path d="M4.5 5.7v4.6M4.5 6c0 3.4 3.8 2.7 5.4 4.8"/>',
    warn: '<path d="M8 2.8 14 13H2z"/><path d="M8 6.8v2.7"/><circle cx="8" cy="11.4" r=".7" fill="currentColor" stroke="none"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
    terminal: '<rect x="2" y="3" width="12" height="10" rx="1.4"/><path d="M4.5 6.5 7 8.5l-2.5 2M8.5 10.5H11"/>',
    play: '<path d="M5 3.5v9l7.5-4.5z"/>',
    chevron: '<path d="M6 4l4 4-4 4"/>',
    search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14"/>',
    detach: '<circle cx="8" cy="8" r="2"/><path d="M8 2v2.4M8 11.6V14M2 8h2.4M11.6 8H14"/>',
    file: '<path d="M4 2.5h5.5L12.5 6v7.5h-8.5z"/><path d="M9.5 2.5V6h3"/>',
  };
  GW.icon = function (name, size) {
    const s = size || 16;
    return '<svg class="ic" width="' + s + '" height="' + s + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || "") + "</svg>";
  };

  /* ---------- toast ---------- */
  GW.toast = function (message, tone) {
    const root = document.getElementById("toast-root");
    const t = GW.el("div", "toast" + (tone ? " toast-" + tone : ""), message);
    root.append(t);
    requestAnimationFrame(() => t.classList.add("is-on"));
    setTimeout(() => { t.classList.remove("is-on"); setTimeout(() => t.remove(), 300); }, 3600);
  };
  /** 操作结果直接转 toast（engine 的返回值形状）。 */
  GW.report = function (result) {
    if (!result) return;
    if (result.then) { result.then(GW.report); return; }
    GW.toast(result.message, result.ok ? "ok" : "err");
  };

  /* ---------- dismiss 栈：点外部 / Esc 只关最上层 ---------- */
  const dismissStack = [];
  document.addEventListener("pointerdown", (e) => {
    const top = dismissStack[dismissStack.length - 1];
    if (top && !top.node.contains(e.target) && !(top.anchor && top.anchor.contains(e.target))) top.close();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const top = dismissStack[dismissStack.length - 1];
    if (top) { e.stopPropagation(); top.close(); }
  }, true);
  function trackDismiss(node, anchor, onClose) {
    const rec = { node, anchor, close: () => { unlink(); onClose(); } };
    function unlink() {
      const i = dismissStack.indexOf(rec);
      if (i >= 0) dismissStack.splice(i, 1);
    }
    dismissStack.push(rec);
    return rec;
  }

  /* ---------- 弹出菜单 ---------- */
  GW.menu = function (anchor, items) {
    const m = GW.el("div", "menu");
    const rec = trackDismiss(m, anchor, () => m.remove());
    items.forEach((it) => {
      if (it.sep) { m.append(GW.el("div", "menu-sep")); return; }
      const row = GW.btn("menu-item" + (it.tone ? " tone-" + it.tone : ""), null, () => { rec.close(); it.onClick(); });
      if (it.disabled) { row.disabled = true; row.onclick = null; }
      row.innerHTML = (it.icon ? GW.icon(it.icon, 14) : '<span class="ic-pad"></span>') + "<span>" + it.label + "</span>" + (it.hint ? '<em>' + it.hint + "</em>" : "");
      m.append(row);
    });
    document.body.append(m);
    const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.min(r.left, window.innerWidth - mw - 8) + "px";
    m.style.top = (r.bottom + mh + 8 > window.innerHeight ? r.top - mh - 4 : r.bottom + 4) + "px";
  };

  /* ---------- 模态 ---------- */
  GW.modal = function (opts) {
    const backdrop = GW.el("div", "modal-backdrop");
    const box = GW.el("div", "modal" + (opts.wide ? " modal-wide" : ""));
    const rec = trackDismiss(box, null, () => backdrop.remove());
    const head = GW.el("header", "modal-head", GW.el("b", null, opts.title));
    const closeBtn = GW.btn("icon-btn", null, rec.close);
    closeBtn.innerHTML = GW.icon("x", 14);
    head.append(closeBtn);
    box.append(head);
    if (opts.body) box.append(opts.body);
    if (opts.actions) {
      const foot = GW.el("footer", "modal-foot");
      opts.actions.forEach((a) => foot.append(a));
      box.append(foot);
    }
    backdrop.append(box);
    document.body.append(backdrop);
    return { close: rec.close, box };
  };

  /* ---------- 分级确认 ----------
     normal：普通确认；danger：红色说明后果；grave：还得抄一遍目标名才放行。
     所有危险档都写明「自动快照，可在操作日志撤销」——安全网先亮出来。 */
  GW.confirmDialog = function (opts) {
    return new Promise((resolve) => {
      const body = GW.el("div", "confirm-body");
      if (opts.tone && opts.tone !== "normal") {
        body.append(GW.html("div", "confirm-warn tone-" + opts.tone,
          GW.icon("warn", 14) + "<span>" + (opts.warn || "此操作有破坏性") + "</span>"));
      }
      body.append(GW.el("p", "confirm-text", opts.body || ""));
      if (opts.safety !== false && opts.tone && opts.tone !== "normal") {
        body.append(GW.html("p", "confirm-safety", GW.icon("undo", 13) + "<span>执行前会自动留仓库快照，可在「操作日志」一键撤销。</span>"));
      }
      let typedInput = null;
      if (opts.typed) {
        body.append(GW.el("p", "confirm-typed-tip", ["确认请输入：", GW.el("code", null, opts.typed)]));
        typedInput = GW.el("input", "ui-input");
        typedInput.placeholder = opts.typed;
        body.append(typedInput);
      }
      const cancel = GW.btn("ui-btn", "取消", () => { m.close(); resolve(false); });
      const okBtn = GW.btn("ui-btn primary" + (opts.tone === "danger" || opts.tone === "grave" ? " danger" : ""),
        opts.confirmText || "确认", () => { m.close(); resolve(true); });
      if (opts.typed) {
        okBtn.disabled = true;
        typedInput.addEventListener("input", () => { okBtn.disabled = typedInput.value.trim() !== opts.typed; });
      }
      const m = GW.modal({ title: opts.title, body, actions: [cancel, okBtn] });
      if (typedInput) typedInput.focus();
    });
  };

  /* ---------- 时间 ---------- */
  GW.timeAgo = function (ts) {
    const d = Date.now() - ts;
    if (d < 90 * 1000) return "刚刚";
    if (d < 3600 * 1000) return Math.round(d / 60000) + " 分钟前";
    if (d < 86400 * 1000) return Math.round(d / 3600000) + " 小时前";
    return Math.round(d / 86400000) + " 天前";
  };

  /* ---------- diff 渲染 ----------
     opts.hunkActions(hunk) → [{label, icon, tone, onClick}]；
     opts.lineStage(hunk, lineIdx[]) 存在时，改动行可点选、浮出「暂存所选行」。 */
  function parseStart(header) {
    const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header || "");
    return m ? { old: +m[1], neu: +m[2] } : { old: 1, neu: 1 };
  }
  GW.renderDiff = function (hunks, opts) {
    opts = opts || {};
    const wrap = GW.el("div", "diff");
    hunks.forEach((h) => {
      const hunkEl = GW.el("div", "diff-hunk");
      const head = GW.el("div", "diff-hunk-head");
      head.append(GW.el("code", "diff-hunk-header", h.header));
      const btns = GW.el("div", "diff-hunk-actions");
      const picked = new Set();
      let pickBtn = null;
      (opts.hunkActions ? opts.hunkActions(h) : []).forEach((a) => {
        const b = GW.btn("mini-btn" + (a.tone ? " tone-" + a.tone : ""), null, a.onClick);
        b.innerHTML = (a.icon ? GW.icon(a.icon, 12) : "") + "<span>" + a.label + "</span>";
        btns.append(b);
      });
      if (opts.lineStage) {
        pickBtn = GW.btn("mini-btn tone-accent is-hidden", null, () => {
          opts.lineStage(h, [...picked].sort((a, b) => a - b));
        });
        btns.append(pickBtn);
      }
      head.append(btns);
      hunkEl.append(head);

      const table = GW.el("div", "diff-lines");
      const start = parseStart(h.header);
      let oldNo = start.old, newNo = start.neu;
      h.lines.forEach((line, li) => {
        const row = GW.el("div", "diff-line t-" + line.t);
        const noOld = GW.el("span", "diff-no", line.t === "add" ? "" : String(oldNo++));
        const noNew = GW.el("span", "diff-no", line.t === "del" ? "" : String(newNo++));
        const sign = GW.el("span", "diff-sign", line.t === "add" ? "+" : line.t === "del" ? "−" : " ");
        row.append(noOld, noNew, sign, GW.el("span", "diff-code", line.s || " "));
        if (opts.lineStage && line.t !== "ctx") {
          row.classList.add("is-pickable");
          row.addEventListener("click", () => {
            if (picked.has(li)) { picked.delete(li); row.classList.remove("is-picked"); }
            else { picked.add(li); row.classList.add("is-picked"); }
            pickBtn.classList.toggle("is-hidden", !picked.size);
            pickBtn.innerHTML = GW.icon("plus", 12) + "<span>暂存所选 " + picked.size + " 行</span>";
          });
        }
        table.append(row);
      });
      hunkEl.append(table);
      wrap.append(hunkEl);
    });
    return wrap;
  };

  /* ---------- 小组件 ---------- */
  GW.kindBadge = function (kind) {
    return GW.el("span", "kind-badge kind-" + kind, kind);
  };
  GW.statLabel = function (add, del) {
    const s = GW.el("span", "stat");
    if (add) s.append(GW.el("i", "stat-add", "+" + add));
    if (del) s.append(GW.el("i", "stat-del", "−" + del));
    return s;
  };
  GW.copySha = function (sha) {
    navigator.clipboard && navigator.clipboard.writeText(sha);
    GW.toast("已复制 " + sha, "ok");
  };
})();
