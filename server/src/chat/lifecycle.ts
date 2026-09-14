import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatRooms } from "../db/schema.js";
import { chatService, type ChatService } from "./service.js";

/**
 * 删掉一个群聊/助手对话本身。先 stop 再删：正在跑的回复要先收到中止信号，否则它会继续占
 * 着执行器跑完一整轮，回来写一个已经不存在的房间。删除本身只落到 chat_rooms 一行，消息、
 * 上下文条目、摘要、整理状态、清空点都由 `chat_room_contents_deleted` 触发器连带清掉；
 * 迟到的写入有三处「聊天已删除。」事务闸挡着（service.sendNow / context.compact /
 * context-store.resetChatContext），不会留孤儿行。
 *
 * **消息里引用过的任务不动**：任务有自己的删除入口，聊天记录没了不等于干过的活也该没。
 */
export async function deleteChatRoom(roomId: string, service: ChatService = chatService) {
  await service.stop(roomId);
  await db.delete(chatRooms).where(eq(chatRooms.id, roomId));
}

export async function deleteTaskSideChats(taskId: string, service: ChatService = chatService) {
  const rooms = await db.select({ id: chatRooms.id }).from(chatRooms).where(eq(chatRooms.parentTaskId, taskId));
  for (const room of rooms) await service.stop(room.id);
  // 房间删除触发器清理消息与上下文；任务删除触发器覆盖此后并发创建的房间。
  await db.delete(chatRooms).where(eq(chatRooms.parentTaskId, taskId));
}
