import { useEffect, useState } from "react";
import { Warning } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";

type Notice = { action: string; reason: string; occurredAt: string };

// 对话流空态里的「你点过、它没成」。
//
// 为什么非得在空态里再读一次:挡回的那一刻服务端会往会话时间线写一条,用户在对话流里
// 顺着时间就读到了 —— **但那条路要求任务至少跑过一次**(写的是某条会话的 transcript)。
// 而「点运行被同队前项挡回」最常发生在一个刚排进队列、还没跑过的任务上,那一档原本连
// 一行都留不下,用户只看见一闪而过的 toast,刷新之后干干净净(本轮审查 F4)。
// 所以这里读的是不依赖会话的那张表(server/src/user-action-rejection.ts)。
//
// 只在空态渲染,所以和会话时间线那条**不会重复出现**:有正文可读时这个组件压根不挂载。
export function RejectionNotices({ taskId }: { taskId: string }) {
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    let live = true;
    setNotices([]); // 切任务先清空:否则上一个任务的挡回会挂在新任务的空态上
    api.taskNotices(taskId)
      .then((r) => { if (live) setNotices(r.notices); })
      .catch(() => { /* 读不到就什么都不显示,空态本身还在 */ });
    return () => { live = false; };
  }, [taskId]);

  if (!notices.length) return null;
  return (
    <div className="task-conversation-notices" role="status">
      {notices.map((notice) => (
        <p key={`${notice.occurredAt}-${notice.action}`}>
          <Warning size={14} aria-hidden="true" />
          <span>
            {new Date(notice.occurredAt).toLocaleString()} 你点的「{notice.action}」没有执行：{notice.reason}
          </span>
        </p>
      ))}
    </div>
  );
}
