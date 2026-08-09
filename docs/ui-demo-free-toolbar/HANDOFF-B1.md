# 自由工作流快捷操作 · B1 轻文字按钮 · 交接文稿

**状态**：设计已拍板，可直接实现

**方案代号**：B1（轻文字按钮）

**拍板人 / 日期**：用户 · 2026-08-09

**参考 demo**：`docs/ui-demo-free-toolbar/b2.html` → 锚点 `#b1`
**全方案对照**（历史）：`docs/ui-demo-free-toolbar/index.html`

---

## 1. 背景与决策

### 问题

自由工作流（`workflowMode === "free"`）任务详情页，回复框上方有「派审查 / 打开预览 / 合并&清理」快捷操作。现状是**书签 / 页签**形态：

- 与输入框边框咬合（`margin-bottom: -1px` + `border-bottom-color: panel`）
- 左上圆角被压平（`.task-reply-box { border-top-left-radius: 0 }`）
- 带色底图标方块 + 厚重描边条，视觉像浏览器 tab

用户反馈：**丑，且不喜欢书签式展示**。

### 决策路径

| 轮次 | 结论 |
|------|------|
| 第一轮 | 在 A–F 中选定 **B（悬浮芯片）**，放弃书签咬合 |
| 第二轮 | B0 间距偏远、色块徽章仍丑 → 在 B1/B2/B3 中选定 **B1 轻文字** |

### 最终方向（一句话）

> **无边框、无底、无色块徽章的轻文字按钮**，贴在输入框正上方 2px，输入框四角保持完整圆角。默认安静，悬停出浅底，busy/active 才带动作色。

**明确否决**：

- A 书签咬合
- B0 圆角胶囊 + 色底图标方块
- B2 浅底工具组（成组描边条）
- B3 细描边独立胶囊
- D 并入底栏、E 分段控件、F 纯图标轨

---

## 2. 范围

### 做

- 重做 **视觉与布局**（CSS 为主，TSX 去掉图标徽章壳）
- 保持现有 **业务逻辑、禁用条件、文案状态机、弹窗** 不变

### 不做

- 不改后端 / API / free-workflow 状态机
- 不改 `FreeReviewDialog`、`ConfirmDialog` 内容
- 不改 inspector「实际工作流」面板
- 不把按钮挪到底栏或输入框内部
- 不新增第四个动作（除非产品另开任务）

### 可见条件（保持不变）

仅在同时满足时渲染工具条（现逻辑，勿动）：

```
task.workflowMode === "free"
&& task.mode === "single"
&& !task.parentId
&& !task.reviewOf
```

挂载点：`TaskDetail` → `ReplyBox` 的 `topRail` prop。

---

## 3. 涉及文件

| 文件 | 改动 |
|------|------|
| `web-next/src/styles/free-workflow.css` | **主战场**：重写 toolbar 相关规则；修正 `has-top-rail` 对输入框圆角的破坏 |
| `web-next/src/free-workflow/FreeWorkflowToolbar.tsx` | 去掉 `free-workflow-action-icon` 包裹层；图标改更轻的 weight/size |
| `web-next/src/task-detail/ReplyBox.tsx` | **通常不用改**（仍渲染 `topRail` 在 `task-reply-box` 之前） |
| `web-next/src/task-detail/TaskDetail.tsx` | **不用改**（挂载条件已正确） |

demo 目录 `docs/ui-demo-free-toolbar/` 可保留作对照，实现时不必同步更新（可选：在 b2.html 顶部标「已拍板 B1」）。

---

## 4. 布局规格

```
┌─────────────────────────────────────────────┐  task-reply-shell
│  [⌕ 派审查]  [▶ 打开预览]  [⎇ 合并&清理]  [↗ 预览页?]   ← toolbar
│  ↕ 2px 间隙（margin-bottom: 2px），左缘与 reply-box 对齐（margin-left: 0）
│  ┌─────────────────────────────────────────┐
│  │  textarea…                              │  ← 四角圆角 12px 完整
│  │  📎 ⏱  [codex|model|effort]   ⌘↵…  [↑] │
│  └─────────────────────────────────────────┘
└─────────────────────────────────────────────┘
```

| 项 | 现状 | B1 目标 |
|----|------|---------|
| 与输入框关系 | 书签咬合（负 margin + 共享底边） | **分离**，`margin-bottom: 2px` |
| 输入框左上圆角 | 被压成 `0` | **恢复** 与其它角一致（12px） |
| toolbar 外框 | 有 border / 渐变底 / 圆角条 | **无** 外框、无背景、无阴影 |
| 按钮间距 | 容器内 `gap: 2px` | 按钮间 `gap: 1px`（几乎贴齐，靠 padding 区分点击区） |
| 左对齐 | 大致贴左 | 与 `task-reply-box` 左缘对齐（`margin-left: 0`） |
| shell 顶部留白 | `has-top-rail { padding-top: 8px }` | 可保留 6–8px，避免贴到会话底部分割线即可 |

### 必须删除的「书签」配套

```css
/* 删除或改掉这些效果 */
.task-reply-shell.has-top-rail .task-reply-box { border-top-left-radius: 0; }
/* 以及 mobile 里把 box 改成「只有下圆角」的规则 */
.task-reply-shell.has-top-rail .task-reply-box { border-radius: 0 0 12px 12px; }
```

`has-top-rail` 类可以保留（若还需要微调 shell 上 padding），但**不得再改 reply-box 圆角**。

---

## 5. 按钮视觉规格

### 结构（每个动作）

```tsx
<button type="button" className="is-review" data-state="…" disabled={…}>
  <Icon size={13} weight="regular" />   {/* 不要再包 free-workflow-action-icon */}
  <span>派审查</span>
</button>
```

- **去掉** `<span className="free-workflow-action-icon">` 整层（色底方块来源）
- 图标直接作为 button 的子节点；产品已用 `@phosphor-icons/react`，继续用，**不要**换成 demo 里的手写 SVG（demo 只是示意）

### 图标映射（逻辑不变，仅规格）

| 动作 | idle | busy | active/其它 |
|------|------|------|-------------|
| 审查 | `MagnifyingGlass` | `SpinnerGap` + `is-spinning` | repairing 时仍用 `MagnifyingGlass`（或保持现状） |
| 预览 | `MonitorPlay` | `SpinnerGap` | running → `StopCircle` |
| 合并 | `GitMerge` | `SpinnerGap` | merged 文案变，图标可仍 `GitMerge` |
| 外链 | `ArrowSquareOut` | — | 预览 running 且有 url 时显示 |

- 尺寸：**13–14px**（推荐 13）
- weight：由 `bold` 改为 **`regular` 或 `duotone` 不要**；默认 **regular**
- 默认图标 `opacity: 0.72`，hover/active 回 1（CSS 控）

### 尺寸与排版

| 属性 | 值 |
|------|-----|
| height | `26px` |
| padding | `0 8px` |
| gap（icon–text） | `5px` |
| font-size | `11px` |
| font-weight | `600` |
| letter-spacing | `-0.01em` |
| border-radius | `7px` |
| border | `0` |
| 默认 background | `transparent` |
| 默认 color | `var(--muted)` |

### 状态色

默认 **不带动作色**（审查/预览/合并 idle 时都是 muted）。色只在 hover 轻微、busy/active 明确。

| 状态 | 样式 |
|------|------|
| **idle** | 透明底 + `var(--muted)`；icon opacity 0.72 |
| **hover**（enabled） | `background: color-mix(in lch, var(--raised) 85%, var(--panel))`；`color: var(--ink)`；icon opacity 1。**不要**默认 hover 就上 accent/cyan/green |
| **focus-visible** | `outline: 2px solid color-mix(in lch, var(--accent) 48%, transparent); outline-offset: 1px`（相对现状可略外移，因无外框） |
| **disabled** | `opacity: 0.38`；`cursor: not-allowed`；无 hover 变化 |
| **busy / active · 审查** | `color: var(--accent)`；`background: color-mix(in lch, var(--accent) 8%, transparent)` |
| **busy / active · 预览** | `color: var(--cyan)`；`background: color-mix(in lch, var(--cyan) 8%, transparent)`；`aria-pressed="true"` 时同 active |
| **busy / active · 合并** | `color: var(--green)`；`background: color-mix(in lch, var(--green) 8%, transparent)` |

选择器建议与现有属性对齐，少造新 class：

```css
/* busy/active 可继续吃这些钩子 */
button.is-review[data-state="reviewing"],
button.is-review[data-state="repairing"] { …accent… }

button.is-preview[aria-pressed="true"],
button.is-preview:disabled/* 仅 previewBusy 时另加 class 或 */ { … }

/* previewBusy / mergeBusy 没有 data-state 时：
   实现上可给 button 加 is-busy class，或用 :has(.is-spinning) —— 推荐显式 is-busy 更稳 */
```

**推荐**：TSX 在 busy 时给 button 加 `is-busy`（previewBusy / mergeBusy / reviewing spinner 均可），CSS：

```css
.free-workflow-toolbar button.is-busy { /* 与 active 同系 */ }
```

### 「预览页」外链

保留现逻辑：预览 running 且有 url 时显示。样式跟 B1 气质对齐：

- 不要左边粗竖分割线的「附录感」可弱化：改用与按钮相同的 ghost 高度，前缀图标 `ArrowSquareOut`，字「预览页」
- color 默认 `var(--cyan)` 或 `var(--muted)` 悬停转 ink；**不要**再 `border-left` 硬切一段

### 窄屏（≤800px）

| 现状 | B1 |
|------|-----|
| toolbar `width:100%`，按钮 `flex:1` | 可保留「均分」**或** 保持 `width: max-content` 左对齐换行；**推荐** `flex-wrap: wrap; width: 100%` + 按钮不再强制 flex:1（轻文字均分会显得空） |
| 隐藏外链 `> a` | 可继续隐藏，或保留为 ghost 文字——实现任选，优先**继续隐藏**以减噪 |
| 压扁 reply-box 圆角 | **禁止** |

---

## 6. 建议 CSS 替换稿

把 `free-workflow.css` 里 toolbar 段（约 L6–L21 与 media 里 toolbar 相关）换成下面意图；token 名以项目 `:root` 为准（`--muted` / `--ink` / `--raised` / `--panel` / `--accent` / `--cyan` / `--green` / `--line`）。

```css
/* topRail 仅保留轻微上内边距；不再破坏输入框圆角 */
.task-reply-shell.has-top-rail { padding-top: 6px; }
/* 删除：.task-reply-shell.has-top-rail .task-reply-box { border-top-left-radius: 0; } */

.free-workflow-toolbar {
  position: relative;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  width: max-content;
  max-width: 100%;
  align-items: center;
  gap: 1px;
  margin: 0 0 2px;          /* 贴边 */
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  overflow-x: auto;
}

.free-workflow-toolbar button {
  position: relative;
  display: inline-flex;
  height: 26px;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  padding: 0 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: -0.01em;
  transition: background 0.12s ease, color 0.12s ease;
}

.free-workflow-toolbar button svg {
  flex: 0 0 auto;
  opacity: 0.72;
}

.free-workflow-toolbar button:hover:not(:disabled) {
  background: color-mix(in lch, var(--raised) 85%, var(--panel));
  color: var(--ink);
}

.free-workflow-toolbar button:hover:not(:disabled) svg {
  opacity: 1;
}

.free-workflow-toolbar button:focus-visible,
.free-workflow-toolbar > a:focus-visible {
  outline: 2px solid color-mix(in lch, var(--accent) 48%, transparent);
  outline-offset: 1px;
}

.free-workflow-toolbar button:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

/* busy / active：分动作上色 */
.free-workflow-toolbar button.is-review.is-busy,
.free-workflow-toolbar button.is-review[data-state="reviewing"],
.free-workflow-toolbar button.is-review[data-state="repairing"] {
  color: var(--accent);
  background: color-mix(in lch, var(--accent) 8%, transparent);
}
.free-workflow-toolbar button.is-preview.is-busy,
.free-workflow-toolbar button.is-preview[aria-pressed="true"] {
  color: var(--cyan);
  background: color-mix(in lch, var(--cyan) 8%, transparent);
}
.free-workflow-toolbar button.is-merge.is-busy,
.free-workflow-toolbar button.is-merge[data-state="merged"],
.free-workflow-toolbar button.is-merge[data-state="merging"] {
  color: var(--green);
  background: color-mix(in lch, var(--green) 8%, transparent);
}

.free-workflow-toolbar button.is-busy svg,
.free-workflow-toolbar button[data-state="reviewing"] svg,
.free-workflow-toolbar button[data-state="repairing"] svg,
.free-workflow-toolbar button[aria-pressed="true"] svg,
.free-workflow-toolbar button[data-state="merged"] svg {
  opacity: 1;
}

/* 预览外链：与 ghost 按钮同高，无左边竖线 */
.free-workflow-toolbar > a {
  display: inline-flex;
  height: 26px;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  margin-left: 2px;
  border: 0;
  border-radius: 7px;
  padding: 0 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.free-workflow-toolbar > a:hover {
  background: color-mix(in lch, var(--raised) 85%, var(--panel));
  color: var(--ink);
}

/* 删除 .free-workflow-action-icon 及其分色规则（TSX 也不再渲染） */

@media (max-width: 800px) {
  .free-workflow-toolbar {
    width: 100%;
    /* 不要再设 border-radius 书签形 */
  }
  .free-workflow-toolbar > a {
    display: none;
  }
  /* 删除：.task-reply-shell.has-top-rail .task-reply-box { border-radius: 0 0 12px 12px; } */
}
```

> 上稿是**意图规格**，合并进文件时注意：同文件后半段 inspector / review dialog 样式勿误删。

---

## 7. TSX 改动要点

文件：`web-next/src/free-workflow/FreeWorkflowToolbar.tsx`

### 保持不变

- 全部 `disabled` 条件
- `togglePreview` / `merge` / dialog 开关
- 文案状态机：

| 按钮 | 文案 |
|------|------|
| 审查 | idle「派审查」/ reviewing「审查中」/ repairing「等待修复」 |
| 预览 | idle「打开预览」/ busy「处理中」/ running「关闭预览」 |
| 合并 | idle「合并&清理」/ merged「已合并清理」（busy 时可「合并中」——现状未单独写合并中文案，**可保持现状**只转 spinner） |

### 建议改动

1. 去掉三处 `free-workflow-action-icon` 包裹，图标直出。
2. 图标 `size={13}` 或 `14`，`weight="regular"`（Spinner 可 `bold` 更易辨认）。
3. busy 时给对应 button 加 `className` 含 `is-busy`（审查 reviewing 也可加，方便 CSS）。
4. 外链 `<a>` 结构可简化为图标 + 文字，与按钮同级 ghost。

示意（审查按钮）：

```tsx
<button
  type="button"
  className={`is-review${activeReview?.status === "reviewing" ? " is-busy" : ""}`}
  data-state={activeReview?.status ?? "idle"}
  disabled={!taskReady || taskBusy || mergeStarted || !!activeReview}
  onClick={() => setReviewOpen(true)}
>
  {activeReview?.status === "reviewing"
    ? <SpinnerGap size={13} className="is-spinning" />
    : <MagnifyingGlass size={13} weight="regular" />}
  <span>
    {activeReview?.status === "reviewing"
      ? "审查中"
      : activeReview?.status === "repairing"
        ? "等待修复"
        : "派审查"}
  </span>
</button>
```

预览 / 合并同理。

---

## 8. 验收清单

实现者自测（free 模式、single、非子任务、非 reviewOf）：

- [ ] **无书签**：toolbar 与输入框之间有约 2px 缝，输入框四角圆角完整
- [ ] **默认安静**：三按钮无边框、无底、无彩色方块；字色 muted
- [ ] **hover**：浅底 + ink，不默认整钮变紫/青/绿
- [ ] **禁用**：任务 running/queued、未 ready、审查进行中、已合并等条件与改前一致
- [ ] **派审查**：可开 `FreeReviewDialog`；reviewing 显示 spinner +「审查中」+ accent 浅底
- [ ] **预览**：开/关 API 仍通；running 时 `aria-pressed`、文案「关闭预览」、cyan 浅底；有 url 时外链可用
- [ ] **合并**：确认框与合并 API 不变；merged 后禁用 +「已合并清理」
- [ ] **窄屏**：不出现「上圆角被削成只有下圆角」的盒子；不回书签条
- [ ] **键盘**：Tab 能聚焦，focus-visible 环可见
- [ ] 非 free / team / 子任务 / reviewOf：**不渲染** toolbar

视觉对照：打开 `docs/ui-demo-free-toolbar/b2.html#b1`，产品与 B1 气质一致即可，不必像素级复制 demo 字体。

---

## 9. 风险与注意

1. **可发现性**：B1 最素，首次可能略「不像按钮」。这是拍板取舍；**不要**为了可发现性又加回色块徽章或外框条。若上线后反馈「找不到」，另开迭代（可考虑 B2），本任务不预埋双样式开关。
2. **`has-top-rail` 副作用**：只清圆角相关规则，别误删 `ReplyBox` 对 `topRail` 的 DOM 顺序（toolbar 必须在 `task-reply-box` **上面**）。
3. **不要动** inspector / review dialog 大段 CSS。
4. **合并是破坏性操作**：文案保留完整「合并&清理」，不要缩成「合并」或纯图标。

---

## 10. 参考资产

| 路径 | 用途 |
|------|------|
| `docs/ui-demo-free-toolbar/b2.html` `#b1` | **实现对照的视觉真源** |
| `docs/ui-demo-free-toolbar/b2.css` `.fw-ghost` / `.gbtn` | demo 样式，可抄意图勿整文件 import |
| `docs/ui-demo-free-toolbar/index.html` | 历史方案对照，非实现目标 |
| `web-next/src/free-workflow/FreeWorkflowToolbar.tsx` | 行为真源 |
| `web-next/src/styles/free-workflow.css` | 样式落点 |

---

## 11. 交付定义（DoD）

1. 产品 UI 符合第 4–5 节规格与第 8 节清单
2. 无书签咬合、无色底图标方块
3. 行为与改前一致（含 disabled 与弹窗）
4. 本交接文稿路径保持可追溯：`docs/ui-demo-free-toolbar/HANDOFF-B1.md`

---

*文稿结束。实现时按本文落地即可，无需再等设计确认；若实现中发现与 free-workflow 状态字段冲突，以 `FreeWorkflowToolbar.tsx` 现有状态机为准，只调样式钩子。*
