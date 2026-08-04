/* 线路图壳子 —— 定义层来自 ../ui-demo-workflow-kit/model.js */
(function () {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;
  var rail = document.getElementById("rail");
  var checkBox = document.getElementById("check");
  var popBox = document.getElementById("pop");
  var tplBox = document.getElementById("tpls");
  var wsBox = document.getElementById("ws");
  var digestBox = document.getElementById("digest");
  var pop = null, current = "frontend";
  // 站列可伸缩：站少时铺满整块板，站多了才横向滚
  var COL_STN = "minmax(150px,1fr)", COL_GAP = "40px";

  // 纸底上直接用霓虹色太飘，压暗一档
  function tone(hue) { return "color-mix(in srgb," + hue + " 72%,#2a2118)"; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function failText(step) {
    var f = step.fail;
    if (f.mode === "stop") return "停下等人";
    if (f.mode === "ask") return "问我一句再决定";
    return "拐回第 " + (WF.indexOf(f.backTo) + 1) + " 站 · 最多 " + f.max + " 轮";
  }

  // ── 线路图 ──────────────────────────────────────────────────────────
  function renderRail() {
    var n = S.steps.length;
    if (!n) {
      rail.removeAttribute("style");
      rail.innerHTML = '<div class="empty">这条线上还没有站。' +
        '<button class="chip" data-ins="0" style="margin-left:6px">＋ 加第一站</button></div>';
      return;
    }
    var cols = [], h = ['<svg class="arcs" id="arcs"></svg>'];
    for (var i = 0; i < n; i++) { cols.push(COL_GAP, COL_STN); }
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
    return "<div></div>" +
      '<div class="segw" style="--flow:linear-gradient(90deg,' + a + "," + b + ')">' +
        '<div class="seg"></div><button class="ins" data-ins="' + at + '"><span>＋</span><i>加一站</i></button>' +
      "</div><div></div>";
  }

  function stnCol(s, i) {
    var k = K[s.kind], t = tone(k.hue);
    var h = ['<div class="plate" style="--tone:' + t + '">' +
      '<span class="code">' + k.code + "</span>" +
      "<h2>" + esc(k.title(s.p)) + "</h2>" +
      '<span class="tag">' + k.tag + "</span>" +
      '<div class="ops">' +
        '<button data-op="left" data-id="' + s.id + '" title="往前挪">←</button>' +
        '<button data-op="right" data-id="' + s.id + '" title="往后挪">→</button>' +
        '<button data-op="del" data-id="' + s.id + '" title="拆掉这一站">×</button>' +
      "</div></div>"];
    h.push('<div class="node" data-node="' + s.id + '" style="--tone:' + t + '"><i>' + pad(i + 1) + "</i></div>");
    h.push('<div class="body" style="--tone:' + t + '">' + chips(s, k) +
      (s.fail ? '<div class="fail">失败<br><button class="go" data-edit="' + s.id +
        '" data-field="fail">' + esc(failText(s)) + "</button></div>" : "") + "</div>");
    return h.join("");
  }

  function chips(s, k) {
    var out = [];
    k.fields.forEach(function (f) {
      var v = s.p[f.key];
      if (f.type === "checks") {
        if (!v.length) out.push(chip(s.id, f.key, "还没选验什么"));
        else v.forEach(function (o) { out.push(chip(s.id, f.key, o)); });
      } else out.push(chip(s.id, f.key, v));
    });
    return out.join("");
  }
  function chip(id, field, text) {
    return '<button class="chip" data-edit="' + id + '" data-field="' + field + '" title="' + esc(text) + '">' +
      esc(text) + "</button>";
  }

  // 支线：失败后往回拐的那几段，画在站台下方，按跨度分层
  function drawArcs() {
    var svg = document.getElementById("arcs");
    if (!svg) return;
    var base = rail.getBoundingClientRect(), loops = [];
    S.steps.forEach(function (s, i) {
      if (!s.fail || s.fail.mode !== "back") return;
      var j = WF.indexOf(s.fail.backTo);
      if (j < 0 || j >= i) return;
      loops.push({ s: s, span: i - j });
    });
    loops.sort(function (a, b) { return a.span - b.span; });
    rail.style.paddingBottom = (22 + loops.length * 17) + "px";

    var h = ['<defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" ' +
      'orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#9a6c12"/></marker></defs>'];
    var bottom = rail.getBoundingClientRect().height;
    loops.forEach(function (L, lane) {
      var a = rail.querySelector('[data-node="' + L.s.fail.backTo + '"]');
      var b = rail.querySelector('[data-node="' + L.s.id + '"]');
      if (!a || !b) return;
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var xT = ra.left - base.left + ra.width / 2;
      var xF = rb.left - base.left + rb.width / 2;
      var y = rb.top - base.top + rb.height / 2;
      var lv = bottom - 16 - lane * 17, r = 10;
      h.push('<path d="M' + xF + " " + (y + 12) + " V" + (lv - r) + " Q" + xF + " " + lv + " " +
        (xF - r) + " " + lv + " H" + (xT + r) + " Q" + xT + " " + lv + " " + xT + " " + (lv - r) +
        " V" + (y + 15) + '" fill="none" stroke="#9a6c12" stroke-width="1.2" stroke-opacity="' +
        (0.6 - lane * 0.12) + '" stroke-dasharray="3 3" marker-end="url(#ar)"/>');
      h.push('<text x="' + ((xF + xT) / 2) + '" y="' + (lv - 6) + '" text-anchor="middle" ' +
        'font-family="SF Mono,ui-monospace,monospace" font-size="9.5" fill="#9a6c12" fill-opacity=".75">失败重来 ×' +
        L.s.fail.max + "</text>");
    });
    svg.innerHTML = h.join("");
  }

  // ── 顶栏与检查 ──────────────────────────────────────────────────────
  function renderTpls() {
    tplBox.innerHTML = Object.keys(WF.TEMPLATES).map(function (key) {
      return '<button data-tpl="' + key + '" data-on="' + (key === current) + '">' +
        esc(WF.TEMPLATES[key].name) + "</button>";
    }).join("");
    wsBox.innerHTML =
      '<button data-ws="isolated" data-on="' + (S.workspace === "isolated") + '">独立 worktree</button>' +
      '<button data-ws="shared" data-on="' + (S.workspace === "shared") + '">项目目录</button>';
    digestBox.textContent = WF.digest();
  }

  function renderCheck() {
    var r = WF.compile();
    var h = ['<div class="in"><div class="chd"><span class="led' + (r.denied ? " bad" : "") + '"></span><b>' +
      (r.denied ? "这条线存不下去" : "这条线可以保存") + "</b><span>" +
      S.steps.length + " 站 · " + (S.workspace === "isolated" ? "独立 worktree" : "项目目录") + "</span></div>"];
    r.rows.forEach(function (row) {
      var tag = row[0] === "deny" ? "DENY" : row[0] === "warn" ? "WARN" : "PASS";
      h.push('<div class="line ' + row[0] + '"><em>' + tag + "</em><span>" + esc(row[1]) + "</span></div>");
    });
    checkBox.innerHTML = h.join("") + "</div>";
    checkBox.setAttribute("data-bad", String(r.denied));
  }

  function render() { renderTpls(); renderRail(); renderCheck(); }

  // ── 浮层 ────────────────────────────────────────────────────────────
  function place(anchor) {
    var r = anchor.getBoundingClientRect(), w = 302, h = 470;
    var x = Math.max(14, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 14));
    var y = r.bottom + 8;
    if (y + h > window.innerHeight - 14) y = Math.max(14, Math.min(r.top - 8 - h, window.innerHeight - h - 14));
    return { x: x, y: y };
  }
  function closePop() { pop = null; popBox.hidden = true; popBox.innerHTML = ""; }
  function drawPop() {
    if (!pop) return closePop();
    popBox.hidden = false;
    popBox.style.left = pop.pos.x + "px";
    popBox.style.top = pop.pos.y + "px";
    popBox.innerHTML = '<div class="inner">' + (pop.kind === "menu" ? menuHtml() : paramsHtml()) + "</div>";
  }

  function menuHtml() {
    return "<h3>在这一段上加一站</h3>" + Object.keys(K).map(function (kind) {
      var k = K[kind];
      return '<button class="kind" data-add="' + kind + '" style="--tone:' + tone(k.hue) + '">' +
        '<span class="code">' + k.code + "</span><b>" + esc(k.label) + "</b><span>" + k.tag + "</span></button>";
    }).join("");
  }

  function paramsHtml() {
    var s = WF.get(pop.stepId);
    if (!s) return "";
    var k = K[s.kind], i = WF.indexOf(s.id);
    var h = ["<h3>第 " + (i + 1) + " 站 · " + esc(k.label) + "</h3>"];
    k.fields.forEach(function (f) { h.push(fieldHtml(s, f, pop.field === f.key)); });
    if (s.fail) h.push(failHtml(s, i, pop.field === "fail"));
    h.push('<div class="foot"><button data-op="del" data-id="' + s.id + '">拆掉这一站</button>' +
      '<button class="done" data-close="1">完成</button></div>');
    return h.join("");
  }

  function fieldHtml(s, f, hot) {
    var v = s.p[f.key];
    var h = ['<div class="row' + (hot ? " hot" : "") + '"><div class="lab">' + esc(f.label) + "</div>"];
    if (f.type === "select") {
      h.push('<select data-set="' + f.key + '" data-id="' + s.id + '">' + f.options.map(function (o) {
        return "<option" + (o === v ? " selected" : "") + ">" + esc(o) + "</option>";
      }).join("") + "</select>");
    } else if (f.type === "seg") {
      h.push('<div class="seg">' + f.options.map(function (o) {
        return '<button data-set="' + f.key + '" data-id="' + s.id + '" data-val="' + esc(o) +
          '" data-on="' + (o === v) + '">' + esc(o) + "</button>";
      }).join("") + "</div>");
    } else {
      h.push(f.options.map(function (o) {
        return '<div class="opt" data-check="' + esc(o) + '" data-id="' + s.id + '" data-on="' +
          (v.indexOf(o) >= 0) + '"><i>✓</i>' + esc(o) + "</div>";
      }).join(""));
    }
    return h.join("") + "</div>";
  }

  function failHtml(s, i, hot) {
    var f = s.fail;
    var h = ['<div class="row' + (hot ? " hot" : "") + '"><div class="lab">这一站失败了，车往哪开</div><div class="seg">'];
    WF.FAIL_MODES.forEach(function (m) {
      h.push('<button data-fail="mode" data-id="' + s.id + '" data-val="' + m[0] +
        '" data-on="' + (f.mode === m[0]) + '">' + m[1] + "</button>");
    });
    h.push("</div></div>");
    if (f.mode === "back") {
      h.push('<div class="row"><div class="lab">拐回哪一站</div><select data-fail="backTo" data-id="' + s.id + '">');
      S.steps.slice(0, i).forEach(function (t, j) {
        h.push('<option value="' + t.id + '"' + (t.id === f.backTo ? " selected" : "") + ">第 " +
          (j + 1) + " 站 · " + esc(K[t.kind].label) + "</option>");
      });
      if (i === 0) h.push('<option value="">（前面没有站可回）</option>');
      h.push('</select></div><div class="row"><div class="lab">最多重来几轮</div><div class="seg">' +
        [1, 2, 3].map(function (nn) {
          return '<button data-fail="max" data-id="' + s.id + '" data-val="' + nn +
            '" data-on="' + (f.max === nn) + '">' + nn + " 轮</button>";
        }).join("") + "</div></div>");
    }
    return h.join("");
  }

  // ── 事件 ────────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-tpl],[data-ws],[data-ins],[data-add],[data-op],[data-close]," +
      "[data-set],[data-check],[data-fail],[data-edit]");
    if (!t) { if (!popBox.contains(e.target)) closePop(); return; }
    var d = t.dataset;

    if (d.tpl) { current = d.tpl; WF.loadTemplate(d.tpl); closePop(); render(); return; }
    if (d.ws) { S.workspace = d.ws; render(); return; }
    if (d.close) { closePop(); return; }
    if (d.ins) { pop = { kind: "menu", at: Number(d.ins), pos: place(t) }; drawPop(); return; }
    if (d.add) {
      var made = WF.insert(d.add, pop ? pop.at : null);
      closePop(); render();
      requestAnimationFrame(function () {
        var el = rail.querySelector('[data-node="' + made.id + '"]');
        if (el) { pop = { kind: "params", stepId: made.id, pos: place(el) }; drawPop(); }
      });
      return;
    }
    if (d.op) {
      if (d.op === "del") { WF.remove(d.id); if (pop && pop.stepId === d.id) closePop(); }
      if (d.op === "left") WF.move(d.id, -1);
      if (d.op === "right") WF.move(d.id, 1);
      render(); if (pop) drawPop();
      return;
    }
    if (d.set !== undefined && t.tagName === "BUTTON") { WF.get(d.id).p[d.set] = d.val; render(); drawPop(); return; }
    if (d.check !== undefined) {
      var arr = WF.get(d.id).p.checks, at = arr.indexOf(d.check);
      if (at >= 0) arr.splice(at, 1); else arr.push(d.check);
      render(); drawPop(); return;
    }
    // 下拉走 change；这里只认按钮，否则点开原生下拉会被重绘关掉
    if (d.fail && t.tagName === "BUTTON") {
      var f = WF.get(d.id).fail;
      if (d.fail === "mode") {
        f.mode = d.val;
        if (f.mode === "back" && !f.backTo) {
          var idx = WF.indexOf(d.id), pick = null;
          S.steps.slice(0, idx).forEach(function (s) { if (s.kind === "run") pick = s.id; });
          f.backTo = pick || (idx > 0 ? S.steps[0].id : null);
        }
      }
      if (d.fail === "max") f.max = Number(d.val);
      render(); drawPop(); return;
    }
    if (d.edit) { pop = { kind: "params", stepId: d.edit, field: d.field, pos: place(t) }; drawPop(); return; }
  });

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.tagName !== "SELECT") return;
    if (t.dataset.set !== undefined) WF.get(t.dataset.id).p[t.dataset.set] = t.value;
    else if (t.dataset.fail === "backTo") WF.get(t.dataset.id).fail.backTo = t.value;
    render(); drawPop();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });
  window.addEventListener("resize", drawArcs);

  WF.loadTemplate(current);
  render();
})();
