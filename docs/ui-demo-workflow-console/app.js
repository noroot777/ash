/* 调度台壳子 —— 定义层来自 ../ui-demo-workflow-kit/model.js */
(function () {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;
  var pop = null;
  var rack = document.getElementById("rack");
  var meter = document.getElementById("meter");
  var consoleBox = document.getElementById("console");
  var popBox = document.getElementById("pop");
  var tplBox = document.getElementById("tpls");
  var current = "frontend";

  function failText(step) {
    var f = step.fail;
    if (!f) return "";
    if (f.mode === "stop") return "停下等人";
    if (f.mode === "ask") return "问我一句再决定";
    return "回到第 " + (WF.indexOf(f.backTo) + 1) + " 关重做 · 最多 " + f.max + " 轮";
  }

  // ── 机架 ────────────────────────────────────────────────────────────
  function renderRack() {
    var h = ['<div class="spine"></div><svg class="loops" id="loops"></svg>', slot(0)];
    S.steps.forEach(function (s, i) {
      var k = K[s.kind];
      h.push('<div class="mod" data-mod="' + s.id + '" style="--hue:' + k.hue +
        ";animation-delay:" + (i * 55) + 'ms">' +
        '<div class="dot">' + pad(i + 1) + "</div>" +
        '<div class="core">' +
          '<div class="hd">' +
            '<span class="code">' + k.code + "</span>" +
            "<h2>" + esc(k.title(s.p)) + "</h2>" +
            '<span class="tag">' + k.tag + "</span>" +
            '<div class="ops">' +
              '<button data-op="up" data-id="' + s.id + '" title="上移">↑</button>' +
              '<button data-op="down" data-id="' + s.id + '" title="下移">↓</button>' +
              '<button data-op="del" data-id="' + s.id + '" title="删掉这一关">×</button>' +
            "</div>" +
          "</div>" +
          '<div class="chips">' + chips(s, k) + "</div>" +
          (s.fail ? '<div class="fail">失败 →<button class="go" data-edit="' + s.id +
            '" data-field="fail">' + esc(failText(s)) + "</button></div>" : "") +
        "</div></div>");
      h.push(slot(i + 1));
    });
    rack.innerHTML = h.join("");
    requestAnimationFrame(drawLoops);
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function slot(at) {
    return '<div class="slot"><button data-ins="' + at + '">＋ 插一关</button></div>';
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
    return '<button class="chip" data-edit="' + id + '" data-field="' + field + '">' + esc(text) + "</button>";
  }

  // 回路：从失败的那一关，沿轨道左侧绕回上游那一关。多条按跨度排道。
  function drawLoops() {
    var svg = document.getElementById("loops");
    if (!svg) return;
    var spine = rack.querySelector(".spine");
    var sx = spine ? spine.offsetLeft : 52;      // 轨道的 x，回路都挂在它左边
    var base = rack.getBoundingClientRect(), loops = [];
    S.steps.forEach(function (s, i) {
      if (!s.fail || s.fail.mode !== "back") return;
      var j = WF.indexOf(s.fail.backTo);
      if (j < 0 || j >= i) return;
      loops.push({ s: s, span: i - j });
    });
    loops.sort(function (a, b) { return a.span - b.span; });
    var h = ['<defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" ' +
      'orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#f0b429"/></marker></defs>'];
    loops.forEach(function (L, lane) {
      var a = document.querySelector('[data-mod="' + L.s.fail.backTo + '"]');
      var b = document.querySelector('[data-mod="' + L.s.id + '"]');
      if (!a || !b) return;
      var yT = a.getBoundingClientRect().top - base.top + 33;
      var yF = b.getBoundingClientRect().top - base.top + 33;
      var x = sx - 28 - lane * 11, r = 9;
      h.push('<path d="M' + (sx - 15) + " " + yF + " H" + (x + r) + " Q" + x + " " + yF + " " + x + " " + (yF - r) +
        " V" + (yT + r) + " Q" + x + " " + yT + " " + (x + r) + " " + yT + " H" + (sx - 19) + '" ' +
        'fill="none" stroke="#f0b429" stroke-width="1.1" stroke-opacity="' + (0.62 - lane * 0.14) +
        '" stroke-dasharray="3 3" marker-end="url(#ar)"/>');
    });
    svg.innerHTML = h.join("");
    svg.setAttribute("style", "filter:drop-shadow(0 0 6px rgba(240,180,41,.45))");
  }

  // ── 概览 ────────────────────────────────────────────────────────────
  function renderMeter() {
    var loops = S.steps.filter(function (s) { return s.fail && s.fail.mode === "back"; }).length;
    var gates = S.steps.filter(function (s) { return s.kind === "human"; }).length;
    meter.innerHTML =
      stat(S.steps.length, "GATES 关卡") +
      stat(loops, "LOOPS 回路") +
      stat(gates || "—", "HUMAN 人工把关") +
      '<div class="stat"><div class="core">' +
        '<div class="seg" style="margin-bottom:5px">' +
          '<button data-ws="isolated" data-on="' + (S.workspace === "isolated") + '">独立 worktree</button>' +
          '<button data-ws="shared" data-on="' + (S.workspace === "shared") + '">项目目录</button>' +
        "</div><i>WORKSPACE 工作区</i></div></div>";
  }
  function stat(n, label) {
    return '<div class="stat"><div class="core"><b>' + n + "</b><i>" + label + "</i></div></div>";
  }

  // ── 编译输出 ────────────────────────────────────────────────────────
  function renderConsole() {
    var r = WF.compile();
    var h = ['<div class="core"><div class="chd"><span class="led' + (r.denied ? " bad" : "") + '"></span><b>' +
      (r.denied ? "这样存不下去" : "可以保存") + '</b><span class="path">' + esc(WF.digest()) + "</span></div>"];
    r.rows.forEach(function (row) {
      var tag = row[0] === "deny" ? "DENY" : row[0] === "warn" ? "WARN" : "PASS";
      h.push('<div class="line ' + row[0] + '"><em>' + tag + "</em><span>" + esc(row[1]) + "</span></div>");
    });
    consoleBox.innerHTML = h.join("") + "</div>";
    consoleBox.setAttribute("data-bad", String(r.denied));
  }

  function renderTpls() {
    tplBox.innerHTML = Object.keys(WF.TEMPLATES).map(function (key) {
      return '<button class="tpl" data-tpl="' + key + '" data-on="' + (key === current) + '">' +
        esc(WF.TEMPLATES[key].name) + "</button>";
    }).join("");
  }

  function render() { renderTpls(); renderMeter(); renderRack(); renderConsole(); }

  // ── 弹层 ────────────────────────────────────────────────────────────
  function place(anchor) {
    var r = anchor.getBoundingClientRect(), w = 302, h = 470;
    var x = Math.max(14, Math.min(r.left, window.innerWidth - w - 14));
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
  function openMenu(anchor, at) { pop = { kind: "menu", at: at, pos: place(anchor) }; drawPop(); }
  function openParams(anchor, id, field) { pop = { kind: "params", stepId: id, field: field, pos: place(anchor) }; drawPop(); }

  function menuHtml() {
    return "<h3>插入一关</h3>" + Object.keys(K).map(function (kind) {
      var k = K[kind];
      return '<button class="kind" data-add="' + kind + '" style="--hue:' + k.hue + '">' +
        '<span class="code">' + k.code + "</span><b>" + esc(k.label) + "</b><span>" + k.tag + "</span></button>";
    }).join("");
  }

  function paramsHtml() {
    var s = WF.get(pop.stepId);
    if (!s) return "";
    var k = K[s.kind], i = WF.indexOf(s.id);
    var h = ["<h3>" + pad(i + 1) + " · " + esc(k.label) + "</h3>"];
    k.fields.forEach(function (f) { h.push(fieldHtml(s, f, pop.field === f.key)); });
    if (s.fail) h.push(failHtml(s, i, pop.field === "fail"));
    h.push('<div class="foot"><button data-op="del" data-id="' + s.id + '">删掉这一关</button>' +
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
    var h = ['<div class="row' + (hot ? " hot" : "") + '"><div class="lab">这一关失败了怎么办</div><div class="seg">'];
    WF.FAIL_MODES.forEach(function (m) {
      h.push('<button data-fail="mode" data-id="' + s.id + '" data-val="' + m[0] +
        '" data-on="' + (f.mode === m[0]) + '">' + m[1] + "</button>");
    });
    h.push("</div></div>");
    if (f.mode === "back") {
      h.push('<div class="row"><div class="lab">回到哪一关</div><select data-fail="backTo" data-id="' + s.id + '">');
      S.steps.slice(0, i).forEach(function (t, j) {
        h.push('<option value="' + t.id + '"' + (t.id === f.backTo ? " selected" : "") + ">" +
          pad(j + 1) + " · " + esc(K[t.kind].label) + "</option>");
      });
      if (i === 0) h.push('<option value="">（前面没有关卡可回）</option>');
      h.push("</select></div><div class=\"row\"><div class=\"lab\">最多重来几轮</div><div class=\"seg\">" +
        [1, 2, 3].map(function (n) {
          return '<button data-fail="max" data-id="' + s.id + '" data-val="' + n +
            '" data-on="' + (f.max === n) + '">' + n + " 轮</button>";
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
    if (d.ins) { openMenu(t, Number(d.ins)); return; }
    if (d.add) {
      var made = WF.insert(d.add, pop ? pop.at : null);
      closePop(); render();
      requestAnimationFrame(function () {
        var el = document.querySelector('[data-mod="' + made.id + '"] .chip');
        if (el) openParams(el, made.id);
      });
      return;
    }
    if (d.op) {
      if (d.op === "del") { WF.remove(d.id); if (pop && pop.stepId === d.id) closePop(); }
      if (d.op === "up") WF.move(d.id, -1);
      if (d.op === "down") WF.move(d.id, 1);
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
    if (d.edit) { openParams(t, d.edit, d.field); return; }
  });

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.tagName !== "SELECT") return;
    if (t.dataset.set !== undefined) WF.get(t.dataset.id).p[t.dataset.set] = t.value;
    else if (t.dataset.fail === "backTo") WF.get(t.dataset.id).fail.backTo = t.value;
    render(); drawPop();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });
  window.addEventListener("resize", drawLoops);

  WF.loadTemplate(current);
  render();
})();
