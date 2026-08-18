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
自动探测不准时用)、`WIN_REMOTE_PROJECT`(对端项目 id,自动按 `repoPath` 猜歪了时用;给了不存在的
id 会把现有项目列出来)、`WIN_REMOTE_GIT_PORT`(钉死 git daemon 端口,默认每次现挑一个空闲的)。

## 它是怎么通的

那台机器只有两个入站端口:445(SMB,要凭证)和 4317(harness 自己)。装 OpenSSH Server 要点 UAC，
无人值守时点不动 —— 所以**通道就是 harness 自己的终端 API**,不需要在 Windows 上装任何东西、
也不需要管理员权限。

```
开发机                                          Windows 192.168.1.187
  git daemon :随机   ──── 对端 fetch 快照 ───▶   .worktrees/win-remote
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
不进任何分支的游离提交,挂在一个**按次唯一**的 `refs/win-remote/snap-<随机>` 上 —— 未提交的改动和
新增文件都在里面,而你的分支、index、stash 全程没被碰过。传输走临时只读 `git daemon`(只在 sync
那几秒活着,端口也是每次现挑的空闲端口),不经 GitHub。ref 和端口都按次唯一是**正确性**要求而不是
洁癖:共享一个固定 ref 时,两次调用交错会让 A 拉到 B 的快照,而 A 照样把结果记在自己的改动名下。
同步完还会核对**完整** SHA,对端不是这份快照就当场中止,不往下跑测试。

两边的 ref 都是用完就删,而且删在 `finally` 里:开发机那份好办,对端那份要注意 checkout 失败、
junction 修不好、校验没过这些**中途 throw** 的路径 —— 它们发生时 fetch 已经成功,ref 已经落在
Windows 仓库里了。快照带着未提交和未跟踪的内容,留在那儿既攒垃圾,也可能把你随后从工作区删掉的
临时凭据一直存着,所以远端脚本整个包在 `try/finally` 里,失败路径也删。

**落到对端的 `.worktrees/win-remote`,绝不动它的主工作区。** 那台机器上的 `D:\ai_workspace\ash`
是**正在跑着的 harness 自己**,而且有未提交的本地改动。往那儿 checkout 等于既覆盖别人的活、又把
live 服务的源码换掉。放在主仓内部还白捡一个好处:Node 解析 node_modules 会逐级向上,worktree 里
不装依赖也能跑。唯一要补的是 `node_modules/@harness/*` 的 junction —— 不补的话 `@harness/shared`
会解析到**主仓那份**,于是你改了 shared 却测的是旧代码。「缺了就建」不够:junction **在**、却指着
主仓是同一个坑更隐蔽的那一半 —— fetch、checkout、完整 SHA 校验全绿,`import '@harness/shared'`
拿到的仍是主仓旧代码,一个全部通过的假绿。所以每次同步都把四个 junction 的实际目标读出来回传,
**和 SHA 一样算成功判据**:指错了就先删链接本体(只删链接,`Remove-Item -Recurse` 会穿过 junction
去删目标目录)再重建;位置上蹲着的是真目录/真文件就直接中止报错,不替用户做主删东西。

**远端不留明文。** 每条远程命令在对端落成 `%TEMP%\<token>.ps1`(完整明文脚本)+ `.out`/`.err`。
现在的顺序是**先删这三个文件,再把结果从内存里发回来** —— 开发机收到回传时对端磁盘上已经一个
token 文件都没有,原先「删文件 vs 开发机随手关掉终端会话」的竞争从根上不存在。wrapper 开头另有
一次自扫:同格式、一小时以上没动过的残留一并删掉,兜住脚本中途崩掉/断电/会话被掐这些走不到
删除那步的情况(一小时的门槛保证不会误伤正在跑的另一条命令,单条上限 10 分钟)。

**那个 worktree 是全局单份的,所以整段 sync+test 上锁。** 锁是对端的
`.worktrees\win-remote.lock`(`CreateNew` 原子创建),被占时最多等 2 分钟。锁里写着本次调用的
owner id,**locked 区间内每条命令都先核对**,易主就当场中止(而不是接着往一个已经被别人 checkout
过的工作区里写)。真要手工解锁,删掉那个文件即可。

过期与接管这块值得多说两句,因为它是唯一能凭空造出两个持有者的路径。25 分钟没心跳算过期、可被
接管,这条不能省:持锁进程在开发机上,它崩了、被 Ctrl-C 了,对端一无所知,没有过期就等于把那台
机器永久锁死。但接管**必须是原子的**,而且必须认「接管的还是我当初判定为过期的那一把」:两个
调用完全可能先后读到同一把过期锁,再各自动手。「覆盖 owner 再读回来认一次」不是 CAS —— 各自
读到的都是自己刚写的那份,于是双双自认接管成功,一起进临界区,「测到别人的快照」原样复活;换成
原子改名也不够,A 接管后重建了锁,晚两秒动手的 B 照样能把**新锁**移走。现在走的是真 CAS:拿
`FileShare::None` 的独占句柄(同一时刻只有一个人拿得到),在句柄里回读内容、确认还等于当初读到
的那份(owner 带随机 id + ISO 时间戳,不会 ABA),才就地改写成自己的 owner。

心跳也不能只在命令开头点一下。守卫只在每条命令开头核对一次 owner,一条 10 分钟的测试进了临界区
之后就再没人回头看它 —— 心跳停在开头,意味着「跑够 TTL 那么久的命令」会被别人**正当**接管,而它
自己还在往同一个 worktree 里写,恰好是这把锁要防的事。所以守卫顺手起一个 `Start-ThreadJob` 每
30 秒刷 mtime,跟着命令一路刷到结束(同进程另开线程,脚本一退它跟着没,不留孤儿进程;它自己也
核对 owner,锁真易主了就停手,别把别人的锁刷成还活着)。

## 两个边界

**通道跑在被测的 harness 里。** 改了 server 代码想看真实行为(而不是测试结果),得重启对端 harness ——
那会连着把这条通道一起掐了。所以默认路线是跑回归测试:它们是独立进程,不需要重启对端服务。

**`exec` 的完成判据是进程退出,不是管道 EOF。** 早先版本用 `<cmd> *>&1 | Out-File`,而管道要等
**所有**持有 stdout 的句柄关闭才算完 —— Windows 上留一个孙进程是常事(见下面 node-pty 那条),
于是 `test:terminal` 明明 exit 0,却挂满 10 分钟报假超时。现在用 `Start-Process` + `Wait-Process
-Timeout` + `Kill()`,跟残留句柄无关,超时也能把已写下的输出捞回来。代价是 stdout/stderr 分开重定向
(`Start-Process` 不许两路指向同一个文件),所以 stderr 拼在输出末尾的 `--- stderr ---` 之后,
而不是按时间交错。
