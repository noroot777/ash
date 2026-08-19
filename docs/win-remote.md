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
id 会把现有项目列出来)、`WIN_REMOTE_GIT_PORT`(钉死 git daemon 端口,默认每次现挑一个空闲的)、
`WIN_REMOTE_WORKSPACE`(换个对端目录,默认 `.worktrees/win-remote`)、`WIN_REMOTE_ADOPT=1`(接管一个
不是本工具建的 worktree —— 会覆盖里面所有未提交内容,见下面「只清自己的目录」)、
`WIN_REMOTE_CONTROL_TIMEOUT`(控制面单跳的兜底期限,默认 15000ms)。

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

**每次同步都把那个 worktree 清回快照的样子。** 它是跨所有调用复用的固定目录,而
`checkout --force` 只管 Git **跟踪**的文件 —— 上一次跑测试/构建留下的未跟踪与 ignored 产物
(`data\harness.db`、`dist\`、`*.tsbuildinfo`)原样活到下一次快照里。SHA 和 junction 全绿也照不出
这类污染,而 server 的生产入口直接跑 `server\dist\index.js`:验的可能是上一版构建产物,「测的就是
这份快照」对文件树并不成立。所以 checkout 之后跑一次 `git clean -xdff`,清了几项跟 SHA 一起打印
出来;清完再回读一遍 `git status --porcelain --ignored`,除了 `node_modules`(那四个 junction 的家)
之外还剩东西就当场失败 —— 「我调过 clean 了」不作数,跟 SHA / junction 一样得拿状态说话。

清理有两个前提,缺一不可,而且第二个搞错顺序**会删掉主仓的源码**:

1. **只清自己的目录,而且在动手之前就认。** 判据不是「它是不是个链接式 worktree」—— 随便哪个
   任务的 worktree 都满足,于是路径一配歪(`WIN_REMOTE_WORKSPACE` 写错、默认路径被别的 worktree
   占了),别人没提交的活会先被 `checkout --force` 抹掉、再被 `git clean -xdff` 删光,全程 exit 0
   还报「同步成功」。判据得是「**是不是我建的那个**」:凭证是一枚标记文件,放在 worktree 的管理
   目录 `.git/worktrees/<name>/win-remote-owner` 里 —— 不能放工作区里,工作区正是等会儿要清掉的
   东西,拿它自证等于没证。目录已存在却没有这枚章,就整个拒绝(还没 fetch 就退,不是清到一半才退);
   确实想覆盖它,`WIN_REMOTE_ADOPT=1` 跑一次接管,同步完会用红字说明「里面原有的未提交内容已被
   覆盖」。自己新建的 worktree 当场盖章,之后不需要任何确认。顺序同样是判据的一部分:上一版把检查
   放在 checkout 之后,就算最后拒绝了 clean,tracked 的未提交改动也已经被 `--force` 丢了。
2. **先摘掉目录型 reparse point,再 clean。** `git clean` 的递归删除同样会穿过 junction ——
   那四个 `@harness/*` 指着的正是主仓的 `shared`/`server`/`web-next`/`mcp`。摘掉的链接紧接着
   就原地重建,所以顺带也免了「junction 指错」那一半。连**枚举**都不能进 junction:
   `Get-ChildItem -Recurse` 会跟进去,那就是在遍历主仓。

**远端不留明文。** 每条远程命令在对端落成 `%TEMP%\<token>.ps1`(完整明文脚本)+ `.out`/`.err`。
现在的顺序是**先删这三个文件,再把结果从内存里发回来** —— 开发机收到回传时对端磁盘上已经一个
token 文件都没有,原先「删文件 vs 开发机随手关掉终端会话」的竞争从根上不存在。wrapper 开头另有
一次自扫:同格式、一小时以上没动过的残留一并删掉,兜住脚本中途崩掉/断电/会话被掐这些走不到
删除那步的情况(一小时的门槛保证不会误伤正在跑的另一条命令,单条上限 10 分钟)。

**一次调用只有一个期限,而且从第一次远端请求之前就开始走。** 通道的控制面全是裸 `fetch`
(查项目、建终端会话、两次 `/input`、删会话),而裸 `fetch` 没有任何超时:对端 harness 卡死、
代理只接连接不回包、半开连接,这几种都不是「立刻抛错」而是**永不返回**,进程能挂到底层 TCP
自己想通为止。早先的 `timeout` 只罩着「等回传」那一段(从会话建成之后才起算),上面这些全在
保护之外。现在整次调用共用一个 `AbortController`:控制面每一跳都带着它,等回传的兜底也挂在它
的 `abort` 上(而不是再起一个同样长的定时器,那会让总时长变成两倍)。超时仍然是**返回**
`code: 124` 而不是抛。收尾那条删会话用自己的 `min(5s, timeout)`,因为它加在调用者的等待
**之后**,而且主 signal 那时已经 abort 了,借用它等于必然删不掉、把会话留在对端。

期限还得覆盖**进 `rexec` 之前**那一跳。CLI 的四个子命令都先查一次项目拿 `repoPath`,那次查询在
`rexec` 的 deadline 之外 —— 对端只接连接不回包时,`doctor/sync/exec/test` 全停在「对端 harness」
那一行不动,只能外面 kill。教训是「带 signal」不能写成调用方的义务:漏一个调用点就等于漏一条永不
返回的路。所以 `api()` 自己兜底 —— 调用方给了 signal 就用它(整次调用共享一个 deadline),没给就
按 `WIN_REMOTE_CONTROL_TIMEOUT`(默认 15s)现建一个,不存在「没有期限」的路径。

**发进 PTY 的东西一律不进预览。** wrapper 是一条几 KB 的长命令,PTY 会把它整条回显、再按 cols
硬折成几十行。按关键字过滤只挡得住带 `FromBase64String` 的第一折,后面全是裸 base64:实测一次
`sync` 有 67 行、13KB 可逆编码进了实时预览,既淹没真进度,又把 `exec` 的用户命令(可能含路径、
token)以能还原的形式写进终端日志和审查记录。现在按**内容**认:每一折都是我们发出去那串字符的
连续子串,拿原文一查便知,折在哪儿都无所谓;再加一条「纯 base64 长串」兜底,防某一折被插进光标
控制码后对不上原文。顺带一提,程序输出本来就不经过屏幕(全部重定向到回传文件),所以这层抑制
不可能吃掉真结果。

**那个 worktree 是全局单份的,所以整段 sync+test 上锁。** 锁是对端的
`.worktrees\win-remote.lock`(`CreateNew` 原子创建),被占时最多等 2 分钟。锁里写着本次调用的
owner id,**locked 区间内每条命令都先核对**,易主就当场中止(而不是接着往一个已经被别人 checkout
过的工作区里写)。真要手工解锁,删掉那个文件即可。

过期与接管这块值得多说两句,因为它是唯一能凭空造出两个持有者的路径。25 分钟没心跳算过期、可被
接管,这条不能省:持锁进程在开发机上,它崩了、被 Ctrl-C 了,对端一无所知,没有过期就等于把那台
机器永久锁死。而接管的正确性要求是完整的一句话 ——「**owner 没变,而且此刻仍然过期**」,两个条件
缺一不可,还得原子地成立。踩过三版才凑齐:

1. 「覆盖 owner 再读回来认一次」不是 CAS。两个竞争者各自读到的都是自己刚写的那份,双双自认接管
   成功、一起进临界区,「测到别人的快照」原样复活。
2. 换成原子改名也不够。A 接管后重建了锁,晚两秒动手的 B 照样能把**新锁**移走。
3. 只校验 owner 的 CAS 仍然不够。心跳当时只刷 mtime、不动内容,于是「原持有者在我判过期之后恢复
   了心跳」这件事在内容上看不出来 —— 实测能夺走一把只有 5 秒新鲜的**活锁**。

所以心跳现在刷的是**锁内容里的 `beat=<UTC ISO>` 字段**,判过期也看它(老格式没有这个字段,退回看
mtime,免得升级前留下的锁永远过不了期)。接管走真 CAS:拿 `FileShare::None` 的独占句柄(同一时刻
只有一个人开得了),在句柄里回读内容,要求**逐字节仍等于当初读到的那份**(心跳动过内容就不成立,
owner 带随机 id + ISO 时间戳也不会 ABA),并且**在句柄里重新算一次 age 仍超 TTL**,两个条件都满足
才写入自己的 owner。别人在此期间连打开都打不开,读-判-写整段不可能被插进来。

心跳也不能只在命令开头点一下。守卫只在每条命令开头核对一次 owner,一条 10 分钟的测试进了临界区
之后就再没人回头看它 —— 心跳停在开头,意味着「跑够 TTL 那么久的命令」会被别人**正当**接管,而它
自己还在往同一个 worktree 里写,恰好是这把锁要防的事。所以守卫顺手起一个 `Start-ThreadJob` 每
30 秒刷一次 beat,跟着命令一路刷到结束(同进程另开线程,脚本一退它跟着没,不留孤儿进程)。心跳
自己也核对 owner,但**只有「读到了、而且确实不是我的」才收手**:撞上别人的独占句柄(busy)只是下轮
重试的理由 —— 就此收手的话,一个竞争者瞄一眼就能把活锁的心跳停掉,反手再把它当过期锁接管。同理,
锁文件不在了要报 lost 而不是 busy,否则「锁被人删了」会被报成「一直被独占」,查起来南辕北辙。

## 两个边界

**通道跑在被测的 harness 里。** 改了 server 代码想看真实行为(而不是测试结果),得重启对端 harness ——
那会连着把这条通道一起掐了。所以默认路线是跑回归测试:它们是独立进程,不需要重启对端服务。

**`exec` 的完成判据是进程退出,不是管道 EOF。** 早先版本用 `<cmd> *>&1 | Out-File`,而管道要等
**所有**持有 stdout 的句柄关闭才算完 —— Windows 上留一个孙进程是常事(见下面 node-pty 那条),
于是 `test:terminal` 明明 exit 0,却挂满 10 分钟报假超时。现在用 `Start-Process` + `Wait-Process
-Timeout` + `Kill()`,跟残留句柄无关,超时也能把已写下的输出捞回来。代价是 stdout/stderr 分开重定向
(`Start-Process` 不许两路指向同一个文件),所以 stderr 拼在输出末尾的 `--- stderr ---` 之后,
而不是按时间交错。
