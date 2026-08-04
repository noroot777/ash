/* 预演引擎 —— 给定一条流程和「哪几关会不过」的假设，推演出每一刻任务显示什么状态。
   参考 GitLab pipeline editor 的 dry-run：光有 lint 会给人假的安全感，得真跑一遍逻辑。 */
(function (global) {
  "use strict";

  // 每一关运行期间，任务在列表里显示的状态（用 harness 真实的状态词）
  var STATUS = {
    run: { text: "运行中", tone: "run", note: "智能体在干活，卡片上滚动它的输出" },
    verify: { text: "审查中", tone: "run", note: "独立审查者跑勾上的检查项" },
    preview: { text: "运行中 · 预览已起", tone: "run", note: "分配端口，日志出现 ready 才算起来" },
    human: { text: "需你处理", tone: "wait", note: "任务停下并推送通知，等你点头" },
    command: { text: "运行中 · 跑命令", tone: "run", note: "命令的输出进同一条时间线" },
    accept: { text: "已验收", tone: "good", note: "合并回主干，删掉 worktree 与任务分支" },
  };

  var MODES = [
    ["ok", "顺利", "这一关一次过"],
    ["once", "头一次不过", "重来一次就过"],
    ["always", "一直不过", "怎么重来都不过"],
  ];

  function run(steps, assume) {
    var K = WF.KINDS, ev = [], i = 0, guard = 0;
    var tries = {}, backs = {}, asks = 0, gates = 0, aiRuns = 0, end = null;

    while (i < steps.length) {
      if (guard++ > 80) { end = { tone: "bad", text: "这条流程会兜圈子 —— 编译闸本该在这之前就拦住它。" }; break; }
      var s = steps[i], k = K[s.kind];
      var r = (tries[s.id] = (tries[s.id] || 0) + 1);
      if (s.kind === "run") aiRuns++;
      if (s.kind === "human") gates++;

      var st = STATUS[s.kind];
      ev.push({
        id: s.id, idx: i, kind: s.kind, round: r,
        label: k.title(s.p), code: k.code, hue: k.hue,
        status: st.text, tone: st.tone, note: st.note,
      });

      var mode = assume[s.id] || "ok";
      var failed = !!s.fail && (mode === "always" || (mode === "once" && r === 1));
      if (!failed) { i++; continue; }

      var isGate = s.kind === "human";
      ev.push({
        id: s.id, idx: i, kind: s.kind, round: r, fail: true,
        label: isGate ? "你打回了" : "这一关没过",
        status: isGate ? "需你处理" : "验证不通过", tone: "bad",
        note: isGate ? "人工关口给出的否决，和自动验证不过走同一条路" : "按这一关配的「失败怎么办」往下走",
      });

      var f = s.fail;
      if (f.mode === "stop") {
        end = { tone: "bad", text: "停在第 " + (i + 1) + " 关，任务落 failed，等你自己看。" };
        break;
      }
      if (f.mode === "ask") {
        asks++;
        end = { tone: "wait", text: "停下来问你一句（重来还是放弃），任务显示「需你处理」。" };
        break;
      }
      var used = (backs[s.id] = (backs[s.id] || 0) + 1);
      var j = WF.indexOf(f.backTo);
      if (j < 0 || j >= i) { end = { tone: "bad", text: "失败去向不合法 —— 编译闸会拒绝保存。" }; break; }
      if (used > f.max) {
        end = { tone: "bad", text: "回第 " + (j + 1) + " 关重来 " + f.max + " 轮仍然不过，停下等你。" };
        break;
      }
      ev.push({
        id: s.id, idx: i, jump: j, round: used,
        label: "回到第 " + (j + 1) + " 关重做", status: "第 " + (used + 1) + " 轮", tone: "loop",
        note: "上限 " + f.max + " 轮，用满了就停下等人",
      });
      // 不重置计数：往回拐之后每一关的「第几轮」继续往上加，
      // 「头一次不过」的关口第二次自然就过了
      i = j;
    }

    if (!end) {
      var last = steps[steps.length - 1];
      end = {
        tone: "good",
        text: last && last.kind === "accept"
          ? "走到底：改动已合并、worktree 与分支已清理，任务落 accepted。"
          : "走到底：任务落 done，改动留在分支上等你处理。",
      };
    }
    return {
      events: ev, end: end,
      stats: { gates: gates, asks: asks, aiRuns: aiRuns, steps: ev.filter(function (e) { return e.jump == null && !e.fail; }).length },
    };
  }

  // 最坏情况：每一关都「一直不过」时会怎样 —— 用来回答「这条流程最多打扰我几次」
  function worst(steps) {
    var r = run(steps, pessimistic(steps, "always"));
    return { interrupts: r.stats.gates + r.stats.asks + (r.end.tone === "bad" ? 1 : 0), aiRuns: r.stats.aiRuns };
  }

  // 「不顺利」的假设只加在检查性关口上：让 AI 干活那一步自己崩了是另一回事，
  // 那种情况任务直接落 failed，看不出这条流程的形状。
  var CHECKY = { verify: 1, human: 1, command: 1 };
  function pessimistic(steps, how) {
    var a = {};
    steps.forEach(function (s) { if (s.fail && CHECKY[s.kind]) a[s.id] = how; });
    return a;
  }

  global.WFSIM = { run: run, worst: worst, pessimistic: pessimistic, STATUS: STATUS, MODES: MODES };
})(window);
