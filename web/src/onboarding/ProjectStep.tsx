import type { ProjectView } from "@ash/shared";
import { Check, FolderPlus } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { ProjectAvatar } from "../workspace/ProjectAvatar.tsx";

/**
 * 第三站:在哪儿干活。
 *
 * 新建走的是工作台那个真弹层(`CreateProjectDialog`,由向导壳挂起来) —— 本地目录 /
 * 克隆两条路、路径体检、多人模式的前缀钳制全在那里面,照抄一遍必然漂移。
 *
 * 已有项目仍要列出来并且可选:多人模式下新来的人往往已经被加进了别人的项目,这一站
 * 对他不是「建一个」而是「挑一个落脚」;选中的那个会成为进入工作台后的当前项目。
 */
export function ProjectStep({ projects, selectedId, onSelect, onCreate }: {
  projects: ProjectView[];
  selectedId: string | null;
  onSelect: (projectId: string) => void;
  onCreate: () => void;
}) {
  return (
    <>
      {!!projects.length && (
        <ul className="onboarding-rows onboarding-rows--pick">
          {projects.map((project) => {
            const picked = project.id === selectedId;
            return (
              <li key={project.id}>
                <button
                  type="button"
                  className={`onboarding-pick${picked ? " is-on" : ""}`}
                  aria-pressed={picked}
                  onClick={() => onSelect(project.id)}
                >
                  <ProjectAvatar project={project} size="large" />
                  {/* 文案块用 div 而不是 span:行里第一个孩子(项目头像)本身就是 span,
                      按标签选中「那一块」会连头像一起选上,把它从 18px 方块拉成一整条。 */}
                  <div>
                    <b>{project.name}</b>
                    <small>{project.repoPath}</small>
                  </div>
                  {picked && <Check size={14} weight="bold" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Button className="onboarding-add" onClick={onCreate}>
        <FolderPlus size={13} weight="bold" aria-hidden="true" />
        新建项目
      </Button>
    </>
  );
}
