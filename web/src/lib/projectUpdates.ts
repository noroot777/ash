import type { ProjectView } from "@ash/shared";

// 「某个项目的设置刚被改过」—— 同一页里各处入口共用的那一声。
//
// 项目列表只在工作区壳那一层拉一次(WorkspaceShell),设置页读的就是那份。而有些项目设置在别处
// 也能就地改(验收台门禁卡上的门禁基准):那边改完不告诉壳层,用户回到设置页看到的还是改之前
// 的那一档。所以就地改完的入口在这里喊一声,壳层收下替换掉那一行。别的标签页/别的人改的不走
// 这里,那是服务端事件的事(门禁卡靠 task.acceptGate 重读)。
type Listener = (project: ProjectView) => void;
const listeners = new Set<Listener>();

export function announceProjectUpdate(project: ProjectView): void {
  for (const listener of listeners) listener(project);
}

export function onProjectUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
