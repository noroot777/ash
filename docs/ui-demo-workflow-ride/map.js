/* 线路图渲染 —— 三行：名牌 / 线上的站点 / 站台底下的参数与状态。
   支线（失败后往回拐）画在站台下方，跨度小的靠内。 */
(function (global) {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;
  var rail = document.getElementById("rail");
  var COL_STN = "minmax(158px,1fr)", COL_GAP = "44px";

  function tone(hue) { return "color-mix(in srgb," + hue + " 72%,#2a2118)"; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function failText(step) {
    var f = step.fail;
    if (f.mode === "stop") return "停下等人";
    if (f.mode === "ask") return "问我一句再决定";
    var j = WF.indexOf(f.backTo);
    return "拐回第 " + (j + 1) + " 站 · 最多 " + f.max + " 轮";
  }

  function render() {
    var n = S.steps.length;
    if (!n) {
      rail.removeAttribute("style");
      rail.innerHTML = '<div class="empty">这条线上还没有站。' +
        '<button class="ins solo" data-ins="0">＋ 加第一站</button></div>';
      return;
    }
    var cols = [], h = ['<svg class="arcs" id="arcs"></svg>', '<div class="car" id="car" hidden><b></b></div>'];
    for (var i = 0; i < n; i++) cols.push(COL_GAP, COL_STN);
    cols.push(COL_GAP);
    rail.setAttribute("style", "grid-template-columns:" + cols.join(" "));

    h.push(gapCol(0, null, S.steps[0]));
    S.steps.forEach(function (s, i) {
      h.push(stnCol(s, i));
      h.push(gapCol(i + 1, s, S.steps[i + 1] || null));
    });
    rail.innerHTML = h.join("");
    requestAnimationFrame(drawArcs);
  }

  function gapCol(at, prev, next) {
    var a = prev ? tone(K[prev.kind].hue) : "transparent";
    var b = next ? tone(K[next.kind].hue) : "transparent";
    return '<div class="pad"></div>' +
      '<div class="segw" style="--flow:linear-gradient(90deg,' + a + "," + b + ')">' +
        '<div class="seg"></div><button class="ins" data-ins="' + at + '">＋</button>' +
      '</div><div class="pad"></div>';
  }

  function stnCol(s, i) {
    var k = K[s.kind], t = tone(k.hue), st = WFSIM.STATUS[s.kind];
    var h = ['<div class="plate" data-stn="' + s.id + '" style="--tone:' + t + '">' +
      '<div class="ops">' +
        '<button data-op="left" data-id="' + s.id + '" title="往前挪">←</button>' +
        '<button data-op="right" data-id="' + s.id + '" title="往后挪">→</button>' +
        '<button data-op="del" data-id="' + s.id + '" title="拆掉这一站">✕</button>' +
      "</div>" +
      '<span class="code">' + k.code + "</span>" +
      "<h2>" + esc(k.title(s.p)) + "</h2>" +
      '<span class="tag">' + k.tag + "</span></div>"];

    h.push('<div class="node" data-stn="' + s.id + '" data-node="' + s.id + '" style="--tone:' + t + '">' +
      "<i>" + pad(i + 1) + "</i></div>");

    h.push('<div class="body" data-stn="' + s.id + '" style="--tone:' + t + '">' +
      '<div class="st">任务显示 <b>' + esc(st.text) + "</b></div>" +
      chips(s, k) +
      (s.fail ? '<button class="failchip" data-edit="' + s.id + '" data-field="fail">' +
        "失败 → " + esc(failText(s)) + "</button>" : "") +
      "</div>");
    return h.join("");
  }

  function chips(s, k) {
    var out = [];
    k.fields.forEach(function (f) {
      var v = s.p[f.key];
      if (f.type === "checks") {
        out.push(chip(s.id, f.key, v.length ? "验 " + v.length + " 项：" + v.join("、") : "还没选验什么", !v.length));
      } else out.push(chip(s.id, f.key, v));
    });
    return out.join("");
  }
  function chip(id, field, text, warn) {
    return '<button class="chip' + (warn ? " warn" : "") + '" data-edit="' + id + '" data-field="' + field +
      '" title="' + esc(text) + '">' + esc(text) + "</button>";
  }

  // ── 支线 ────────────────────────────────────────────────────────────
  function loops() {
    var out = [];
    S.steps.forEach(function (s, i) {
      if (!s.fail || s.fail.mode !== "back") return;
      var j = WF.indexOf(s.fail.backTo);
      if (j < 0 || j >= i) return;
      out.push({ s: s, span: i - j });
    });
    return out.sort(function (a, b) { return a.span - b.span; });
  }

  function drawArcs() {
    var svg = document.getElementById("arcs");
    if (!svg) return;
    var base = rail.getBoundingClientRect(), ls = loops();
    rail.style.paddingBottom = (24 + ls.length * 18) + "px";

    var h = ['<defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" ' +
      'orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#9a6c12"/></marker></defs>'];
    var bottom = rail.getBoundingClientRect().height;
    ls.forEach(function (L, lane) {
      var p = arcPath(L, bottom, lane);
      if (!p) return;
      h.push('<path id="arc-' + L.s.id + '" d="' + p.d + '" fill="none" stroke="#9a6c12" stroke-width="1.2" ' +
        'stroke-opacity="' + (0.6 - lane * 0.12) + '" stroke-dasharray="3 3" marker-end="url(#ar)"/>');
      h.push('<text x="' + p.mx + '" y="' + (p.lv - 6) + '" text-anchor="middle" ' +
        'font-family="SF Mono,ui-monospace,monospace" font-size="9.5" fill="#9a6c12" fill-opacity=".75">' +
        "失败重来 ×" + L.s.fail.max + "</text>");
    });
    svg.innerHTML = h.join("");
  }

  function arcPath(L, bottom, lane) {
    var a = rail.querySelector('[data-node="' + L.s.fail.backTo + '"]');
    var b = rail.querySelector('[data-node="' + L.s.id + '"]');
    if (!a || !b) return null;
    var base = rail.getBoundingClientRect();
    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    var xT = ra.left - base.left + ra.width / 2;
    var xF = rb.left - base.left + rb.width / 2;
    var y = rb.top - base.top + rb.height / 2;
    var lv = bottom - 16 - lane * 18, r = 10;
    return {
      d: "M" + xF + " " + (y + 12) + " V" + (lv - r) + " Q" + xF + " " + lv + " " + (xF - r) + " " + lv +
        " H" + (xT + r) + " Q" + xT + " " + lv + " " + xT + " " + (lv - r) + " V" + (y + 15),
      mx: (xF + xT) / 2, lv: lv,
    };
  }

  function center(id) {
    var el = rail.querySelector('[data-node="' + id + '"]');
    if (!el) return null;
    var base = rail.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 };
  }

  global.WFMAP = {
    render: render, drawArcs: drawArcs, center: center, tone: tone, pad: pad, failText: failText,
    rail: rail,
  };
})(window);
