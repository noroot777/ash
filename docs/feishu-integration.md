# ash 接入飞书：形态与方案

状态：方案稿（2026-11-06，任务 6aje7YwI4keW）。本轮只做调研和设计，**没有动任何代码**。方案经过三轮：6 路调研（ash 代码 3 路，飞书平台、开源先例、个人知识库各 1 路），3 个视角各自出方案（MVP、架构、安全），再由 1 个审稿人对照代码和飞书官方文档挑错。下面写的是挑错之后的版本，关键代码断言都在本仓库里复核过。

## 一、结论

**推荐形态：ash server 进程内置一个 IM 通道模块，飞书是它的第一个适配器。** 在飞书侧建一个「企业自建应用 + 应用机器人」，由 ash 主动连出去走**长连接（WebSocket）**。一个 ash 实例对应一个飞书应用。

定位是**遥控器加决策收件箱，不是第二个主界面**。需要你拍板的节点（提问、待验收、失败）推成卡片，你在卡片上点一下就处理完；任务完成也推。长会话、diff 审阅、预览仍然回 web 看。

为什么这样选：

- **不需要公网 IP。** 长连接只要求机器能访问外网。新版卡片按钮回调 `card.action.trigger` 也能走长连接（只有旧版「消息卡片回传交互」不行）。ash 通常跑在家里的 Mac 上，这正好合适。
- **状态只存一份。** 提问、待验收、门禁结果都已经在 ash 的库里。外挂一个桥接进程，就得在那边再存一份，正好踩中先例里最常见的坑：待审批卡片只存在内存，重启就点不动了。
- **身份不用落明文 key。** 多人模式下库里只存 key 的哈希。外挂进程要代表每个飞书用户，就得替每个人明文保存 ash key。
- **能拿到全部事件。** `bus.ts` 是进程内的 EventEmitter，SSE 不支持断线续传，很多事件只是一个信号、要回查才知道内容。这几件事都只有在进程内才好办。

## 二、各种形态对比

| 形态 | 裁决 | 理由 |
|---|---|---|
| **server 内置通道 + 自建应用长连接** | **采用** | 见上 |
| 独立桥接 sidecar（cc-connect 一类） | 不选，只适合半天原型 | 状态要复制一份。SSE 断线就丢，信号类事件还要再发 HTTP 补内容。多人模式下要明文保存每个人的 key。自用模式下 :4317 监听所有网卡、零鉴权（`server/src/index.ts:625`），sidecar 一旦被做成对外暴露回调就是事故。先例里这类工具本来就是为「包一层 CLI」设计的，而 ash 自己就是调度器 |
| 群自定义 webhook 机器人 | 不选（最多当零配置的降级通知） | 只能单向推到一个群，收不到消息，按钮也回调不到服务端。webhook URL 本身就是凭据。ash 最有价值的恰恰是答复、验收这些回程动作 |
| 只给 agent 装飞书 MCP / lark-cli | 是另一件事，可以以后另做 | 那是「agent 去读写飞书文档」，不是「人通过飞书指挥 ash」。要做的话必须用**另一个**飞书应用、默认关闭、按项目开启。否则 agent 拿着你的身份写飞书，就给提示注入开了一条往外传数据的路 |
| 飞书 aily / 智能伙伴 / 豆包工作伙伴 | 不选 | 接入第三方本地 agent 的规格没找到，看起来依赖付费版，而且会把 ash 变成被调用的一方 |
| Claude Code Channels 一类按会话的通道 | 不选 | 绑定在单个正在运行的 claude 会话上，会话不开消息就丢。ash 是多执行器、多任务的调度台 |

## 三、会话模型

| 飞书 | ash | 期次 |
|---|---|---|
| 你和机器人的**单聊** | 你的决策收件箱：所有卡片都发到这里 | P1 |
| 在单聊里**回复某张卡片**（`parent_id` 指向那张卡） | 那个任务：回复提问卡 = 答复；回复其它卡 = `POST /tasks/:id/reply` | P1 |
| 单聊里的普通文本 | 你的助手房间（kind=assistant）。一条飞书消息对应一条 chat 消息，飞书的 `message_id` 直接当消息 id 用：`/chats/:roomId/messages` 对同 id、同内容的重发是幂等的（`server/src/chat/service.ts:74-78`） | P3 |
| 群（在 web 上绑定到一个项目） | 项目群聊（kind=chat）。「@成员 → 建任务开跑」这条链路已经现成 | P4 |
| 群里的话题 | 一个任务。话题根就是那张通知卡，话题里的回复 = reply | P4 |

团队执行者的提问是问调度台的，**不推给人**。只推调度台自己的提问。

## 四、出站：推什么，怎么推

### 4.1 推送由数据库对账驱动，总线只负责叫醒

总线不落盘、没有序号，重启空窗里的事件会直接丢。所以：

1. 订阅者照 `watchTaskWrites()` 的写法（`server/src/task-writes.ts:18-27`）。收到事件只记下「某个 taskId 该对账了」，然后 `setImmediate` 入队。**不能在订阅回调里同步读库或抛错**，因为 `bus.publish` 是同步的，异常会冒到 `setTaskStatus` 这类调用方里去。
2. 对账函数从库里算出「这个任务现在要人做什么」，和发件表比对：缺的补发；已经不成立的（在 web 或手机上处理掉了），把原卡片改成「已在别处处理」。
3. 启动时全量对一次账，但要带**水位线**，只补上次在线以后新出现的，或者合并成一张汇总卡，否则重启一次就会刷屏。
4. 发消息时带飞书的 `uuid` 参数（1 小时内同一 uuid 最多成功一次），用发件表的行 id 当 uuid，防止崩溃后重试发出两条。

**「此刻轮到你动手了吗」只算一份。** 一个任务在某一刻要么在自己跑（不用管），要么在等你（回答提问、点验收、处理失败）。界面上那颗「需要你处理」的信号点就是这样算出来的。现在 web 算一份（`web/src/lib/taskAttention.ts`），mobile 抄了一份（`mobile/src/lib/taskTree.ts`），飞书再写第三份的话，迟早会出现飞书说「等你验收」、页面上却不是这样的情况。所以第一步先把它挪进 `shared/` 合成一份，web、mobile、飞书共用。这是纯内部整理，界面行为不变。

举个例子说明为什么非用同一份判据不可：三份草案起初都把「待验收」写成 `stage=awaiting_acceptance`。但自由工作流（默认模式）跑完时 stage 多数是 null，web 的真实判据是「已 done 且没盖过章」（`taskAttention.ts:106-110,133-146`，注释里记着这一档改过两次的经过）。照草案那样写，大多数任务永远收不到验收卡。

### 4.2 卡片清单

| 卡片 | 什么时候推（按库状态判） | 按钮 → ash API | 期次 |
|---|---|---|---|
| 提问 | `question` 非空，且任务已经 paused（团队调度台例外）。还在 running 时答复会 409（`server/src/task-answer.ts:33`） | 每个选项一个按钮，外加自由作答表单 → `POST /tasks/:id/answer` | P1 |
| 完成待验收 | 任务完成且没验收过（shared 里那份判据）。自由工作流下「完成」和「待验收」是同一张卡 | 「验收合并」→ `POST /tasks/:id/accept`。**先回执，再异步执行**，结果靠 patch 卡片回写：合并要排仓库锁、要跑尾段（`server/src/task-accept.ts` 里的 `withRepoLock`、`finishAcceptedTail`），3 秒的回调窗口里做不完 | P1 |
| 失败 | status=failed，或回合起不来 | 「重试」→ `POST /tasks/:id/retry`（只接受 failed） | P1 |
| 已收尾的完成 / 门禁结果 | 完成且已验收或合并，或门禁出结果 | 只做告知，默认推。原地改卡片不会触发推送提醒，所以「完成」一律发新消息，不靠改旧卡 | P1 |
| 驳回待裁定 | 执行者驳回了审查意见 | 三个按钮 → `.../review/dispute/resolution`，带上 `target:{runId, round}`。按钮文案要写清楚：`withdrawn` 的意思是「采纳执行者的说法」，不是「撤回」 | P2 |
| duet 收敛闸 | `duet.gate` | approve / inject。**reject 实际上会取消任务**（`server/src/duet/index.ts:560`），文案必须写「否决并取消」，并且二次确认。`GateAction` 目前没有版本号，要先补上（见 6.4） | P2 |

**每张卡片都带：** 项目名、任务标题、一句「卡在哪」（取自 `GET /sessions/:id/notices`），以及一个打开 ash 的深链 `<base>/?project=<pid>&task=<id>`，`<base>` 在设置里配成 Tailscale 地址。手机不一定连着 Tailscale，多人模式下也未必有登录态，所以**卡片本身必须能独立完成决策**，深链只是补充。

**任何期次都不做成按钮，只给链接：**

- reclaim-turn、kill-cua、删会话消息：由离机签名或真人凭据保护。
- `verify-override`：在「验证 → 合并」这条线上，它会一路推进到合并，不可逆；自由工作流下还直接 409。
- `accept {gate:"skip"}`、`confirmUnverified:true`：都是绕过用户自己设的闸。

### 4.3 不做流式进度

CardKit 的流式模式开启 10 分钟后自动关闭，单张卡片每秒最多 10 次操作，流式和按钮交互互斥。而 ash 的任务经常一跑一小时。更重要的是，推到飞书的内容撤不回来，会话正文可能带着代码和密钥（ash 的「删会话片段」管不到飞书那份副本，见 `server/src/conversation-redact.ts`）。

真要看进度，以后可以做一张「状态卡」，只在状态变化时 patch 一次（单条消息 5 QPS、只能改 14 天内的）。流式最多留给助手回复这种短、有上限的场景。

## 五、入站

1. **先落库再回执，然后异步处理。** 飞书要求 3 秒内处理完，否则会重推。按 `message_id` 唯一键去重，官方原话是「不要依赖 event_id」。
2. **准入默认拒绝**，未授权的消息静默丢弃（见 6.1）。
3. **执行走进程内的完整路由栈，不直接调 service 函数。** 鉴权、可见性、个人面这几道闸都是挂在 `/api/*` 上的中间件（`server/src/index.ts:393-405`）。而 `actorOf()` 取不到身份时会兜底成**管理员**（`server/src/auth/context.ts:63-65`），直接调 service 函数，一旦忘了设身份，就会静默拿到管理员权限。做法是：
   - 用 `app.fetch(req, env)`，身份放进 env。真实网络请求的 env 由 `@hono/node-server` 自己填 `{incoming, outgoing}`，外部伪造不了。
   - 但有 4 处路由会调 `getConnInfo(c)` 读 `c.env.incoming`，包括 `GET /settings`（`server/src/routes.ts:147`）。自己造的 env 进去会直接抛错。所以通道层要带一份**路由白名单**，只放行第四节表格里用到的那几条路由。
4. **斜杠命令做确定性解析**（P3），同时当作卡片按不动时的文本回落：`/answer`、`/reply`、`/retry`，以后再加 `/new`、`/stop`。自然语言不在通道层另做一套 LLM 解析，直接交给现成的助手房间。
5. **附件转两跳**：从飞书下载 → 转成 dataUrl → `POST /uploads` 拿到 `path` → 把 path 放进 `attachments`。

## 六、身份与安全

### 6.1 威胁模型

能给机器人下指令，就等于拿到了这台机器的 shell：agent 手里有 shell，自用模式下所有请求又都是本机管理员。由此推出：

- **自用模式下机器人只属于一个人**：只绑定机主一个 open_id，群功能默认关闭。不能按群 `chat_id` 整体放行。
- **飞书账号从此也是这台机器的凭据。** 如果用公司租户，企业管理员和应用协作者能改应用配置、轮换密钥。个人自用建议在自己建的团队或测试企业下建应用。
- **飞书应用权限压到最小**：只开收单聊（`im:message.p2p_msg:readonly`）、收群里 @（P4 才开）、以机器人身份发消息、更新卡片。不开 `im:message.group_msg`（敏感权限，会读到群里全部对话）、通讯录、文档。这样即使密钥泄露，影响也只限于「冒充机器人收发消息」。
- **消息正文只当数据，不当授权依据。** 授权只看飞书给的 `sender.open_id` 或 `operator.open_id` 映射到的绑定身份。

### 6.2 绑定方向：网页发起，网页确认

1. 在已登录的 ash 网页上点「绑定飞书」，生成一个一次性码（10 分钟有效，库里只存哈希）。
2. 在飞书单聊里把这个码发给机器人，机器人记下发送者的 `(app_id, open_id)`。
3. 回到网页确认：「飞书用户 X 申请绑定到你的账号，确认吗？」

**不能反过来**，让机器人先发码、你去网页上输入：攻击者可以先从机器人那里拿到码，再诱导机主去输。全程也**不经飞书传 ash key**。绑定键用 `(app_id, open_id)`，换应用就要重新绑，这是有意为之。用户被停用时绑定同时失效。

### 6.3 新增一种身份 `im`（P3 起，P1 自用模式用不到）

在 `ActorKind`（`server/src/auth/context.ts:24`）里新增 `"im"`。加上之后，所有对 kind 的穷举分支都会编译报错，正好逼着把每一处的语义过一遍。它的语义：

- `isAccountHolder` 为 false：账号面的动作（改资料、改 CLI 环境、退出项目）一律碰不到。
- `isAdminActor` 为 false：实例设置碰不到。
- 可见性用绑定用户的 `visibleProjectIds`。
- 聊天路由要显式放行 im，因为现在 `isHumanRequest` 要求 isAccountHolder（`server/src/chat/route-access.ts:29`）。

需要钉住的回归测试：

- 外部 HTTP 无论带什么头，都造不出 im 身份。
- im 身份调 reclaim-turn、kill-cua、`/settings` 写接口一律被拒。
- **通道模块不得引用 `issueHumanActionToken`。** 同进程的代码可以自己签一份真人凭据，这才是真人专属动作的实际风险点。

### 6.4 按钮信封：带代次，存库里

按钮的 value 里只放一个随机、不可猜的信封 id。信封存在 `im_actions` 表里，记录 taskId、动作、收件人 open_id、代次、过期时间和使用时间。回调时依次校验：

1. 信封存在、没过期、没用过；
2. `operator.open_id` 等于信封里的收件人；
3. 代次和当前一致。

校验通过后，按收件人的身份进程内调 API，然后在库里标记已用，重启后也不能重放。

**必须带代次，不能只靠内容键。** `questionKey` 只是 `JSON.stringify([question, options, items])`（`shared/src/questions.ts:86-88`），按内容算，没有代次。agent 原样再问一次「继续吗？」，旧卡片照样能答中新问题。提问的代次可以用提问历史的长度加 updatedAt。duet 闸口目前没有版本号：注入一次意见之后闸口会重新打开，这时点旧卡片上的 approve，就放行了一份你没读过的新方案。所以闸口卡必须先补版本号才能做。

agent 伪造的卡片上的按钮会因为没有登记过的信封而点不动。但卡片里的链接仍然是钓鱼面，所以**卡片里除了 ash 深链，不放任何外链**。agent 写的文本一律按 plain_text 渲染，剥掉 `<at>`。

### 6.5 密钥与外流

- 凭证放在库文件旁边的 `<db>.feishu.json`，权限 0600，照 handoff 身份文件的做法（`server/src/handoff-identity.ts`）。复制库、做预览快照都带不走它，「不同 ASH_DB 就是不同实例」也自然成立。
- **不进 `app_settings`**：`GET /settings` 会把整份设置回给任何已登录的人，preview-seed 还会把它复制进预览库。
- **不进环境变量**：`agentBaseEnv()` 只在隔离宿主 CLI 那一档才清理环境变量（`server/src/executors/spawn.ts:42-57`），自用模式下所有 agent 都会继承。
- **要如实写给用户的边界**：agent 和 server 是同一个 OS 用户，agent 读得到这个文件，可以冒充机器人发消息。Windows 上 chmod 不生效。缓解手段只有最小权限和一个「轮换密钥」操作。
- **发出去之前过一遍密钥扫描并截断**：失败原因、提问正文都可能是 agent 或命令的原始输出。门禁的 `logTail` 一律不推。另外按项目提供一个「只推标题和链接」的开关。
- **审计**：每个经飞书发起的动作，在任务时间线上写一条旁注「经飞书由 X 执行 Y」，网页刷新后也看得出来源。被拒的尝试也记下来。

## 七、部署与运维

- **SDK**：用官方 `@larksuiteoapi/node-sdk` 的 `WSClient`。它是纯 JS，Windows 上没有原生模块负担；`domain` 参数可以切到 Lark 国际版。SDK 里还有一个现成的高层 Channel 模块（`createLarkChannel`），但它会接管流式等行为，P1 先不用。
- **启动位置**：放在 listen 成功之后，`startScheduler()` 旁边，复用「预览实例不启动」那个分支（`server/src/index.ts:623-640`）。凭证文件不存在就不启动。`index.ts` 只加一行，逻辑全放进 `server/src/im/`，单文件不超过 700 行。
- **连接状态要持久可见**：显示在 `/api/health` 和设置页上。ash 自己挂了，机器人就会静默下线；ash 默认也没有开机自启。
- **多实例**：飞书长连接是集群模式，同一个应用的多个客户端之间不广播，每条事件只随机给其中一个，而且飞书不告诉你连了几个。所以**一个实例一个应用**：Mac 和 Windows 真机（192.168.1.187）各建一个。预览实例和 `PORT=… ASH_DB=…` 起的测试实例因为拿不到凭证文件，天然不会连。低成本的撞车检测办法：每次连上就给机主发一句「实例 <指纹> 已上线」。
- **丢事件**：长连接会静默丢事件（cc-connect 踩过）。出站靠对账兜底；入站的按钮点击丢了，用户再点一次即可，信封保证幂等。
- **事件循环**：长连接心跳和整个 server 共用一个事件循环。Windows 上出过 node-pty 卡死主线程的事故，那种情况下机器人会被飞书判离线。适配器接口设计成纯消息传递，将来需要的话可以整体挪进 worker 线程。碰了 win32 分支就上真机跑一遍。
- **配额**：同一个群里所有机器人共享 5 QPS，同一用户也是 5 QPS，由发件表限流。免费版自建应用的 API 月配额现在是多少（1 万次还是 100 万次）没核实，P0 要先查清。
- **飞书侧开通顺序**：自建应用的权限和事件订阅每改一次都要发版，部分权限要企业管理员审核。后台保存「长连接」订阅方式时本地程序必须已经连上，所以要先在 ash 里配好凭证、连上，再去控制台保存。

## 八、分期

| 期 | 交付 | 主要改动 |
|---|---|---|
| **P0 实测** | 一次性脚本，不进仓库。确认 `WSClient` 能稳定收到 `card.action.trigger`，回调里拿得到 `operator.open_id`（官方文档说能，SDK 的 README 说不能）；查清免费版配额 | 无 |
| **P0' 合并判据** | 「此刻轮到你动手了吗」从 web、mobile 各一份合成 `shared/` 里的一份，界面行为不变 | `shared/src/`、`web/src/lib/taskAttention.ts`、`mobile/src/lib/taskTree.ts` |
| **P1 决策收件箱**（只支持自用模式，只走单聊） | 绑定流程；提问卡、待验收卡、失败卡；完成和门禁通知（默认推）；在别处处理掉的卡片原地改成「已处理」；启动对账带水位线；连接状态 | `server/src/im/{config,connection,outbox,reconcile,cards,actions,bind-routes}.ts`，新表放在 `server/src/db/schema-im.ts` 并且不进 preview-seed；`index.ts` 加一行；web 设置页加飞书分区；回归测试覆盖对账、信封（过期/他人点击/重复点击/代次不符）、启动刷屏，以及通道模块不引用 `issueHumanActionToken` |
| **P2 审批** | 驳回裁定卡；duet 闸口卡（先给 GateAction 补版本号） | `server/src/im/actions.ts`、`server/src/duet/gates.ts` |
| **P3 遥控** | `im` 身份；单聊进助手房间；回复卡片 = reply；斜杠命令；附件；`/new`、`/stop` 先出确认卡再执行 | `server/src/auth/context.ts`、`middleware.ts`、`chat/route-access.ts`、`server/src/im/{inbound,commands}.ts` |
| **P4 群与多人** | 多人模式绑定；群绑项目、话题绑任务；推送前按收件人可见性过滤（`server/src/auth/visibility.ts`） | `server/src/im/group-policy.ts` 等 |
| 以后再说 | 第二个适配器（钉钉 Stream、企业微信长连接，用来检验抽象是否真的与平台无关）；多实例经 handoff 签名通道单网关转发；给 agent 用的 lark-cli 技能（用独立应用） | — |

P1 的攻击面只有一项：已绑定的本人，在单聊里处理自己任务的待决事项。但它已经覆盖了最大的价值：离开电脑时，手机上收到提问，点一下任务就接着跑。

## 九、已定的事（用户 2026-11-06 答复）

1. 能在自己当管理员的飞书租户里发版自建应用，按长连接方案走。
2. P0' 照做。它不是「挑哪些任务要人管」，而是把「此刻轮到你动手了吗」的算法从两份合成一份，界面行为不变。
3. 完成也推，默认开。
4. 接受「飞书账号 = 这台机器的 shell 凭据」，P1 的验收合并给按钮。

## 出处

- 飞书长连接：https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events?lang=zh-CN
- 卡片回调走长连接：https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks?lang=zh-CN
- 卡片回调交互（3 秒、延时更新 token）：https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication?lang=zh-CN
- CardKit 流式更新：https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview?lang=zh-CN
- 发消息（uuid 幂等、5 QPS）：https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN
- 更新卡片（patch）：https://open.feishu.cn/document/server-docs/im-v1/message-card/patch?lang=zh-CN
- 接收消息事件：https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN
- 自定义 webhook 机器人：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN
- 用户身份（open_id / union_id / user_id）：https://open.feishu.cn/document/platform-overveiw/basic-concepts/user-identity-introduction/introduction?lang=zh-CN
- 官方 Node SDK 的 Channel 模块：https://github.com/larksuite/node-sdk/blob/main/docs/channel.zh.md
- 官方 openclaw-lark（同类形态，可参考交互）：https://github.com/larksuite/openclaw-lark
- cc-connect（踩坑：重复消息、静默丢事件、多项目共用一条连接）：https://github.com/chenhg5/cc-connect
- 卡兹克《Agent 自动化系统》（飞书只当决策通道，推送收窄）：https://mp.weixin.qq.com/s?__biz=MzIyMzA5NjEyMA%3D%3D&mid=2647688060&idx=1&sn=e00d7e57b6f0e3670f0e267e677047df
