import type { TaskListItem } from "@ash/shared";
import { CaretRight } from "@phosphor-icons/react";

// 助手页的右栏：只放这段对话关联到的任务（助手找出来的、它建的），一条一个入口。
// 用哪个智能体写在二级栏顶上、回复风格写在栏底，这里不再说一遍；没有关联任务时整列不画，
// 对话区吃满宽度（调用方据 tasks 是否为空决定渲不渲）。
export function AssistantInfo({ tasks, onTask }: { tasks: readonly TaskListItem[]; onTask: (task: TaskListItem) => void }) {
  return <aside className="chat-info assistant-links" aria-label="关联任务">
    <h2>关联任务<span>{tasks.length}</span></h2>
    <nav>{tasks.map((task) => <button type="button" key={task.id} onClick={() => onTask(task)}>
      <span>{task.title}</span><CaretRight size={14} aria-hidden="true" />
    </button>)}</nav>
  </aside>;
}
