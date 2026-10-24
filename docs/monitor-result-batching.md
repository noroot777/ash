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

停止哨兵、取消结果、启动时回收租约和完成前的结果检查继续读取原有逐条账本。
团队领取前若首条已被取消，扫描仍能在本次窗口投递下一条结果。
普通输入的参数、执行意图、排队及团队拒收语义保持原有路径。

## 检查入口

新增 `npm -w server run test:monitor-delivery-batch`，也接入 `test:monitors` 的前置检查。
该回归使用临时 SQLite、真实调度/领取/会话落盘链路和本地 CLI 夹具进程，直接核对 stdin 与回合数，
不调用付费模型。覆盖合批、单条、同哨兵追加、目标隔离、顺序、后到、失败结束、并发、事务回滚、
重试、取消、检查点、完成闸、历史格式和团队投递。

## 本次验证记录

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
