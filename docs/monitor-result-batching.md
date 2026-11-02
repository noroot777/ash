# 同目标哨兵结果批量投递

## 行为

哨兵仍各自写入 `scheduled_messages`，同一哨兵的未领取事件仍由原生产端合并。
消费端现在在领取时，从当前条目开始收取同任务队列中连续、可立即投递且目标兼容的哨兵条目，
只调用一次 `continueTask`。单任务因此只起一个回合，团队调度台只接收一次输入；不是托盘展示合并。

- 合批没有新增计时等待。领取后到达的结果另留一条，继续使用既有触发、冷却和重投机制。
- 顺序沿用 `sendAt → createdAt → id`；各条目内部的事件顺序不变。正文之间仅增加空行。
- 目标比较包括任务、执行者/审查者角色、审查 run/轮次、执行器/模型/思考强度、发送者、执行意图及附件。
  默认角色与显式 `single` 等价；其余配置采用保守的存储值比较，不猜测不同配置是否最终解析为同一会话。
- 普通输入、人工审查答复、定时消息、不同目标、已领取条目或尚在重试退避的条目都会截断当前批次，
  不从它们后面捞取结果凑批。其它任务的独立队列不受影响。
- 每条结果保留原有 ID、来源、正文、交接 token 和检查点账本。结构化事件按条目顺序连接，
  保留输出、失败与结束事件，不再次使用单哨兵的截断预算；已有省略计数相加。
  遇到无结构化边界的历史条目时，整批保留完整文本，不将部分元数据冒充整批结构。

## 消费与失败

`pending-monitor-batch.ts` 在同一事务中重读队列并领取整批租约。追加端原有的空租约 CAS 因此仍有效；
并发领取只能获得未被占用的条目。领取、送达、确认消费仍是三件事：行在真实送达前保持 `pending`，
一次 `onDelivered` 用单条更新确认本批所有仍为 pending 的行，随后通知托盘变化。

`pending-dispatch.ts` 是单任务及团队共用的实际投递器。每个成员都带原有的最终唤醒守卫；
若部分来源失效，只取消失效成员，其余成员归还租约后重试，不把有效同伴一并丢弃。
回合占用、短暂状态/检查点读取故障会归还整批租约并恢复已取走的检查点。
同一批重试使用共同的就绪时间，避免毫秒差拆开同一失败批次。

未送达哨兵的准备、清租约和取消失效成员等异常不再转为整批取消。
`pending-delivery-recovery.ts` 保留每批的补偿责任，分别记住已成功取消的成员、已归还的租约及待恢复的检查点；
写入持续失败时独立退避重试，间隔从 200ms 增长到最多 30s，而不是只安排看不到带租约行的普通扫描。
补偿完成前，该任务的扫描与哨兵领取暂缓，后项不越过原批次，其它任务仍可投递。
检查点回填的写入错误向补偿层返回；清租约已经成功时不会因后续回填重试再次清除别人的租约。
进程退出后，尚未完成的交接仍由原有逐行租约及检查点账本承担，启动回收后重新投递。

停止哨兵、取消结果、启动时回收租约和完成前的结果检查继续读取原有逐条账本。
团队领取前若首条已被取消，扫描仍能在本次窗口投递下一条结果。
普通输入的参数、执行意图、排队及团队拒收语义保持原有路径。

## 检查入口

新增 `npm -w server run test:monitor-delivery-batch`，也接入 `test:monitors` 的前置检查。
该回归使用临时 SQLite、真实调度/领取/会话落盘链路和本地 CLI 夹具进程，直接核对 stdin 与回合数，
不调用付费模型。覆盖合批、单条、同哨兵追加、目标隔离、顺序、后到、失败结束、并发、事务回滚、
重试、取消、检查点、完成闸、历史格式和团队投递。
补偿故障检查覆盖单任务/团队两翼、一次与持续写入失败、取消失效成员失败、准备/检查点读取失败后补偿再失败、
检查点回填失败、有效同伴不连坐、后项等待、其它目标不受阻及恢复后的自动续投。
后到结果和普通输入分界用生产 `schedules.tick()` 周期触发完整续投，保留实际 5 秒冷却，不直接调用投递器绕过扫描。

## 初版验证记录

2026-10-24，最终候选通过回归哨兵 `LAoPTnEUCJKf` 真实执行，退出码 `0`。
实际工作目录为 `/Users/fjh/code/harness/.worktrees/Kz__0WqSyc3Y/server`，登记的原始命令为：

```sh
npm run test:monitor-delivery-batch; batch=$?; npm run test:monitor-wake-data && npx tsx scripts/test-monitor-races.ts && npx tsx scripts/test-monitor-result-lifecycle.ts && npx tsx scripts/test-monitor-wake-role.ts && npx tsx scripts/test-monitor-complete-gate.ts && npm run test:scheduled-messages; compat=$?; test "$batch" -eq 0 && test "$compat" -eq 0
```

新增合批回归的 13 组检查全部通过；既有事件数据、竞态、消费生命周期、审查目标、完成闸及普通输入
兼容回归均通过。`test:scheduled-messages` 连带执行的引导、回滚和方向身份检查也通过。
完整输出与真实退出码由 ash 保存，日志为
`/Users/fjh/code/harness/data/runs/Kz__0WqSyc3Y/regression/LAoPTnEUCJKf.log`。
该记录来自可变工作目录，不具有不可变输入闭包证明，不作为自动复用或验收结论。

`npm -w shared run build && npm -w server run build && npm -w mcp run build` 全部通过；
`git diff --check` 和本次修改代码的 700 行上限检查通过。本次没有浏览器操作、win32 分支改动、
合并、部署或自动验收。

## 首轮审查修复

2026-10-24，修复 F1 的整批连坐取消及补偿失败后无人重试问题，同时补齐 N2 的生产扫描自动续投覆盖。
N1 提到的既有送达确认写入故障没有在本轮扩大处理；本实现不据此宣称端到端恰好一次。
修复后的验证重新登记，未把初版或审查方的执行记录作为本轮自动复用依据。

修复期间保留的失败尝试（同目录、同原始组合命令，完整日志由 ash 保存）：

| 哨兵 | 退出码 | 失败原因 |
| --- | --- | --- |
| `RlyrXuazRYnF` | 1 | 准备故障注入误命中已提交检查点的实时通知读取，未触发预期的续跑准备失败；随后改用生产检查点持久重试状态隔离该窗口。 |
| `P5i9BSfkqvma` | 1 | 检查点回填注入依赖了错误的 SET 字段顺序；随后改为匹配原子批次中清除检查点账本的语句。 |
| `eBM54rxYipGz` | 1 | 团队已确认接收后，测试早于夹具写出 stdin 日志进行断言；随后等待真实消费再校验，不降低内容完整性断言。 |

对应日志分别为 `/Users/fjh/code/harness/data/runs/Kz__0WqSyc3Y/regression/<哨兵ID>.log`。

最终修复候选的回归哨兵为 `HGKLlzNAArkd`，已正式收到 `REGRESSION_FINISHED exitCode=0`。
实际 cwd 为 `/Users/fjh/code/harness/.worktrees/Kz__0WqSyc3Y/server`，登记的原始组合命令与初版记录一致。
完整日志为 `/Users/fjh/code/harness/data/runs/Kz__0WqSyc3Y/regression/HGKLlzNAArkd.log`。

合批定向检查全部通过，新增的单任务/团队共 12 种故障组合分别验证了保留 pending、补偿期间不重复领取、
不让后项越过、其它目标可继续投递、写入恢复后自动补偿及真实 stdin 内容恰好一次。
后到结果与普通输入分界的完整生产扫描续投、既有 wake-data/races/result-lifecycle/wake-role/complete-gate、
scheduled-messages 及其连带引导/回滚/方向身份检查全部通过。

修复后的 shared/server/mcp 构建、`git diff --check` 和修改代码行数检查均通过；
修改代码最多 538 行。本轮回归来自可变工作目录，不具备不可变输入闭包证明，不作为自动复用或自动验收结论。
