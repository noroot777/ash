## 六 范围外附加面(mcp / mobile)

这两个包的 `test:*` 不在用户声明的范围里(范围是 root/server/web),也不在验收门禁里,但它们确实存在、确实会被人跑到,所以一并真跑了一遍,单独成章。跑法同口径:各自独立临时 `ASH_DB`,`cwd` 取各包根目录。

| 包 | 脚本 | 结果 | 耗时 |
|---|---|---|---|
| mcp | `test:reconnect`(前置 `npm run build`) | 绿 | 8s |
| mcp | `test:read-transcript`(前置 `npm run build`) | 绿 | 1s |
| mobile | `test:project-path` | 绿 | 0s |
| mobile | `test:session-notices` | 绿 | 0s |
| mobile | `test:cli-capability` | 绿 | 0s |
| mobile | `test:markdown-inline` | 绿 | 1s |
| mobile | `test:monitor-strip` | 绿 | 9s |
| mobile | `test:task-branches` | 绿 | 9s |
| mobile | `test:web-smoke` | **红** | 0s |
| mobile | `test:reply-command-ui` | **红** | 41s |

合计 10 条,8 绿 2 红。两条红的归因:

**`mobile test:web-smoke` — 环境问题,不是缺陷。**
```
browserType.launch: Executable doesn't exist at
  ~/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/...
```
playwright 浏览器版本错位:缓存里装的是别的版本号。关键是它**没有走仓库自己那套浏览器解析**(`web/scripts/chrome-path.mjs`:先找系统 Chrome/Chromium/Edge,都没有才回落到 playwright-core 自带),而是直接 launch 默认 chromium。`web` 侧那十几条 playwright 测试在同一台机器上全都起得来,就是因为走了那个解析器。建议修法是让 mobile 侧复用 `chrome-path.mjs`(或等价地显式传 `executablePath`),而**不是**去跑 `playwright install` —— 那会再装一份浏览器,且下次版本号一变又错位。

**`mobile test:reply-command-ui` — 契约过时。**
```
locator.click: Timeout 30000ms exceeded.
  waiting for getByRole('button', { name: '打开任务：手机命令 empty', exact: true })
```
`exact: true` 的可访问名 `打开任务：手机命令 empty` 对不上了。`empty` 这个词看起来是把某个状态标记拼进了按钮名,这类"状态 + 标题"拼出来的可访问名一旦渲染逻辑改动就会整条失配,而 `exact: true` 让它一点容错都没有。建议并入 T16(同一类:web/mobile 的 UI 回归按可访问名定位,名字随渲染改动漂移)。
