# Windows 服务卡死与重启失败取证（2026-10-23）

## 现场

目标是 `192.168.1.187` 上的 `D:\ai_workspace\ash`，端口 `4317`。

- TCP 连接成功，但 `/api/health` 和 `/api/projects` 一直不返回 HTTP 响应；LAN 和 Tailscale 两条路径表现相同。
- 监听者是 PID `12280`，命令为 `node server/dist/index.js`，并非服务已经退出。
- 进程于北京时间 16:07:17 启动，单实例锁最后一次心跳是 22:16:04.582，此后事件循环不再推进。
- Git 显示 1,922 个未暂存的删除，没有其他文件修改或暂存区改动。`shared`、`server`、`web`、`mcp` 都是真实空目录，不是链接。
- 四个目录的最后修改时间集中在 22:15:35–22:15:36，`node_modules` 在 22:15:38；依赖目录也有文件残缺。第一次 `npm install` 返回成功，后续编译仍发现依赖自己的类型声明丢失，说明成功安装不等于修复了所有存量包内容。

## 这次卡死的原因

通过既有 RustDesk 连接的独立终端取证，绕过已经不能响应的 ash 终端 API。
使用 Windows 自带的线程与 DbgHelp 接口读取主线程原生栈，读取结束后恢复线程：

```text
ntdll.dll       ZwFsControlFile
KERNELBASE.dll  ConnectNamedPipe
conpty.node
node.exe
```

`node-pty` 的 Windows 终端构造函数在主线程同步连接命名管道。输出 worker 无法启动时，
原生 `ConnectNamedPipe` 不会返回；JS 的异常处理器和定时器都没有执行机会，连健康检查也一起卡住。
现场发生过源码和依赖文件删除；Windows 故障注入进一步验证：复制一份 `node-pty`、仅删除副本的
`lib/worker/conoutSocketWorker.js`，即可重现终端构造永久等待。

这解释了本次“进程还在、页面却像服务停了”的机制。现有证据没有确定是谁删除了目录，
也不足以把此前几次真正退出全部归为同一个原因。旧退出账本只有残留锁、没有对应退出意向；
系统中的 `RADAR_PRE_LEAK_64` 也不是某次致命崩溃的证明。

## 修复

### Windows 终端隔离

- Windows 的 `node-pty` 构造、输入、缩放和关闭在独立 Node 子进程执行，主服务通过 IPC 收发。
- 启动有 10 秒期限；worker 丢失、提前退出或原生调用不返回时，创建请求明确失败，不再冻结 HTTP 服务。
- 超时或关闭兜底只清理本次终端子进程树。正常 shell 退出保留原退出码，退出事件只发一次。
- 异步创建完成后再次检查项目删除态和服务关闭态，避免等待期间生成无主会话。
- POSIX 继续使用原来的终端与进程组管理，不改变其交互 shell 和后台作业清理语义。

### 空 workspace 恢复

`npm restart` 的依赖同步前增加了 Git 恢复步骤：目录缺失或完全为空、HEAD 中有合法清单、
暂存区与该提交一致时，只恢复对应 workspace 的工作区文件，不改变暂存区。
已有文件、目录链接、稀疏检出、暂存区改动和非 Git 解包都不自动覆盖。

### 真机处理

先核对 Git 状态，恢复四个空源码目录，保留数据和配置。依赖损坏并不只限于缺少清单，
因此将旧依赖目录移到本次修复的备份位置，再通过干净安装重建依赖。
停止卡死服务时只针对核对过身份的 PID `12280`，没有批量结束 Node 或顺带杀掉其他执行者。

补丁先经局域网送入独立 detached worktree 测试，然后用于正式服务。
整个过程不通过 GitHub 中转，也没有接管用户的浏览器标签。

## 回归覆盖

- macOS：`npm run test:restart`、`npm -w server run test:terminal`、服务端 TypeScript 检查。
- Windows：空 workspace 恢复、真实重启脚本、终端 IPC、输入/缩放/退出和启动超时回收。
- Windows 原生故障注入：损坏的是临时依赖副本；缺失输出 worker 时仍有主事件循环心跳，隔离进程被回收。

## 正式恢复结果

- 2026-10-23 北京时间 23:05:45，正式仓库的 `npm restart` 返回 `0`；shared、web、server、mcp 全部构建成功。
- 新服务 PID 为 `18284`，本机和局域网的 `/api/health` 都返回 `ok: true`，项目列表也恢复响应。
- 再通过恢复后的 ash 终端 API 创建会话，执行健康检查和 `node -v`，实际收到
  `ASH_WINDOWS_TERMINAL_OK`、健康 JSON 和 `v22.20.0`，随后删除测试会话。
- 23:13:53 再次检查，仍由同一 PID 正常响应。旧依赖备份和本次 detached 测试 worktree
  已清理；删除前先摘除目录 junction，没有递归穿入工作区源码或现用依赖。
- 本次没有修改 `mcp/`，重启时使用 `SKIP_MCP=1`，避免打断已有执行器的 MCP 会话。
- 仍未确认目录删除者，以及更早真正退出事件的最终原因；本次交付修复的是已经取证并复现的
  Windows 终端卡死机制和空 workspace 导致的重启阻断，不将这两点扩写为所有历史停服的定论。

原始取证输出保存在本次开发机的 `/tmp/ash-win-4rYBbeOE0-XN-*` 文件中，包含原生栈和测试输出；
这些原始机器日志不进入 Git。
