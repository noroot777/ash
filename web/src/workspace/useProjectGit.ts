import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api, type ProjectGitResult } from "../lib/api.ts";
import {
  projectGitEpoch,
  putProjectGitLoadError,
  putProjectGitState,
  readProjectGitRun,
  runProjectGit,
  subscribeProjectGitRun,
  type ProjectGitRun,
} from "./projectGitRuns.ts";

// 项目主仓 git 面板的数据层，供侧栏那颗分支胶囊点开的浮层用。
//
// 三条约定：
// ① **只在面板开着时拉。** 关着的时候胶囊显示的是 `ProjectHealth` 里那份轻量分支名
//    （WorkspaceShell 已经在拉了），不值得为了它再打一趟 git。
// ② **失败不清空已有状态。** 网络抖一下就把分支清单抹掉，用户看到的是「仓库没了」。
//    读取错误单独放一格，清单留在原地。
// ③ **状态全都归账本，这个 hook 自己不留。** 写操作的结果要活过浮层卸载（那正是「操作跑
//    一半浮层消失就像被打断」那件事的根），读取错误则必须跟写操作的结果住在一起——分家
//    就会出现两套各说各话的状态，合并出来永远是报错。这里只剩 `loading`：它说的是「我这
//    趟读还在飞」，本来就该按组件算。

export type ProjectGitHandle = Omit<ProjectGitRun, "loadError"> & {
  /** 这份 handle 是谁的。跟着 handle 走，调用点就不可能拿 A 的状态发 B 的请求。 */
  projectId: string | null;
  loading: boolean;
  refresh: () => void;
  run: (kind: string, action: () => Promise<ProjectGitResult>) => Promise<boolean>;
};

export function useProjectGit(projectId: string | null, enabled: boolean): ProjectGitHandle {
  const current = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeProjectGitRun(projectId, listener), [projectId]),
    useCallback(() => readProjectGitRun(projectId), [projectId]),
  );
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled || !projectId) return;
    // 写操作在途时不拉：这趟 GET 只会读到 git 干到一半的样子。操作落定时结果自带一份新状态。
    if (readProjectGitRun(projectId).busy) return;
    // 发之前记下世代号：这趟读在路上时如果有人写了，回来就得作废——缓存让按钮在 GET 落地
    // 之前就可点，用户完全来得及在这几百毫秒里切一次分支。判据见 `putProjectGitState`。
    const epoch = projectGitEpoch(projectId);
    let alive = true;
    setLoading(true);
    api.projectGit(projectId)
      // 成功和失败都写进账本，由它按同一道闸决定认不认（写之前发出的读，回来晚了一律不许
      // 再改面板）。**读取错误不留在这个 hook 里**：它一旦跟账本分家，就会出现「账本记着
      // checkout 成功、组件里那条读取错误没人清」的两套说法，合并出来永远是报错。
      .then((next) => { if (alive) putProjectGitState(projectId, next, epoch); })
      .catch((reason) => {
        if (alive) putProjectGitLoadError(projectId, reason instanceof Error ? reason.message : "读取 Git 状态失败", epoch);
      })
      // loading 说的是「我这趟读还在飞」，跟结果算不算数是两回事：过期的读也得把自己那盏灯
      // 熄了，只看 alive。挂着不熄的话，清单为空时会一直停在「正在读取…」。
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [enabled, projectId, version]);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  const run = useCallback(
    (kind: string, action: () => Promise<ProjectGitResult>) =>
      (projectId ? runProjectGit(projectId, kind, action) : Promise.resolve(false)),
    [projectId],
  );

  // 面板只该看到一个 error。写操作的结果排在读取错误前面：用户刚让它干的那件事，比「后台
  // 那趟刷新没读着」更该被听见。
  return { ...current, error: current.error ?? current.loadError, projectId, loading, refresh, run };
}
