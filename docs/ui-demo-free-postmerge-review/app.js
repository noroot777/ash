const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const el = {
  reviewButton: $("#reviewButton"), reviewLabel: $("#reviewLabel"), previewButton: $("#previewButton"), previewLabel: $("#previewLabel"),
  mergeButton: $("#mergeButton"), mergeLabel: $("#mergeLabel"), snapshotChip: $("#snapshotChip"), mergeBanner: $("#mergeBanner"),
  buttonHint: $("#buttonHint"), buttonHintText: $("#buttonHintText"), taskStatus: $("#taskStatus"), sideTaskStatus: $("#sideTaskStatus"),
  guideMerge: $("#guideMerge"), guideReview: $("#guideReview"), guideResult: $("#guideResult"),
  mergeDialog: $("#mergeDialog"), reviewDialog: $("#reviewDialog"), reviewDialogTitle: $("#reviewDialogTitle"), reviewDialogCopy: $("#reviewDialogCopy"),
  targetTitle: $("#targetTitle"), targetDetail: $("#targetDetail"), timelineNote: $("#timelineNote"), mergeNote: $("#mergeNote"),
  mergeNoteTitle: $("#mergeNoteTitle"), mergeNoteText: $("#mergeNoteText"), mergeNoteTime: $("#mergeNoteTime"), reviewNote: $("#reviewNote"),
  reviewNoteTitle: $("#reviewNoteTitle"), reviewNoteText: $("#reviewNoteText"), reviewNoteTime: $("#reviewNoteTime"),
  workflowStatus: $("#workflowStatus"), inspectorMerge: $("#inspectorMerge"), inspectorMergeText: $("#inspectorMergeText"), inspectorMergeTime: $("#inspectorMergeTime"),
  inspectorReview: $("#inspectorReview"), inspectorReviewText: $("#inspectorReviewText"), inspectorReviewTime: $("#inspectorReviewTime"),
  snapshotPanel: $("#snapshotPanel"), reviewPanel: $("#reviewPanel"), reviewPanelStatus: $("#reviewPanelStatus"), reviewPanelSubtitle: $("#reviewPanelSubtitle"),
  reviewRunning: $("#reviewRunning"), reviewSim: $("#reviewSim"), resultBox: $("#resultBox"), resultMark: $("#resultMark"), resultTitle: $("#resultTitle"),
  resultText: $("#resultText"), failureActions: $("#failureActions"), fixPanel: $("#fixPanel"), reviewCount: $("#reviewCount"), toast: $("#toast"),
};

let state = "ready";
let previewOpen = false;
let reviewTarget = "product";
let mergeTimer;
let toastTimer;

function showToast(text) {
  clearTimeout(toastTimer);
  el.toast.textContent = text;
  el.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => el.toast.classList.remove("is-visible"), 2200);
}

function openDialog(dialog) { dialog.classList.remove("is-hidden"); }
function closeDialog(dialog) { dialog.classList.add("is-hidden"); }

function setGuide(step) {
  [el.guideMerge, el.guideReview, el.guideResult].forEach((item, index) => item.classList.toggle("is-active", index === step));
}

function setTimelineItem(item, kind, mark) {
  item.classList.remove("is-active", "is-done", "is-failed");
  if (kind) item.classList.add(kind);
  item.querySelector(":scope > span").textContent = mark;
}

function render() {
  const merging = state === "merging";
  const merged = ["merged", "reviewing", "failed", "passed"].includes(state);
  const reviewing = state === "reviewing";
  const failed = state === "failed";
  const passed = state === "passed";

  el.taskStatus.textContent = failed ? "已合并 · 审查未过" : reviewing ? "已合并 · 审查中" : merged ? "已合并" : merging ? "合并中" : "已完成";
  el.taskStatus.className = `status-pill${merged && !failed ? " is-green" : ""}${failed ? " is-red" : ""}`;
  el.sideTaskStatus.textContent = failed ? "合并后发现问题" : reviewing ? "基线审查中" : merged ? "已合并清理" : merging ? "正在合并" : "实现完成";

  el.reviewButton.disabled = merging || reviewing;
  el.previewButton.disabled = merging || merged;
  el.mergeButton.disabled = merging || merged;
  el.reviewButton.dataset.state = reviewing ? "reviewing" : failed ? "failed" : passed ? "passed" : merged ? "merged" : "idle";
  el.mergeButton.dataset.state = merging ? "merging" : merged ? "merged" : "idle";
  el.mergeButton.classList.toggle("is-spinning", merging);
  el.reviewButton.classList.toggle("is-spinning", reviewing);
  el.reviewLabel.textContent = reviewing ? "基线审查中" : failed || passed ? "再审一轮" : merged ? "审查已合并结果" : "派审查";
  el.previewLabel.textContent = merged ? "预览已关闭" : previewOpen ? "关闭预览" : "打开预览";
  el.previewButton.setAttribute("aria-pressed", String(previewOpen && !merged));
  el.mergeLabel.textContent = merging ? "合并中…" : merged ? "已合并清理" : "合并&清理";
  el.snapshotChip.classList.toggle("is-hidden", !merged);
  el.mergeBanner.classList.toggle("is-visible", merged);

  el.buttonHint.className = `button-change-hint${merged ? " is-success" : ""}${reviewing ? " is-review" : ""}`;
  el.buttonHint.querySelector("span").textContent = reviewing ? "运行中" : merged ? "按钮已变化" : "看这里";
  el.buttonHintText.textContent = reviewing
    ? "“审查已合并结果”已经原位变成“基线审查中”。"
    : merged
      ? "原来的“派审查”现在变成“审查已合并结果”；可以直接继续点。"
      : "点击“合并&清理”，确认后这排按钮会原位变化。";

  el.timelineNote.classList.toggle("is-hidden", merging || merged);
  el.mergeNote.classList.toggle("is-hidden", !merging && !merged);
  el.mergeNote.classList.toggle("is-active", merging);
  el.mergeNoteTitle.textContent = merging ? "正在合并并清理" : "已安全合并到 main";
  el.mergeNoteText.textContent = merging ? "锁定 main 前后 commit，删除任务 worktree 与分支" : "main@8f41c2d · 原任务 worktree 与分支已清理";
  el.mergeNoteTime.textContent = merging ? "进行中" : "14:34";
  el.reviewNote.classList.toggle("is-hidden", !reviewing && !failed && !passed);
  el.reviewNote.classList.toggle("is-active", reviewing);
  el.reviewNote.classList.toggle("is-failed", failed);
  el.reviewNoteTitle.textContent = reviewing ? "正在审查已合并结果" : failed ? "基线审查发现问题" : "基线审查通过";
  el.reviewNoteText.textContent = reviewing ? "main@8f41c2d · 临时 detached worktree" : failed ? "P1 · 已合并状态保持不变" : "构建、测试与真实点检全部通过";
  el.reviewNoteTime.textContent = reviewing ? "进行中" : "14:46";

  el.workflowStatus.textContent = reviewing ? "审查中" : failed ? "需要处理" : passed ? "已通过" : merged ? "已合并" : merging ? "合并中" : "等待操作";
  el.workflowStatus.className = reviewing || merging ? "is-active" : failed ? "is-failed" : merged ? "is-done" : "";
  setTimelineItem(el.inspectorMerge, merging ? "is-active" : merged ? "is-done" : "", merged ? "✓" : merging ? "↗" : "2");
  el.inspectorMergeText.textContent = merging ? "正在锁定 commit 并清理" : merged ? "main@8f41c2d · 已清理" : "尚未开始";
  el.inspectorMergeTime.textContent = merged ? "14:34" : merging ? "进行中" : "—";
  setTimelineItem(el.inspectorReview, reviewing ? "is-active" : failed ? "is-failed" : passed ? "is-done" : "", reviewing ? "⌕" : failed ? "!" : passed ? "✓" : "3");
  el.inspectorReviewText.textContent = reviewing ? "正在检查最终集成状态" : failed ? "发现 1 个问题" : passed ? "最终集成验证通过" : "合并后可手动发起";
  el.inspectorReviewTime.textContent = reviewing ? "进行中" : failed || passed ? "14:46" : "—";

  el.snapshotPanel.classList.toggle("is-hidden", !merged);
  el.reviewPanel.classList.toggle("is-hidden", !reviewing && !failed && !passed);
  el.reviewRunning.classList.toggle("is-hidden", !reviewing);
  el.reviewSim.classList.toggle("is-hidden", !reviewing);
  el.resultBox.classList.toggle("is-hidden", !failed && !passed);
  el.resultBox.classList.toggle("is-passed", passed);
  el.failureActions.classList.toggle("is-hidden", !failed);
  el.reviewPanelStatus.textContent = reviewing ? "运行中" : failed ? "未通过" : "已通过";
  el.reviewPanelStatus.className = reviewing ? "is-active" : failed ? "is-failed" : "is-done";
  el.reviewPanelSubtitle.textContent = reviewing ? "Codex · main@8f41c2d" : failed ? "第 1 轮 · 发现问题" : "第 1 轮 · 审查通过";
  if (passed) {
    el.resultMark.textContent = "✓";
    el.resultTitle.textContent = "最终集成状态符合预期";
    el.resultText.textContent = "构建、测试和浏览器真实点检全部通过。";
  } else {
    el.resultMark.textContent = "!";
    el.resultTitle.textContent = "发现 1 个问题";
    el.resultText.textContent = "合并后的清理入口仍引用已删除的任务 worktree。";
  }
  el.reviewCount.textContent = failed || passed ? "2" : "1";
  if (merging || state === "ready") setGuide(0); else if (merged) setGuide(1); else setGuide(2);
}

function reset() {
  clearTimeout(mergeTimer);
  state = "ready";
  previewOpen = false;
  reviewTarget = "product";
  el.fixPanel.classList.add("is-hidden");
  closeDialog(el.mergeDialog);
  closeDialog(el.reviewDialog);
  render();
}

el.mergeButton.addEventListener("click", () => openDialog(el.mergeDialog));
el.previewButton.addEventListener("click", () => { previewOpen = !previewOpen; render(); showToast(previewOpen ? "预览已打开" : "预览已关闭"); });
el.reviewButton.addEventListener("click", () => {
  reviewTarget = ["merged", "failed", "passed"].includes(state) ? "baseline" : "product";
  el.reviewDialogTitle.textContent = reviewTarget === "baseline" ? "审查已合并结果" : "派审查";
  el.reviewDialogCopy.textContent = reviewTarget === "baseline" ? "选择审查者，验证合并到基线后的最终集成状态。" : "选择审查者、检查类型和自动复审次数。";
  el.targetTitle.textContent = reviewTarget === "baseline" ? "合并后基线快照" : "任务 worktree";
  el.targetDetail.textContent = reviewTarget === "baseline" ? "main@8f41c2d · detached" : "harness/GctxgEbq";
  openDialog(el.reviewDialog);
});
$("#confirmMerge").addEventListener("click", () => {
  closeDialog(el.mergeDialog);
  state = "merging";
  render();
  mergeTimer = setTimeout(() => { state = "merged"; previewOpen = false; render(); showToast("合并&清理完成；“派审查”已变成“审查已合并结果”"); }, 1100);
});
$("#confirmReview").addEventListener("click", () => {
  closeDialog(el.reviewDialog);
  if (reviewTarget === "product") { showToast("已启动合并前产物审查；请重置后按演示步骤体验合并后审查"); return; }
  state = "reviewing";
  render();
  showToast("已在 main@8f41c2d 的临时 worktree 启动审查");
});
$("#failReview").addEventListener("click", () => { state = "failed"; render(); });
$("#passReview").addEventListener("click", () => { state = "passed"; render(); });
$("#retryReview").addEventListener("click", () => { state = "reviewing"; render(); });
$("#createFix").addEventListener("click", () => { el.fixPanel.classList.remove("is-hidden"); showToast("已基于 main@8f41c2d 创建修复任务 FIX-204"); });
$("#showSnapshot").addEventListener("click", () => { el.snapshotPanel.scrollIntoView({ behavior: "smooth", block: "center" }); showToast("已定位到基线审查快照"); });
el.snapshotChip.addEventListener("click", () => el.snapshotPanel.scrollIntoView({ behavior: "smooth", block: "center" }));
$("#resetDemo").addEventListener("click", reset);
$$('[data-close]').forEach((button) => button.addEventListener("click", () => closeDialog(button.closest(".dialog-layer"))));
$$('.dialog-layer').forEach((layer) => layer.addEventListener("click", (event) => { if (event.target === layer) closeDialog(layer); }));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") $$('.dialog-layer:not(.is-hidden)').forEach(closeDialog); });

render();
