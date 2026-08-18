# 在开发机上改，在那台 Windows 上测

Windows 相关的代码有一批在 macOS 上**验不了**：`resolveLaunch` 的 PATHEXT / cmd.exe 引号规则、
路径边界的 NTFS 大小写、注册表里的默认应用、ConPTY。伪造 `process.platform` 能走到分支，但走不到
真实的系统行为。这套脚本把「改」和「测」拆到两台机器上：开发机改，`192.168.1.187` 那台真 Windows 跑。

```
node scripts/win-remote.mjs doctor              # 两端体检
node scripts/win-remote.mjs sync                # 把当前工作区(含未提交)送过去
node scripts/win-remote.mjs exec "<powershell>" # 在对端 worktree 里跑一条命令
node scripts/win-remote.mjs test win-launch     # sync + 跑指定回归(可多条)
node scripts/win-remote.mjs test --all          # 跑三条 Windows 专属回归
node scripts/win-remote.mjs test x --no-sync    # 跳过同步,重跑上次那份代码
```

环境变量:`WIN_REMOTE_HOST`(默认 `http://192.168.1.187:4317`)、`WIN_REMOTE_SELF`(本机对外 IP,
自动探测不准时用)、`WIN_REMOTE_PROJECT`(对端项目 id)。

## 它是怎么通的

那台机器只有两个入站端口:445(SMB,要凭证)和 4317(harness 自己)。装 OpenSSH Server 要点 UAC，
无人值守时点不动 —— 所以**通道就是 harness 自己的终端 API**,不需要在 Windows 上装任何东西、
也不需要管理员权限。

```
开发机                                          Windows 192.168.1.187
  git daemon :9418  ──── 对端 fetch 快照 ───▶   .worktrees/win-remote
  终端 API 调用      ──── POST 一条命令 ─────▶   ConPTY + pwsh
  一次性 HTTP :随机  ◀─── PUT 输出+退出码 ────   命令的真实 stdout/stderr
```

三个地方值得知道为什么:

**输出不从 PTY 读。** PTY 回的是**终端画面**不是程序输出 —— 命令被回显、PSReadLine 插灰色建议、
超过 cols 的行被硬折、满屏 ANSI。实测拿它当结果解析,连 `node -v` 都能切出半行命令文本。所以 PTY
只当触发器,真实输出重定向到 Windows 本地临时文件,再由 Windows 主动 PUT 回开发机起的一次性 HTTP
服务(反向连通实测可行)。命令本身走 base64 传,省掉引号/花括号/换行的转义。

**同步的是工作区快照,不是 HEAD。** 调 Windows 功能时改一行就想看结果,要求先 commit 太别扭。
用一个临时 `GIT_INDEX_FILE` 做 `read-tree` + `add -A` + `write-tree` + `commit-tree`,造出一个
不进任何分支的游离提交挂在 `refs/win-remote/head` 上 —— 未提交的改动和新增文件都在里面,而你的
分支、index、stash 全程没被碰过。传输走临时只读 `git daemon`(只在 sync 那几秒活着),不经 GitHub。

**落到对端的 `.worktrees/win-remote`,绝不动它的主工作区。** 那台机器上的 `D:\ai_workspace\ash`
是**正在跑着的 harness 自己**,而且有未提交的本地改动。往那儿 checkout 等于既覆盖别人的活、又把
live 服务的源码换掉。放在主仓内部还白捡一个好处:Node 解析 node_modules 会逐级向上,worktree 里
不装依赖也能跑。唯一要补的是 `node_modules/@harness/*` 的 junction —— 不补的话 `@harness/shared`
会解析到**主仓那份**,于是你改了 shared 却测的是旧代码。

## 两个边界

**通道跑在被测的 harness 里。** 改了 server 代码想看真实行为(而不是测试结果),得重启对端 harness ——
那会连着把这条通道一起掐了。所以默认路线是跑回归测试:它们是独立进程,不需要重启对端服务。

**`exec` 的完成判据是进程退出,不是管道 EOF。** 早先版本用 `<cmd> *>&1 | Out-File`,而管道要等
**所有**持有 stdout 的句柄关闭才算完 —— Windows 上留一个孙进程是常事(见下面 node-pty 那条),
于是 `test:terminal` 明明 exit 0,却挂满 10 分钟报假超时。现在用 `Start-Process` + `Wait-Process
-Timeout` + `Kill()`,跟残留句柄无关,超时也能把已写下的输出捞回来。代价是 stdout/stderr 分开重定向
(`Start-Process` 不许两路指向同一个文件),所以 stderr 拼在输出末尾的 `--- stderr ---` 之后,
而不是按时间交错。
