import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatRooms } from "../db/schema.js";
import { chatService, type ChatService } from "./service.js";

export async function deleteTaskSideChats(taskId: string, service: ChatService = chatService) {
  const rooms = await db.select({ id: chatRooms.id }).from(chatRooms).where(eq(chatRooms.parentTaskId, taskId));
  for (const room of rooms) await service.stop(room.id);
  // 房间删除触发器清理消息与上下文；任务删除触发器覆盖此后并发创建的房间。
  await db.delete(chatRooms).where(eq(chatRooms.parentTaskId, taskId));
}
