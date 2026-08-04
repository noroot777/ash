/* 起手式库 —— 增删改查都在这一页。
   右边那条线的编辑器和新建任务面板里的完全是同一套（同一份 model.js、同一批微菜单），
   这里只是外面套了个「库」的壳：谁是系统自带、谁是我自己建的、改过没有、还能不能恢复。 */
(function () {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;
  var el = {
    list: document.getElementById("liblist"), edit: document.getElementById("edit"),
    libn: document.getElementById("libn"), pop: document.getElementById("pop"),
    add: document.getElementById("new"),
  };

  // ── 库 ──────────────────────────────────────────────────────────────
  var LIB = [], ORIG = {}, seq = 0;
  var selId = null, projDefault = "frontend", pop = null, active = null;

  // 造一组步骤而不打扰当前正在编辑的那条线
  function detach(fn) {
    var keep = S.steps, kw = S.workspace;
    S.steps = []; S.workspace = "isolated";
    fn();
    var out = { steps: S.steps, ws: S.workspace };
    S.steps = keep; S.workspace = kw;
    return out;
  }
  function mkSteps(rows) {
    return detach(function () {
      rows.forEach(function (r) {
        var st = WF.insert(r[0]);
        if (r[1]) Object.keys(r[1]).forEach(function (k) { st.p[k] = r[1][k]; });
      });
    });
  }
  function clone(item, name) {
    var c = JSON.parse(JSON.stringify({ ws: item.ws, steps: item.steps }));
    return { id: "u" + (++seq), name: name, desc: item.desc, sys: false, off: false,
      use: 0, ws: c.ws, steps: c.steps };
  }

  var USE = { blank: 3, fast: 26, standard: 41, frontend: 14, release: 6 };
  Object.keys(WF.TEMPLATES).forEach(function (key) {
    var t = WF.TEMPLATES[key];
    var d = detach(function () { WF.loadTemplate(key); });
    LIB.push({ id: key, name: t.name, desc: t.desc, sys: true, off: key === "fast",
      use: USE[key] || 0, ws: d.ws, steps: d.steps });
    ORIG[key] = JSON.stringify({ ws: d.ws, steps: d.steps });
  });

  // 一条「我自己建的」，和一条「系统自带但被改过的」—— 这两种状态都得能一眼看出来
  (function seed() {
    var mine = mkSteps([["run", { brief: "只改这一个模块" }], ["human", { show: "只看 diff" }]]);
    LIB.push({ id: "u" + (++seq), name: "文档 / 截图类", desc: "不跑验证，我自己看一眼就行",
      sys: false, off: false, use: 9, ws: mine.ws, steps: mine.steps });

    var ours = mkSteps([["run"], ["verify", { checks: ["构建 + 类型检查", "回归测试"] }],
      ["command", { cmd: "npm run lint" }], ["human"], ["accept"]]);
    ours.steps[1].fail = { mode: "back", backTo: ours.steps[0].id, max: 3 };
    ours.steps[3].fail = { mode: "back", backTo: ours.steps[0].id, max: 2 };
    LIB.push({ id: "u" + (++seq), name: "我们组的发布流水", desc: "从「发布流水」复制来改的：多一道 lint",
      sys: false, off: false, use: 21, ws: ours.ws, steps: ours.steps });

    var std = byId("standard");                       // 让「标准交付」一进来就是被改过的
    std.steps[1].p.checks = ["构建 + 类型检查", "回归测试", "浏览器真实点检"];
    std.steps[1].fail.max = 3;
  })();

  function byId(id) {
    for (var i = 0; i < LIB.length; i += 1) if (LIB[i].id === id) return LIB[i];
    return null;
  }
  function cur() { return byId(selId); }
  function dirty(it) { return it.sys && JSON.stringify({ ws: it.ws, steps: it.steps }) !== ORIG[it.id]; }
  function bind(id) {
    selId = id; active = null;
    var it = cur();
    S.steps = it.steps; S.workspace = it.ws;
  }
  // 编辑器动了任何一处：写回库里那一条，重画
  function touch(fn) { if (fn) fn(); var it = cur(); it.ws = S.workspace; it.steps = S.steps; render(); }

  // ── 渲染：左边的库 ──────────────────────────────────────────────────
  function dots(steps) {
    return '<span class="dots">' + steps.map(function (s) {
      return '<u style="background:' + K[s.kind].hue + '"></u>';
    }).join("") + "</span>";
  }
  function rowHtml(it) {
    var tags = [];
    if (it.sys) tags.push('<span class="tag">系统自带</span>');
    else tags.push('<span class="tag mine">我建的</span>');
    if (dirty(it)) tags.push('<span class="tag edited">已改过</span>');
    if (it.id === projDefault) tags.push('<span class="tag def">本项目默认</span>');
    if (it.off) tags.push('<span class="tag">已停用</span>');
    return '<button class="lrow" data-pick="' + it.id + '" data-on="' + (it.id === selId) +
      '" data-off="' + it.off + '"><span class="l1"><b>' + esc(it.name) + "</b>" + dots(it.steps) +
      '</span><span class="l2">' + esc(it.desc) + "</span>" +
      '<span class="tags">' + tags.join("") + "</span></button>";
  }
  function libHtml() {
    var sys = LIB.filter(function (i) { return i.sys && !i.off; });
    var mine = LIB.filter(function (i) { return !i.sys && !i.off; });
    var off = LIB.filter(function (i) { return i.off; });
    var h = [];
    if (sys.length) h.push('<div class="grp">系统自带 · 可改可停用</div>', sys.map(rowHtml).join(""));
    if (mine.length) h.push('<div class="grp">我建的</div>', mine.map(rowHtml).join(""));
    if (off.length) h.push('<div class="grp">已停用 · 不出现在新建任务里</div>', off.map(rowHtml).join(""));
    el.list.innerHTML = h.join("");
    el.libn.textContent = (sys.length + mine.length) + " 个在用 · " + off.length + " 个停用";
  }

  // ── 渲染：右边那条线 ────────────────────────────────────────────────
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function failText(s) {
    var f = s.fail;
    if (!f) return null;
    if (f.mode === "stop") return "没过 → 停下等人";
    if (f.mode === "ask") return "没过 → 问我一句";
    return "没过 → 回第 " + (WF.indexOf(f.backTo) + 1) + " 站，最多 " + f.max + " 轮";
  }
  function gap(i) {
    return '<div class="gap"><button data-ins="' + i + '" aria-label="在这儿加一步">＋</button></div>';
  }
  function col(s, i) {
    var k = K[s.kind], st = WFSIM.STATUS[s.kind];
    var h = ['<div class="col" style="--tone:' + k.hue + '">',
      '<button class="stn" data-stn="' + s.id + '" data-on="' + (active === s.id) + '" style="--tone:' + k.hue + '">' +
      '<i class="dot"></i><span class="no">' + pad(i + 1) + "</span>" + esc(k.title(s.p)) + "</button>",
      '<div class="meta">',
      '<div class="st">任务显示 <b>' + esc(st.text) + "</b></div>"];
    k.fields.forEach(function (f) {
      var v = s.p[f.key], warn = f.type === "checks" && !v.length;
      var text = f.type === "checks" ? (v.length ? "验 " + v.length + " 项：" + v.join("、") : "还没选验什么") : v;
      h.push('<button class="chip' + (warn ? " warn" : "") + '" data-edit="' + s.id +
        '" data-field="' + f.key + '">' + esc(text) + "</button>");
    });
    if (s.fail) {
      h.push('<button class="fx" data-edit="' + s.id + '" data-field="fail">' + esc(failText(s)) + "</button>");
    }
    return h.join("") + "</div></div>";
  }

  function costHtml() {
    var ok = WFSIM.run(S.steps, {});
    var bad = WFSIM.worst(S.steps);
    var r = WF.compile();
    var h = ["<span>顺利走完 <b>" + ok.stats.steps + "</b> 步</span>",
      "<span>·</span><span>要你出面 <b>" + (ok.stats.gates + ok.stats.asks) + "</b> 次</span>",
      "<span>·</span><span>不顺利最多起 <b>" + bad.aiRuns + "</b> 次 AI</span>"];
    r.rows.forEach(function (row) {
      if (row[0] === "ok") return;
      h.push('<span class="' + (row[0] === "deny" ? "bad" : "warn") + '">· ' + esc(row[1]) + "</span>");
    });
    return h.join("");
  }

  function editHtml() {
    var it = cur(), h = [];
    var tags = [];
    if (it.sys) tags.push('<span class="tag">系统自带</span>');
    else tags.push('<span class="tag mine">我建的</span>');
    if (dirty(it)) {
      tags.push('<span class="tag edited">已改过</span>');
      tags.push('<button class="undo" data-op="restore">恢复系统默认</button>');
    }
    if (it.id === projDefault) tags.push('<span class="tag def">本项目默认</span>');
    else tags.push('<button class="undo" data-op="default">设为本项目默认</button>');
    if (it.off) tags.push('<span class="tag">已停用</span>');

    h.push('<div class="ehd"><div class="ttl">' +
      '<input class="tname" id="tname" value="' + esc(it.name) + '">' +
      '<input class="tdesc" id="tdesc" value="' + esc(it.desc) + '"></div>' +
      '<button class="more" id="more">⋯</button></div>');
    h.push('<div class="etags">' + tags.join("") + "</div>");

    h.push('<div class="wsline"><span class="tog" id="tog" data-on="' +
      (S.workspace === "isolated") + '"><i></i></span>' +
      "<span>" + (S.workspace === "isolated" ? "在独立 worktree 里干活" : "直接在项目目录里干活") +
      "</span></div>");

    var r = ['<div class="rail" id="rail">'];
    S.steps.forEach(function (s, i) { if (i) r.push(gap(i)); r.push(col(s, i)); });
    r.push(gap(S.steps.length), "</div>");
    h.push(r.join(""));
    h.push('<div class="cost">' + costHtml() + "</div>");

    h.push('<div class="eft"><div class="use">' +
      "<span><b>" + it.use + "</b> 个任务从它起手</span>" +
      '<span class="sp"></span>' +
      "<span>改这儿不会动那些任务 —— 它们建好时各自拷了一份</span>" +
      '<button class="lk" data-op="who">看看是哪些 →</button></div>');

    var d = ['<div class="danger">'];
    if (it.sys) {
      d.push('<button class="warn" data-op="restore"' + (dirty(it) ? "" : " disabled") + ">恢复系统默认</button>");
      d.push('<button class="del" data-op="off">' + (it.off ? "重新启用" : "停用") + "</button>");
      d.push('<span class="why">系统自带的删不掉，只能停用；停用后新建任务里看不到它，随时能恢复。</span>');
    } else {
      d.push('<button class="del" data-op="del">删除这个起手式</button>');
      d.push('<span class="why">删掉不影响已经建好的任务。</span>');
    }
    h.push(d.join("") + "</div></div>");
    el.edit.innerHTML = h.join("");
  }

  function render() { libHtml(); editHtml(); }

  // ── 微菜单 ──────────────────────────────────────────────────────────
  function closePop() { pop = null; active = null; el.pop.setAttribute("hidden", ""); el.pop.innerHTML = ""; render(); }
  function selOf(t) {
    var d = t.dataset;
    if (d.ins !== undefined) return '[data-ins="' + d.ins + '"]';
    if (d.stn !== undefined) return '[data-stn="' + d.stn + '"]';
    if (d.edit !== undefined) return '[data-edit="' + d.edit + '"][data-field="' + d.field + '"]';
    if (t.id) return "#" + t.id;
    return null;
  }
  function openPop(t, data) {
    pop = { anchor: t, sel: selOf(t) };
    Object.keys(data).forEach(function (k) { pop[k] = data[k]; });
    render(); drawPop();
  }
  function drawPop() {
    if (!pop) return;
    var html = pop.kind === "add" ? addHtml()
      : pop.kind === "stn" ? stnHtml()
      : pop.kind === "fail" ? failHtml()
      : pop.kind === "more" ? moreHtml()
      : pop.kind === "new" ? newHtml()
      : fieldHtml();
    if (html == null) return closePop();
    el.pop.removeAttribute("hidden");
    el.pop.innerHTML = html;
    var at = (pop.sel && document.querySelector(pop.sel)) || pop.anchor;
    if (!at) return closePop();
    var r = at.getBoundingClientRect(), w = el.pop.offsetWidth, h = el.pop.offsetHeight;
    var x = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 12));
    var y = r.bottom + 6 + h > innerHeight - 12 ? Math.max(12, r.top - 6 - h) : r.bottom + 6;
    el.pop.style.left = x + "px"; el.pop.style.top = y + "px";
  }
  function head(text, back) {
    return "<h3>" + (back ? '<button class="back" data-back="1">‹ 返回</button>' : "") + esc(text) + "</h3>";
  }

  function addHtml() {
    return head("在这儿加一步") + Object.keys(K).map(function (kind) {
      var k = K[kind];
      return '<button class="opt" data-add="' + kind + '" style="--tone:' + k.hue + '">' +
        '<span class="d"></span>' + esc(k.label) +
        '<span class="sub">' + esc(WFSIM.STATUS[kind].text) + "</span></button>";
    }).join("");
  }
  function stnHtml() {
    var s = WF.get(pop.stepId);
    if (!s) return null;
    var k = K[s.kind], i = WF.indexOf(s.id);
    var h = [head("第 " + (i + 1) + " 站 · " + k.label),
      '<div class="tip">这一步跑的时候，任务显示「' + esc(WFSIM.STATUS[s.kind].text) + "」。</div>"];
    k.fields.forEach(function (f) {
      var v = s.p[f.key];
      var text = f.type === "checks" ? (v.length ? v.join("、") : "还没选") : v;
      h.push('<button class="cell" data-drill="' + f.key + '" data-id="' + s.id + '">' +
        esc(f.label) + "<b>" + esc(text) + "</b></button>");
    });
    if (s.fail) {
      h.push('<button class="cell" data-drill="fail" data-id="' + s.id + '">没过怎么办<b>' +
        esc(failText(s).replace("没过 → ", "")) + "</b></button>");
    }
    h.push('<div class="rule"></div><div class="ops">' +
      '<button data-op2="left" data-id="' + s.id + '"' + (i ? "" : " disabled") + '>← 往前</button>' +
      '<button data-op2="right" data-id="' + s.id + '"' + (i < S.steps.length - 1 ? "" : " disabled") + '>往后 →</button>' +
      '<button class="del" data-op2="del" data-id="' + s.id + '">删掉</button></div>');
    return h.join("");
  }
  function fieldHtml() {
    var s = WF.get(pop.stepId);
    if (!s) return null;
    var f = null;
    K[s.kind].fields.forEach(function (x) { if (x.key === pop.field) f = x; });
    if (!f) return null;
    var v = s.p[f.key], h = [head(f.label, pop.back)];
    f.options.forEach(function (o) {
      var on = f.type === "checks" ? v.indexOf(o) >= 0 : o === v;
      h.push('<button class="opt" data-' + (f.type === "checks" ? "check" : "set") +
        '="' + esc(o) + '" data-key="' + f.key + '" data-id="' + s.id + '" data-on="' + on + '">' +
        "<i>✓</i>" + esc(o) + "</button>");
    });
    if (f.type === "checks") h.push('<div class="tip">全过才算这一站通过。</div>');
    return h.join("");
  }
  function failHtml() {
    var s = WF.get(pop.stepId);
    if (!s || !s.fail) return null;
    var f = s.fail, i = WF.indexOf(s.id), h = [head("这一站没过，往哪走", pop.back)];
    WF.FAIL_MODES.forEach(function (m) {
      h.push('<button class="opt" data-fail="mode" data-id="' + s.id + '" data-val="' + m[0] +
        '" data-on="' + (f.mode === m[0]) + '"><i>✓</i>' + esc(m[1]) + "</button>");
    });
    if (f.mode === "back") {
      h.push('<div class="rule"></div>');
      if (!i) h.push('<div class="tip">前面没有站可回 —— 这条会被拦下。</div>');
      S.steps.slice(0, i).forEach(function (t, j) {
        h.push('<button class="opt" data-fail="backTo" data-id="' + s.id + '" data-val="' + t.id +
          '" data-on="' + (t.id === f.backTo) + '"><i>✓</i>回第 ' + (j + 1) + " 站 · " + esc(K[t.kind].label) + "</button>");
      });
      h.push('<div class="ops">' + [1, 2, 3].map(function (n) {
        return '<button data-fail="max" data-id="' + s.id + '" data-val="' + n + '"' +
          (f.max === n ? ' style="background:var(--sel);color:var(--ink)"' : "") + ">最多 " + n + " 轮</button>";
      }).join("") + "</div>");
    }
    return h.join("");
  }

  // 「⋯」：库层面的增删改，全在这一个菜单里
  function moreHtml() {
    var it = cur(), h = [head(it.name)];
    h.push('<button class="opt plain" data-op="copy">复制一份</button>');
    h.push('<button class="opt plain" data-op="default"' + (it.id === projDefault ? " disabled" : "") +
      ">设为本项目默认</button>");
    if (it.sys) {
      h.push('<div class="rule"></div>');
      h.push('<button class="opt plain" data-op="restore">恢复系统默认' +
        (dirty(it) ? "" : "（没改过）") + "</button>");
      h.push('<button class="opt plain danger" data-op="off">' + (it.off ? "重新启用" : "停用") + "</button>");
      h.push('<div class="tip">系统自带的改坏了不要紧，恢复随时可按。</div>');
    } else {
      h.push('<div class="rule"></div>');
      h.push('<button class="opt plain danger" data-op="del">删除</button>');
    }
    return h.join("");
  }
  function newHtml() {
    var it = cur();
    return head("新建起手式") +
      '<button class="opt plain" data-new="blank">空白 <span class="sub">从一站开始搭</span></button>' +
      '<button class="opt plain" data-new="copy">复制「' + esc(it.name) + '」</button>' +
      '<button class="opt plain" data-new="task">从任务存过来 <span class="sub">给设置页加「工作流」入口</span></button>' +
      '<div class="tip">第三条最常用：那一次为了赶工改出来的线，改完发现好用，一键留下来。</div>';
  }

  // ── 库层面的动作 ────────────────────────────────────────────────────
  function doOp(op) {
    var it = cur();
    if (op === "copy") {
      var c = clone(it, it.name + " 副本");
      LIB.splice(LIB.indexOf(it) + 1, 0, c);
      bind(c.id); return closePop();
    }
    if (op === "default") { projDefault = it.id; return closePop(); }
    if (op === "restore") {
      if (!it.sys) return closePop();
      var d = detach(function () { WF.loadTemplate(it.id); });
      it.ws = d.ws; it.steps = d.steps;
      bind(it.id); return closePop();
    }
    if (op === "off") { it.off = !it.off; return closePop(); }
    if (op === "del") {
      if (it.sys) return closePop();
      LIB.splice(LIB.indexOf(it), 1);
      bind(LIB[0].id); return closePop();
    }
    closePop();
  }
  function doNew(kind) {
    var it = cur(), made;
    if (kind === "copy") made = clone(it, it.name + " 副本");
    else if (kind === "blank") {
      var b = mkSteps([["run"]]);
      made = { id: "u" + (++seq), name: "新起手式", desc: "还没写说明", sys: false, off: false,
        use: 0, ws: b.ws, steps: b.steps };
    } else {
      var f = detach(function () { WF.loadTemplate("frontend"); });
      made = { id: "u" + (++seq), name: "从「给设置页加『工作流』入口」存的",
        desc: "那个任务当时用的线，原样留一份", sys: false, off: false, use: 0, ws: f.ws, steps: f.steps };
    }
    LIB.push(made);
    bind(made.id);
    closePop();
  }

  // ── 事件 ────────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-pick],[data-ins],[data-stn],[data-edit],[data-add],[data-op]," +
      "[data-op2],[data-drill],[data-set],[data-check],[data-fail],[data-back],[data-new],#more,#new,#tog");
    if (!t) { if (!el.pop.contains(e.target)) closePop(); return; }
    var d = t.dataset;

    if (d.pick !== undefined) { bind(d.pick); return closePop(); }
    if (t.id === "more") {
      if (pop && pop.kind === "more") return closePop();
      return openPop(t, { kind: "more" });
    }
    if (t.id === "new") {
      if (pop && pop.kind === "new") return closePop();
      return openPop(t, { kind: "new" });
    }
    if (t.id === "tog") { return touch(function () { S.workspace = S.workspace === "isolated" ? "shared" : "isolated"; }); }
    if (d.op !== undefined) { if (d.op === "who") return closePop(); return doOp(d.op); }
    if (d.new !== undefined) return doNew(d.new);

    if (d.ins !== undefined) return openPop(t, { kind: "add", at: Number(d.ins) });
    if (d.stn !== undefined) {
      if (pop && pop.kind === "stn" && pop.stepId === d.stn) return closePop();
      active = d.stn;
      return openPop(t, { kind: "stn", stepId: d.stn });
    }
    if (d.edit !== undefined) {
      active = d.edit;
      return openPop(t, { kind: d.field === "fail" ? "fail" : "field", stepId: d.edit, field: d.field });
    }
    if (d.drill !== undefined) {
      pop.kind = d.drill === "fail" ? "fail" : "field";
      pop.field = d.drill; pop.back = true;
      return drawPop();
    }
    if (d.back !== undefined) { pop.kind = "stn"; pop.back = false; return drawPop(); }

    if (d.add !== undefined) {
      var at = pop ? pop.at : null, made = null;
      touch(function () { made = WF.insert(d.add, at); });
      if (made) {
        active = made.id;
        pop = { anchor: null, sel: '[data-stn="' + made.id + '"]', kind: "stn", stepId: made.id };
        render(); drawPop();
      }
      return;
    }
    if (d.op2 !== undefined) {
      touch(function () {
        if (d.op2 === "del") WF.remove(d.id);
        else WF.move(d.id, d.op2 === "left" ? -1 : 1);
      });
      if (d.op2 === "del") return closePop();
      return drawPop();
    }
    if (d.set !== undefined) { touch(function () { WF.get(d.id).p[d.key] = d.set; }); return closePop(); }
    if (d.check !== undefined) {
      touch(function () {
        var arr = WF.get(d.id).p[d.key], i = arr.indexOf(d.check);
        if (i >= 0) arr.splice(i, 1); else arr.push(d.check);
      });
      return drawPop();
    }
    if (d.fail !== undefined) {
      touch(function () {
        var f = WF.get(d.id).fail;
        if (d.fail === "mode") {
          f.mode = d.val;
          if (f.mode === "back" && !f.backTo) {
            var idx = WF.indexOf(d.id), pick = null;
            S.steps.slice(0, idx).forEach(function (s) { if (s.kind === "run") pick = s.id; });
            f.backTo = pick || (idx > 0 ? S.steps[0].id : null);
          }
        }
        if (d.fail === "backTo") f.backTo = d.val;
        if (d.fail === "max") f.max = Number(d.val);
      });
      return drawPop();
    }
  });

  // 改名/改说明就是直接在标题上改，改完立刻反映到左边的库里
  document.addEventListener("input", function (e) {
    var it = cur();
    if (e.target.id === "tname") { it.name = e.target.value; libHtml(); }
    if (e.target.id === "tdesc") { it.desc = e.target.value; libHtml(); }
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });
  window.addEventListener("resize", closePop);

  // 想把 demo 定格在某个状态（截图、发给别人看）：地址栏加 #pick=frontend、#menu=more
  var m0 = /(?:^|#|&)pick=([\w-]+)/.exec(location.hash);
  bind(m0 && byId(m0[1]) ? m0[1] : "standard");
  render();
  var m1 = /(?:^|#|&)menu=(more|new)/.exec(location.hash);
  if (m1) {
    var trig = document.getElementById(m1[1] === "more" ? "more" : "new");
    if (trig) openPop(trig, { kind: m1[1] });
  }
})();
