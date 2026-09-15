import { useMemo } from "react";
import type { GitHistoryCommit } from "@ash/shared/git-workbench";

const colors = [
  "#5e6ad2",
  "#2d9685",
  "#c4883c",
  "#ae6ca1",
  "#638eaa",
  "#b67063",
];
export function useCommitGraph(commits: GitHistoryCommit[]) {
  return useMemo(() => {
    const lanes: (string | null)[] = [];
    let width = 1;
    const rows = commits.map((commit) => {
      let column = lanes.indexOf(commit.sha);
      if (column < 0) {
        column = lanes.indexOf(null);
        if (column < 0) column = lanes.length;
        lanes[column] = commit.sha;
      }
      const before = [...lanes];
      lanes[column] = null;
      const parents = commit.parents.map((parent, index) => {
        let target = lanes.indexOf(parent);
        if (target < 0) {
          target =
            index === 0 && lanes[column] === null
              ? column
              : lanes.indexOf(null);
          if (target < 0) target = lanes.length;
          lanes[target] = parent;
        }
        return target;
      });
      width = Math.max(width, lanes.length);
      return { column, before, parents, after: [...lanes] };
    });
    return { rows, width: width * 15 + 18 };
  }, [commits]);
}
export function CommitGraphRow({
  row,
  width,
}: {
  row: ReturnType<typeof useCommitGraph>["rows"][number];
  width: number;
}) {
  const x = (column: number) => 12 + column * 15;
  return (
    <svg className="gwb-graph" width={width} height={64} aria-hidden="true">
      {row.before.map((sha, column) =>
        sha && column !== row.column ? (
          <path
            key={sha}
            d={`M ${x(column)} 0 V 64`}
            stroke={colors[column % colors.length]}
          />
        ) : null,
      )}
      <path
        d={`M ${x(row.column)} 0 V 30`}
        stroke={colors[row.column % colors.length]}
      />
      {row.parents.map((target) => (
        <path
          key={target}
          d={`M ${x(row.column)} 30 C ${x(row.column)} 50 ${x(target)} 45 ${x(target)} 64`}
          stroke={colors[target % colors.length]}
        />
      ))}
      <circle
        cx={x(row.column)}
        cy={30}
        r={4}
        fill={colors[row.column % colors.length]}
        stroke="var(--canvas)"
        strokeWidth={2}
      />
    </svg>
  );
}
