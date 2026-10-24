export type RegressionInputIdentity = {
  protocol: 1;
  execution: "mutable-workspace";
  closure: "unverified";
};

export function regressionInputIdentity(): RegressionInputIdentity {
  return { protocol: 1, execution: "mutable-workspace", closure: "unverified" };
}

export function regressionInputRejection(identity: RegressionInputIdentity | null): string {
  const origin = identity?.protocol === 1 && identity.execution === "mutable-workspace"
    ? "命令在可变工作目录执行，无法证明执行期间源码不可变"
    : "旧记录或未知协议没有不可变输入证明";
  return `${origin}；忽略配置、依赖、构建产物、子模块及外部输入闭包未核实，禁止自动复用；前后 Git 树仅作诊断`;
}
