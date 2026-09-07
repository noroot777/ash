# 新建任务写作台 · 正式组件实现

2026-09-07

已将获认可的 `new-task-studio.html` 视觉方案接入 `TaskComposerPanel`，仍由主工作区原有的新建入口展示。本轮没有替换正在运行的主实例，也没有合并任务分支。

## 实现

- 沿用项目字体、主题变量、按钮与三段执行器选择器；将目标编辑、附件、配置摘要、启动方式组织在同一张卡片内。
- 执行安排拆成“谁来做 / 在哪里做 / 如何交付”，一次展开一块。嵌套选择器与收起动作复用现有 Esc 和焦点恢复机制。
- 单任务、团队、讨论沿用原有状态和提交逻辑；起手式继续使用真实工作流编辑器及生效执行器配置。
- 分组与标签折叠展示；模板追加到原正文，不覆盖输入。保留上传进度、取消上传、定时创建和提交门禁。
- 修复新布局下旧窄屏样式隐藏分组、分支设置的问题。拆出目标编辑组件，使主组件保持在 700 行以内。
- 按参考图移除正文区上方重复的“新建任务”眉题；“谁来做”摘要现在直接展示生效供应商、模型和智能水平，跟随默认时也解析执行器与供应商的具体配置。

## 验证

- `npm -w web run typecheck`：通过。
- `npm -w web run test:composer-studio`：通过。覆盖模式切换、单面板展开、嵌套 Esc、焦点恢复、worktree 摘要与提交、团队审查、讨论闸门、模板追加、定时门禁、分组可见性、320/390/700/900 宽度无页面横向溢出、起手式生效执行器与模型提交。
- `npm -w web run build`：通过全部构建前置回归、TypeScript 和 Vite 生产构建。一次运行中既有 notes-upload 测试出现时序断言失败；未改动该模块，完整重跑通过。Vite 仍提示较大 bundle，不影响构建成功。
- 使用 Vite 启动真实 React 组件测试页，API 由测试替身响应；没有向用户真实项目创建测试任务。不是静态 HTML demo 截图，也不代表已验证生产后端全链路。
- 浏览器降级：具名会话“🎯 按图调整验证”尝试创建后台扩展标签时再次返回 `Capability is not available: visibility`，因此使用临时 profile 的独立 headless Chromium。未启用有头模式，未接管或激活用户普通标签。测试结束关闭浏览器和临时服务。
- 初始工作区缺失 Node 类型依赖；通过锁文件离线 `npm ci --ignore-scripts --offline` 恢复，未修改依赖版本或锁文件。

## 实际组件截图

- [桌面](../../output/playwright/composer-studio-desktop.png)
- [团队执行配置](../../output/playwright/composer-studio-team.png)
- [手机宽度](../../output/playwright/composer-studio-mobile.png)
