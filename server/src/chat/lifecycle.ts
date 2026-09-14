import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatRooms } from "../db/schema.js";
import { chatService, type ChatService } from "./service.js";

/**
 * 删掉一个群聊/助手对话本身。真正的删除在 `ChatService.discard()` 里——它要把「停回复 →
 * 删房间」整段罩在删除闸下，中途挤进来的发送才会被拒掉而不是被泵成一条谁也中止不了的回复
 * （理由见 service.ts 的 `discarded` 字段注释）。这里只留一个按用途命名的入口。
 *
 * **消息里引用过的任务不动**：任务有自己的删除入口，聊天记录没了不等于干过的活也该没。
 */
export async function deleteChatRoom(roomId: string, service: ChatService = chatService) {
  await service.discard(roomId);
}

export async function deleteTaskSideChats(taskId: string, service: ChatService = chatService) {
  const rooms = await db.select({ id: chatRooms.id }).from(chatRooms).where(eq(chatRooms.parentTaskId, taskId));
  // 逐个走删除闸：主任务已经要没了，旁聊在这中间收到的发送同样不该再被泵起来。
  for (const room of rooms) await service.discard(room.id);
  // 房间删除触发器清理消息与上下文；这一条兜住清理期间并发创建的房间（任务删除触发器同理）。
  await db.delete(chatRooms).where(eq(chatRooms.parentTaskId, taskId));
}
