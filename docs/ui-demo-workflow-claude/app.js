/* 工作流编排 · Claude 方案 — demo 交互（无依赖） */
(function () {
  "use strict";

  // ── 模板：固定主干 + 一组开关/参数。存储形状是「节点 + 出口」，UI 只暴露受限编辑。
  //    刻意不含任何分组/队列字段：工作流只描述「一个任务干完要过哪几关」。
  var TEMPLATES = {
    fast: {
      name: "极速原型", scope: "内置 · 只读", desc: "直接在项目目录跑，不验证、不设关口；实现完成即结束。",
      cfg: { workspace: "shared", verify: false, verifiers: [], preview: false, human: false, accept: false,
             rounds: 0, onFail: "stop" },
    },
    standard: {
      name: "标准交付", scope: "系统默认 · v3", desc: "实现完成 → 自动验证；验证失败最多回修 2 轮，通过后人工验收再合并。",
      cfg: { workspace: "isolated", verify: true, verifiers: ["构建 + 类型检查", "回归测试"], preview: false,
             human: true, accept: true, rounds: 2, onFail: "repair" },
    },
    frontend: {
      name: "前端真实验收", scope: "项目 · ash · v2", desc: "验证通过后先把预览起起来，你点开看过真东西再验收；关口一结束预览自动回收。",
      cfg: { workspace: "isolated", verify: true, verifiers: ["构建 + 类型检查", "浏览器真实点检"], preview: true,
             human: true, accept: true, rounds: 2, onFail: "repair" },
    },
    strict: {
      name: "严格发布", scope: "内置 · 只读", desc: "三道验证全过、你亲自点头，才做确定性合并；中途失败先问你一句。",
      cfg: { workspace: "isolated", verify: true, verifiers: ["构建 + 类型检查", "回归测试", "浏览器真实点检"],
             preview: true, human: true, accept: true, rounds: 3, onFail: "ask" },
    },
  };

  var SPINE = [
    { key: "run", type: "agent.run", name: "实现任务", always: true,
      desc: "启动真实 CLI Session 执行任务；首个 Session 创建时冻结工作区策略。",
      ports: [["completed", "→ 下一关", "ok"], ["failed", "→ 停下", "bad"]] },
    { key: "verify", type: "agent.verify", name: "自动验证",
      desc: "独立审查任务真实运行、产出报告与截图；只读评议不算 verified。",
      ports: [["verified", "→ 下一关", "ok"], ["failed", "→ 按失败策略", "bad"]] },
    { key: "preview", type: "preview.serve", name: "预览就绪",
      desc: "在本任务工作区起服务，给人工关口一个能点开的地址；关口结束即回收。",
      ports: [["ready", "→ 人工验收", "ok"], ["failed", "→ 人工验收（只看 diff）", "bad"]] },
    { key: "human", type: "human.gate", name: "人工验收",
      desc: "展示 diff、验证证据与预览地址；批准是进入不可逆合并的必要条件。",
      ports: [["approved", "→ 合并与清理", "ok"], ["rejected", "→ 按失败策略", "bad"]] },
    { key: "accept", type: "repo.accept", name: "合并与清理",
      desc: "仓库锁内确定性合并，成功后清理 worktree 与任务分支。",
      ports: [["success", "→ 完成", "ok"], ["conflict", "→ 退回本任务", "bad"]] },
  ];

  var FAIL_LABEL = { stop: "停下等人", ask: "问一句再决定", repair: "自动修复" };

  var state = { tpl: "standard", sel: "run", cfg: null };
  var $ = function (sel) { return document.querySelector(sel); };
  var toastTimer = null;

  function toast(msg) {
    var el = $("#toast");
    el.textContent = msg; el.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("is-on"); }, 1800);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function enabled(key) { return key === "run" ? true : !!state.cfg[key]; }

  // ── 编译检查：能拒绝的一律拒绝，不靠文档提醒 ──────────────────────────
  function compile() {
    var c = state.cfg, rows = [], denied = false;

    if (c.accept && !c.human) {
      rows.push(["deny", "repo.accept 前必须有 human.gate —— 不可逆动作不允许自动跨过人工关口。"]);
      denied = true;
    }
    // 预览进程的生命周期锚在人工关口上；没有关口就没有「什么时候该回收」的答案。
    if (c.preview && !c.human) {
      rows.push(["deny", "preview.serve 的回收时机锚在 human.gate 上：没有人工关口，这个服务没有明确的关闭时刻，只会变成又一个没人记得停的端口。"]);
      denied = true;
    }
    if (c.onFail === "repair" && !c.verify) {
      rows.push(["deny", "自动修复的唯一触发源是验证给出的 failed。关掉验证，agent.repair 是一个永远进不去的节点。"]);
      denied = true;
    }
    if (c.workspace === "shared" && c.accept) {
      rows.push(["warn", "在项目目录里直接干活，合并与清理这一关没有独立分支可合 —— 会退化成「只提交，不合并」。"]);
    }
    if (c.verify && c.verifiers.length === 0) {
      rows.push(["warn", "验证关口开着但没有任何动作，等于一个必然直接通过的空关口。"]);
    }
    if (!denied) {
      rows.push(["ok", "所有出口可达；回路上限 " + (c.onFail === "repair" ? c.rounds + " 轮" : "不适用") + "；" +
        (c.preview ? "预览有明确回收点（关口结束 / 闲置超时 / 任务终止）；" : "") + "工作区策略无冲突。"]);
    }
    return { rows: rows, denied: denied };
  }

  // ── ① 纵向主干轨 ────────────────────────────────────────────────────
  function renderTrack() {
    var c = state.cfg, html = "", index = 0;

    SPINE.forEach(function (s) {
      var on = enabled(s.key);
      if (on) index += 1;
      var cls = "stage " + (on ? "is-on" : "is-off") + (state.sel === s.key ? " is-sel" : "");
      var badge = on ? "" : '<span class="chip">已关闭</span>';
      if (on && s.key === "verify") badge = '<span class="chip on">最多 ' + c.rounds + ' 轮</span>';
      if (on && s.key === "run") badge = '<span class="chip on">' + (c.workspace === "isolated" ? "独立 worktree" : "共享目录") + "</span>";
      if (on && s.key === "preview") badge = '<span class="chip warn">关口结束即回收</span>';

      var ports = s.ports.map(function (p) {
        var k = p[2] === "bad" ? " bad" : "";
        var target = p[1];
        if (s.key === "verify" && p[0] === "failed") target = "→ " + FAIL_LABEL[c.onFail];
        if (s.key === "human" && p[0] === "rejected") target = "→ " + FAIL_LABEL[c.onFail === "stop" ? "stop" : "repair"];
        return '<span class="port' + k + '"><i></i>' + p[0] + " <em style=\"font-style:normal;color:var(--faint)\">" + target + "</em></span>";
      }).join("");

      var extra = "";
      if (s.key === "verify" && on) {
        extra = '<div class="parallel"><span class="parallel-label">并行动作（同一关口内并发，全通过才算 verified）</span>' +
          c.verifiers.map(function (v) { return '<span class="pact"><i></i>' + v + "</span>"; }).join("") +
          '<button class="pact add" data-act="add-verifier">＋ 加一条</button></div>';
      }
      if (s.key === "preview" && on) {
        extra = '<div class="parallel"><span class="parallel-label">预览进程</span>' +
          '<span class="pact"><i></i>npm -w web run dev</span>' +
          '<span class="pact"><i></i>端口由 ash 分配</span>' +
          '<span class="pact"><i></i>就绪后才放行到人工关口</span></div>';
      }

      html += '<div class="' + cls + '" data-stage="' + s.key + '">' +
        '<div class="stage-gutter"><span class="stage-dot">' + (on ? ("0" + index) : "··") + "</span></div>" +
        '<div class="stage-body"><button class="stage-card" data-stage-card="' + s.key + '">' +
        '<div class="stage-top"><b>' + s.name + "</b><code>" + s.type + "</code>" + badge + "</div>" +
        '<div class="stage-desc">' + s.desc + "</div>" +
        (on ? '<div class="ports">' + ports + "</div>" + extra : "") +
        "</button></div></div>";
    });

    $("#track").innerHTML = html;

    $("#tplName").textContent = TEMPLATES[state.tpl].name;
    $("#tplDesc").textContent = TEMPLATES[state.tpl].desc;
    $("#scopeChip").textContent = TEMPLATES[state.tpl].scope;
    $("#tplMetas").innerHTML =
      '<span class="chip">' + (c.workspace === "isolated" ? "独立 worktree" : "共享项目目录") + "</span>" +
      '<span class="chip">失败 · ' + FAIL_LABEL[c.onFail] + "</span>" +
      (c.human ? '<span class="chip on">人工关口已开</span>' : '<span class="chip">全自动</span>') +
      (c.preview ? '<span class="chip warn">预览关口已开</span>' : "");
  }

  function renderCompile() {
    var r = compile(), c = state.cfg;
    $("#compileHead").innerHTML = r.denied
      ? '<span class="chip bad">✕ 编译被拒绝</span><span style="color:var(--red)">这份定义不能发布</span>'
      : '<span class="chip good">✓ 编译通过</span><span style="color:var(--muted);font-weight:450">可发布为新版本</span>';
    $("#compileRows").innerHTML = r.rows.map(function (row) {
      return '<div class="crow ' + row[0] + '"><i></i><span>' + row[1] + "</span></div>";
    }).join("");
    $("#compileFacts").innerHTML =
      '<div class="fact"><small>关口</small><b>' + ["run", "verify", "preview", "human", "accept"].filter(enabled).length + " 关</b></div>" +
      '<div class="fact"><small>失败路径</small><b>' + (c.onFail === "repair" ? "repair × " + c.rounds + " → 停下" : FAIL_LABEL[c.onFail]) + "</b></div>" +
      '<div class="fact"><small>工作区</small><b>' + (c.workspace === "isolated" ? "isolated · 首个 Session 时冻结" : "shared · 项目目录") + "</b></div>" +
      '<div class="fact"><small>对队列的影响</small><b>无新增语义</b></div>';
  }

  // ── ① 右栏参数 ──────────────────────────────────────────────────────
  function field(label, inner) { return '<div class="field"><span>' + label + "</span>" + inner + "</div>"; }
  function select(text) { return '<div class="select">' + text + "<i>⌄</i></div>"; }
  function seg(name, options, current) {
    return '<div class="seg" data-seg="' + name + '">' + options.map(function (o) {
      return '<button data-value="' + o[0] + '" aria-pressed="' + (o[0] === current) + '">' + o[1] + "</button>";
    }).join("") + "</div>";
  }
  function toggle(name, on, label) {
    return '<div class="toggle-row"><button class="switch" data-toggle="' + name + '" aria-pressed="' + on +
      '" aria-label="切换' + label + '"></button><span>' + (on ? "已开启" : "已关闭") + "</span></div>";
  }

  function renderInspector() {
    var c = state.cfg, s = null, body = "";
    SPINE.forEach(function (x) { if (x.key === state.sel) s = x; });

    if (state.sel === "run") {
      body = field("执行器", select("codex@cpa")) + field("模型", select("gpt-5.6-sol")) +
        field("思考强度", select("xhigh")) +
        field("工作区", seg("workspace", [["isolated", "独立 worktree"], ["shared", "项目目录"]], c.workspace)) +
        '<p class="note">工作区在第一个 Session 创建时冻结，之后本任务不再改 —— 跑到一半换目录，前面产出的东西就找不着了。</p>';
    } else if (state.sel === "verify") {
      body = field("自动验证", toggle("verify", c.verify, "自动验证")) +
        field("验证执行器", select("codex@review · gpt-5.6-sol")) +
        field("最多几轮", seg("rounds", [[1, "1"], [2, "2"], [3, "3"]], c.rounds)) +
        field("失败怎么办", seg("onFail", [["stop", "停下"], ["ask", "问一句"], ["repair", "自动修复"]], c.onFail)) +
        '<p class="note">「验证」固定要求真实运行 + 报告 + 必要截图；只读评议不能产出 verified。轮数上限持久化在 NodeRun.attempt 上，重启后从库里恢复。</p>';
    } else if (state.sel === "preview") {
      body = field("预览就绪", toggle("preview", c.preview, "预览就绪")) +
        field("预览命令（项目级）", select("npm -w web run dev")) +
        field("端口", select("由 ash 分配 · 14300–14399")) +
        field("就绪判据", select("端口可连 + 日志匹配 ready")) +
        field("回收时机", select("人工关口结束 / 闲置 30 分钟 / 任务终止")) +
        '<p class="note">这一关不产出结论，只负责「让人能看见」。起不来也不卡死流程：走 failed 出口进人工关口，标注「只能看 diff」。</p>' +
        '<p class="note" style="margin-top:8px;border-color:var(--amber-line)">预览进程的归属写在关口上，所以没人需要记得去关它 —— 「验证完忘了停服务」这个老坑从设计上消失。</p>';
    } else if (state.sel === "human") {
      body = field("人工验收", toggle("human", c.human, "人工验收")) +
        field("通过条件", select(c.verify ? "必须已有 verified 结论" : "无前置条件")) +
        field("提醒", select("落桶「需处理」+ 推送通知")) +
        '<p class="note">开着这一关，任务会长时间停在 <code>awaiting_review</code>。串行分组里这意味着后继一直等你 —— 这是既有的队列规则，工作流没有改它，只是把这段等待变明显了。急的话把这个模板换掉，或者让那条链别用带人工关口的模板。</p>';
    } else if (state.sel === "accept") {
      body = field("合并与清理", toggle("accept", c.accept, "合并与清理")) +
        field("合并策略", select("Ash 安全合并（仓库锁内）")) +
        field("清理", select("合并后删除 worktree 与任务分支")) +
        '<p class="note">冲突不自动解决，退回本任务处理。这一关不允许在没有 human.gate 的定义里存在 —— 编译期就拒。</p>';
    }

    $("#inspector").innerHTML =
      '<div class="ins-kicker">' + s.type.toUpperCase() + "</div><h2>" + s.name + "</h2>" +
      '<p class="ins-desc">' + s.desc + "</p>" + body;
  }

  function renderAll() { renderTrack(); renderCompile(); renderInspector(); }

  // ── 事件 ────────────────────────────────────────────────────────────
  function selectTemplate(key) {
    state.tpl = key; state.cfg = clone(TEMPLATES[key].cfg); state.sel = "run";
    document.querySelectorAll("[data-tpl]").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.dataset.tpl === key));
    });
    renderAll();
  }

  function showView(key) {
    var found = false;
    document.querySelectorAll("#tabs button").forEach(function (b) {
      var on = b.dataset.view === key;
      if (on) found = true;
      b.setAttribute("aria-selected", String(on));
    });
    if (!found) return false;
    document.querySelectorAll("section.view").forEach(function (v) {
      v.classList.toggle("is-on", v.dataset.view === key);
    });
    return true;
  }

  document.addEventListener("click", function (e) {
    var tab = e.target.closest("[data-view]");
    if (tab && tab.parentElement && tab.parentElement.id === "tabs") {
      showView(tab.dataset.view);
      location.hash = tab.dataset.view;
      return;
    }

    var tpl = e.target.closest("[data-tpl]");
    if (tpl) { selectTemplate(tpl.dataset.tpl); return; }

    var card = e.target.closest("[data-stage-card]");
    if (card) { state.sel = card.dataset.stageCard; renderAll(); return; }

    var sw = e.target.closest("[data-toggle]");
    if (sw) {
      var k = sw.dataset.toggle;
      state.cfg[k] = !state.cfg[k];
      if (k === "human" && !state.cfg.human && state.cfg.accept) {
        state.cfg.accept = false;
        toast("人工验收关闭，合并与清理一并关闭（不可逆动作不得自动跨人）");
      }
      renderAll(); return;
    }

    var segBtn = e.target.closest("[data-seg] [data-value]");
    if (segBtn) {
      var name = segBtn.closest("[data-seg]").dataset.seg;
      var value = segBtn.dataset.value;
      state.cfg[name] = name === "rounds" ? Number(value) : value;
      renderAll(); return;
    }

    if (e.target.closest('[data-act="add-verifier"]')) {
      state.cfg.verifiers.push("自定义验证 " + (state.cfg.verifiers.length + 1));
      renderAll(); toast("已加一条并行验证动作（全通过才算 verified）"); return;
    }

    var act = e.target.closest("[data-act]");
    if (!act) return;
    var messages = {
      publish: compile().denied ? "编译被拒绝，无法发布" : "已发布「" + TEMPLATES[state.tpl].name + "」新版本",
      simulate: "试演完成：走通 3 条成功路径、4 条失败路径，回路未越界",
      "preview-restart": "预览已重启：localhost:14312",
      "preview-extend": "预览保活延长到 30 分钟后",
      "preview-kill": "预览已回收，端口 14312 已释放",
      approve: "已批准 → 进入 repo.accept；预览进程同时回收",
      reject: "已打回 → 进入 agent.repair（第 1 轮）；预览进程同时回收",
      adjust: "只有「还没开始的关口」可改；已经跑过的关口不可改",
    };
    if (messages[act.dataset.act]) toast(messages[act.dataset.act]);
  });

  selectTemplate("standard");
  // 每个视图可直接分享链接：index.html#runtime
  showView((location.hash || "").replace("#", "") || "orchestrate");
  window.addEventListener("hashchange", function () {
    showView((location.hash || "").replace("#", "") || "orchestrate");
  });
})();
