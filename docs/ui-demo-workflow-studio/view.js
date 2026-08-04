/* 渲染层 —— 轨道 / 检查器 / 校验 / 预演时间轴。状态与操作都在 app.js */
(function (global) {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;
  var el = {};

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function failText(s) {
    var f = s.fail;
    if (!f) return "";
    if (f.mode === "stop") return "停下等人";
    if (f.mode === "ask") return "问我一句";
    return "回第 " + (WF.indexOf(f.backTo) + 1) + " 关 ×" + f.max;
  }

  function mount(nodes) { el = nodes; }

  // ── 关口库 ──────────────────────────────────────────────────────────
  function renderLib() {
    el.lib.innerHTML = '<div class="lib-hd">关口库<em>拖进右边，或按 ⌘K 搜名字</em></div>' +
      Object.keys(K).map(function (kind) {
        var k = K[kind];
        return '<button class="libitem" data-lib="' + kind + '" style="--hue:' + k.hue + '">' +
          '<span class="code">' + k.code + "</span><b>" + esc(k.label) + "</b>" +
          '<span class="tag">' + k.tag + "</span></button>";
      }).join("");
  }

  // ── 轨道 ────────────────────────────────────────────────────────────
  function renderRail(sel) {
    if (!S.steps.length) {
      el.rail.innerHTML = '<div class="blank"><b>这条流程还是空的</b>' +
        "<p>从左边拖一张关口卡进来，或者按 <kbd>⌘</kbd><kbd>K</kbd> 搜名字。</p></div>" +
        '<div class="drop" data-at="0"></div>';
      return;
    }
    var h = ['<svg class="loops" id="loops"></svg>', '<div class="drop" data-at="0"></div>'];
    S.steps.forEach(function (s, i) {
      var k = K[s.kind];
      h.push('<article class="step' + (s.id === sel ? " sel" : "") + '" data-id="' + s.id +
        '" data-idx="' + i + '" style="--hue:' + k.hue + '" tabindex="-1">' +
        '<span class="ord">' + pad(i + 1) + "</span>" +
        '<div class="body">' +
          '<div class="ln">' +
            '<span class="code">' + k.code + "</span>" +
            "<h3>" + esc(k.title(s.p)) + "</h3>" +
            '<span class="tag">' + k.tag + "</span>" +
            '<span class="grip" title="按住拖动换顺序">⠿</span>' +
          "</div>" +
          '<div class="sum">' + esc(k.summary(s.p)) + "</div>" +
          (s.fail ? '<div class="fl' + (s.fail.mode === "back" ? " loop" : "") + '">失败 · ' +
            esc(failText(s)) + "</div>" : "") +
        "</div>" +
        (s.fail ? '<span class="knob" title="拖到上游任意一关：失败后回那里重做"></span>' : "") +
        "</article>");
      h.push('<div class="drop" data-at="' + (i + 1) + '"></div>');
    });
    el.rail.innerHTML = h.join("");
    requestAnimationFrame(drawLoops);
  }

  function drawLoops() {
    var svg = el.rail.querySelector(".loops");
    if (!svg) return;
    var base = el.rail.getBoundingClientRect(), loops = [];
    S.steps.forEach(function (s, i) {
      if (!s.fail || s.fail.mode !== "back") return;
      var j = WF.indexOf(s.fail.backTo);
      if (j >= 0 && j < i) loops.push({ s: s, span: i - j });
    });
    loops.sort(function (a, b) { return a.span - b.span; });
    var h = ['<defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" ' +
      'orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#f0b429"/></marker></defs>'];
    loops.forEach(function (L, lane) {
      var a = el.rail.querySelector('.step[data-id="' + L.s.fail.backTo + '"]');
      var b = el.rail.querySelector('.step[data-id="' + L.s.id + '"]');
      if (!a || !b) return;
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var yT = ra.top - base.top + 25, yF = rb.top - base.top + 25;
      var x = 18 - lane * 9, r = 7;          // 回路挂在序号徽章左边，一层一层往外让
      h.push('<path d="M28 ' + yF + " H" + (x + r) + " Q" + x + " " + yF + " " + x + " " + (yF - r) +
        " V" + (yT + r) + " Q" + x + " " + yT + " " + (x + r) + " " + yT + ' H28" fill="none" ' +
        'stroke="#f0b429" stroke-width="1.1" stroke-opacity="' + (0.6 - lane * 0.13) +
        '" stroke-dasharray="3 3" marker-end="url(#ar)"/>');
    });
    svg.innerHTML = h.join("");
  }

  // ── 检查器（常驻，不遮轨道）─────────────────────────────────────────
  function renderInsp(sel) {
    var s = WF.get(sel);
    if (!s) {
      el.insp.innerHTML = '<div class="ins-empty"><b>没选中关口</b>' +
        "<p>点轨道上任意一关，参数在这里改；改完不用关，接着点下一关。</p>" +
        '<div class="keys"><span><kbd>↑</kbd><kbd>↓</kbd>选关</span><span><kbd>⌘</kbd><kbd>↑↓</kbd>挪位置</span>' +
        "<span><kbd>⌫</kbd>删掉</span><span><kbd>⌘</kbd><kbd>K</kbd>加一关</span>" +
        "<span><kbd>⌘</kbd><kbd>Z</kbd>撤销</span><span><kbd>R</kbd>预演</span></div></div>";
      return;
    }
    var k = K[s.kind], i = WF.indexOf(s.id);
    var h = ['<div class="ins-hd" style="--hue:' + k.hue + '"><span class="code">' + k.code + "</span>" +
      "<b>第 " + (i + 1) + " 关 · " + esc(k.label) + "</b>" +
      '<button class="x" data-op="del" data-id="' + s.id + '" title="删掉这一关">×</button></div>'];
    k.fields.forEach(function (f) { h.push(field(s, f)); });
    if (s.fail) h.push(failBlock(s, i));
    el.insp.innerHTML = h.join("");
  }

  function field(s, f) {
    var v = s.p[f.key];
    var h = ['<div class="row"><div class="lab">' + esc(f.label) + "</div>"];
    if (f.type === "select") {
      h.push('<select data-set="' + f.key + '" data-id="' + s.id + '">' + f.options.map(function (o) {
        return "<option" + (o === v ? " selected" : "") + ">" + esc(o) + "</option>";
      }).join("") + "</select>");
    } else if (f.type === "seg") {
      h.push('<div class="seg">' + f.options.map(function (o) {
        return '<button data-set="' + f.key + '" data-id="' + s.id + '" data-val="' + esc(o) +
          '" data-on="' + (o === v) + '">' + esc(o) + "</button>";
      }).join("") + "</div>");
    } else if (f.type === "checks") {
      h.push(f.options.map(function (o) {
        return '<div class="opt" data-check="' + esc(o) + '" data-id="' + s.id + '" data-on="' +
          (v.indexOf(o) >= 0) + '"><i>✓</i>' + esc(o) + "</div>";
      }).join(""));
    } else {
      h.push('<input class="txt" data-input="' + f.key + '" data-id="' + s.id + '" value="' + esc(v) + '">');
    }
    return h.join("") + "</div>";
  }

  function failBlock(s, i) {
    var f = s.fail;
    var h = ['<div class="row fail"><div class="lab">这一关失败了怎么办</div><div class="seg">'];
    WF.FAIL_MODES.forEach(function (m) {
      h.push('<button data-fail="mode" data-id="' + s.id + '" data-val="' + m[0] +
        '" data-on="' + (f.mode === m[0]) + '">' + m[1] + "</button>");
    });
    h.push("</div>");
    if (f.mode === "back") {
      h.push('<div class="lab sp">回到哪一关<em>也可以直接拖轨道上那个小圆点</em></div>' +
        '<select data-fail="backTo" data-id="' + s.id + '">');
      S.steps.slice(0, i).forEach(function (t, j) {
        h.push('<option value="' + t.id + '"' + (t.id === f.backTo ? " selected" : "") + ">第 " +
          (j + 1) + " 关 · " + esc(K[t.kind].label) + "</option>");
      });
      if (i === 0) h.push('<option value="">（前面没有关口）</option>');
      h.push('</select><div class="lab sp">最多重来几轮</div><div class="seg">' +
        [1, 2, 3].map(function (n) {
          return '<button data-fail="max" data-id="' + s.id + '" data-val="' + n +
            '" data-on="' + (f.max === n) + '">' + n + " 轮</button>";
        }).join("") + "</div>");
    }
    return h.join("") + "</div>";
  }

  // ── 校验：结构错拦死，隐患只提醒（可以「仍然保存」）────────────────
  function renderCheck(saved) {
    var r = WF.compile();
    var warns = r.rows.filter(function (x) { return x[0] === "warn"; }).length;
    var h = ['<div class="ck-hd"><span class="led ' + (r.denied ? "bad" : warns ? "warn" : "ok") + '"></span><b>' +
      (r.denied ? "结构有问题，存不下去" : warns ? "能存，但有 " + warns + " 处隐患" : "可以保存") + "</b>" +
      '<span class="dg">' + esc(WF.digest()) + "</span>" +
      '<button class="save" data-save="1"' + (r.denied ? " disabled" : "") + ">" +
      (r.denied ? "保存" : warns ? "仍然保存" : "保存") + "</button></div>"];
    r.rows.forEach(function (row) {
      h.push('<div class="ck ' + row[0] + '"><em>' + (row[0] === "deny" ? "拦" : row[0] === "warn" ? "提醒" : "通过") +
        "</em><span>" + esc(row[1]) + "</span></div>");
    });
    if (saved) h.push('<div class="ck ok"><em>已存</em><span>' + esc(saved) + "</span></div>");
    el.check.innerHTML = h.join("");
    el.check.setAttribute("data-bad", String(r.denied));
  }

  // ── 预演 ────────────────────────────────────────────────────────────
  function renderSim(assume, open) {
    el.sim.hidden = !open;
    if (!open) return;
    var r = WFSIM.run(S.steps, assume);
    var chips = S.steps.filter(function (s) { return !!s.fail; }).map(function (s) {
      var m = assume[s.id] || "ok";
      var meta = WFSIM.MODES.filter(function (x) { return x[0] === m; })[0];
      return '<button class="asm" data-assume="' + s.id + '" data-m="' + m + '" title="' + meta[2] + '">' +
        "第 " + (WF.indexOf(s.id) + 1) + " 关 · " + meta[1] + "</button>";
    }).join("");

    var rows = r.events.map(function (e, i) {
      var jump = e.jump != null;                       // 目标可能是第 0 关，别用真假值判断
      var cls = jump ? "loop" : e.fail ? "bad" : e.tone;
      return '<div class="tl ' + cls + '" style="animation-delay:' + (i * 70) + 'ms">' +
        '<span class="t-ord">' + (jump ? "↩" : pad(e.idx + 1)) + "</span>" +
        '<span class="t-lab">' + esc(e.label) + (e.round > 1 && !jump ? '<i>第 ' + e.round + " 轮</i>" : "") + "</span>" +
        '<span class="t-st">' + esc(e.status) + "</span>" +
        '<span class="t-note">' + esc(e.note) + "</span></div>";
    }).join("");

    var w = WFSIM.worst(S.steps);
    el.sim.innerHTML =
      '<div class="sim-hd"><b>预演一遍</b><span>假设：</span>' + (chips || '<em class="none">这条流程没有会失败的关口</em>') +
      '<button class="replay" data-replay="1">重放</button>' +
      '<button class="replay" data-simclose="1">收起</button></div>' +
      '<div class="tl-hd"><span>关口</span><span>任务此刻显示</span><span>说明</span></div>' +
      '<div class="tls">' + rows +
      '<div class="tl end ' + r.end.tone + '" style="animation-delay:' + (r.events.length * 70) + 'ms">' +
      '<span class="t-ord">■</span><span class="t-lab">收尾</span><span class="t-st">' +
      (r.end.tone === "good" ? "完成" : r.end.tone === "wait" ? "需你处理" : "失败") + "</span>" +
      '<span class="t-note">' + esc(r.end.text) + "</span></div></div>" +
      '<div class="sim-ft">最坏情况（每关都一直不过）：会打扰你 <b>' + w.interrupts +
      "</b> 次，最多起 <b>" + w.aiRuns + "</b> 次 AI。</div>";
  }

  global.WFVIEW = { mount: mount, renderLib: renderLib, renderRail: renderRail, renderInsp: renderInsp,
    renderCheck: renderCheck, renderSim: renderSim, drawLoops: drawLoops, failText: failText, pad: pad };
})(window);
