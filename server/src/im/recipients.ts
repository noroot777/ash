// 一件事该推给谁。
//
//   · 项目绑了群、而且打开了「卡片推到群里」：推到群里（谁点按钮就以谁的身份执行）。
//   · 否则推给**任务的主人**的单聊：自用模式是机主那一个绑定；多人模式是任务 owner 的绑定。
// 推之前再核一遍这个人现在还能不能看见这个任务（多人模式下被移出项目、账号停用的不推）——
// 推出去的卡上有任务标题，等于把任务给他看了。入队到发出之间这些也可能变，所以发件、改卡前
// 还要按行上记的授权来源再核一次（scope.ts / exits.ts）。
import { canSeeProject } from "../auth/visibility.js";
import { imActorFor } from "../auth/im-actor.js";
import { isMultiUser } from "../auth/mode.js";
import type { TaskView } from "./attention.js";
import { bindingOfOwner, bindingsOfApp, CHANNEL, ownerKeyOf, type BindingRow } from "./binding.js";
import { pushGroupOf } from "./groups.js";
import type { Destination } from "./outbox.js";

async function usable(binding: BindingRow, projectId: string): Promise<boolean> {
  const actor = await imActorFor({ channel: CHANNEL, appId: binding.appId, openId: binding.openId });
  return !!actor && await canSeeProject(actor, projectId);
}

export async function destinationsFor(appId: string, view: TaskView): Promise<Destination[]> {
  const group = await pushGroupOf(appId, view.task.projectId);
  if (group) return [{ receiveType: "chat_id", receiveId: group.chatId, recipientOpenId: null }];
  let candidates: BindingRow[];
  if (await isMultiUser()) {
    if (!view.ownerUserId) return [];
    const binding = await bindingOfOwner(ownerKeyOf(view.ownerUserId));
    candidates = binding && binding.appId === appId ? [binding] : [];
  } else {
    candidates = (await bindingsOfApp(appId)).filter((binding) => binding.userId === null);
  }
  const out: Destination[] = [];
  for (const binding of candidates) {
    if (await usable(binding, view.task.projectId)) {
      out.push({ receiveType: "open_id", receiveId: binding.openId, recipientOpenId: binding.openId });
    }
  }
  return out;
}
