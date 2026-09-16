import { eq } from "drizzle-orm";
import { CHAT_TRACE_LIMITS, type ChatTraceEvent } from "@ash/shared/chat";
import { db } from "../db/index.js";
import { chatMessages } from "../db/schema.js";

/**
 * 一条聊天回复的执行过程（它跑了什么命令、读了什么文件、想了什么）。
 *
 * 判据跟主会话同一条：**跑的中途就要看得见，跑完/被停/崩了之后还得在原地**。所以这里
 * 边跑边把整份记录写进 `chat_messages.trace`——房间快照每秒拉一次，写进列它自然就流到
 * 页面上了，不必再为侧聊单开一条事件流；而落列（不是只攒在闭包里）保证了进程崩溃重启后
 * `recover()` 把消息落成 stopped 时，用户仍能看到它停之前到底做了什么。
 *
 * 写入是**整份覆盖**，所以必须限流：CLI 一秒能吐十几个事件，逐个写等于把一条消息行
 * 反复重写。节流窗口比页面拉取间隔（1 秒）小一档就够了。
 */
export class ChatTraceLog {
  private events: ChatTraceEvent[] = [];
  private budget: number = CHAT_TRACE_LIMITS.total;
  private capped = false;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private messageId: string, private interval = 400) {}

  /** 记一步。到上限就补一行说明后停记——静默截断会让人以为它只干了这么点事。 */
  readonly push = (event: ChatTraceEvent): void => {
    if (this.capped) return;
    const detail = event.detail?.trim().slice(0, CHAT_TRACE_LIMITS.detail);
    const cost = event.label.length + (detail?.length ?? 0);
    if (this.events.length + 1 >= CHAT_TRACE_LIMITS.events || cost > this.budget) {
      this.capped = true;
      this.events.push({ kind: "thinking", label: "执行过程已达记录上限", detail: "这次咨询的步骤太多，后面的步骤不再记录；回复本身不受影响。" });
    } else {
      this.budget -= cost;
      this.events.push(detail ? { ...event, detail } : { kind: event.kind, label: event.label });
    }
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.write(); }, this.interval);
      this.timer.unref?.();
    }
  };

  /** 立刻落库并等它写完。回合收尾（含停止、失败）时调一次，别让最后几步只活在内存里。 */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.write();
  }

  private write(): Promise<unknown> {
    if (!this.dirty) return this.writes;
    this.dirty = false;
    const snapshot = JSON.stringify(this.events);
    // 串成一条链：整份覆盖的写入乱序落地会让页面上的执行过程倒退。房间删除等把行删掉的
    // 情况命中 0 行，无副作用，不必额外判存在。
    this.writes = this.writes
      .then(() => db.update(chatMessages).set({ trace: snapshot }).where(eq(chatMessages.id, this.messageId)))
      .catch((error) => { console.error("[chat] 执行过程落库失败", error); });
    return this.writes;
  }
}
