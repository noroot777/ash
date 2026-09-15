import type { Context, Hono } from "hono";
import { actorOf, authErrorResponse } from "../auth/context.js";
import { requireProjectAdmin } from "../auth/visibility.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "../preview-instance.js";
import { ScmOperationError } from "../scm-paths.js";
import { requestContext, decorateState, claimWorkbench } from "./context.js";
import { readWorkbench, readHistory, readDetail } from "./read.js";
import { readConflict } from "./conflicts.js";
import { executeWorkbench } from "./operations.js";
import { parseAction } from "./input.js";

function respondError(c: Context, error: unknown) {
  const mapped = authErrorResponse(error);
  if (mapped) return c.json(mapped.body, mapped.status);
  return c.json(
    { error: error instanceof Error ? error.message : String(error) },
    error instanceof ScmOperationError ? (error.status as 400) : 500,
  );
}
export function mountGitWorkbenchRoutes(api: Hono) {
  const base = "/projects/:id/git/workbench";
  const read = (
    suffix: string,
    handler: (
      context: Awaited<ReturnType<typeof requestContext>>,
      c: Context,
    ) => Promise<unknown>,
  ) => {
    api.get(base + suffix, async (c) => {
      try {
        const context = await requestContext(
          actorOf(c),
          c.req.param("id") || "",
          c.req.query("root"),
          c.req.query("task"),
        );
        return c.json(await handler(context, c));
      } catch (error) {
        return respondError(c, error);
      }
    });
  };
  read("", async ({ repo, root, projectId }, c) => {
    const actor = actorOf(c);
    return decorateState(
      await readWorkbench(repo, root, actor.userId || actor.name),
      actor,
      projectId,
    );
  });
  read("/history", ({ root }, c) =>
    readHistory(root, {
      ref: c.req.query("ref"),
      path: c.req.query("path"),
      skip: Math.min(100000, Math.max(0, Number(c.req.query("skip")) || 0)),
    }),
  );
  read("/diff", ({ root }, c) =>
    readDetail(root, {
      sha: c.req.query("sha"),
      path: c.req.query("path"),
      source: c.req.query("source"),
      blame: c.req.query("blame") === "1",
      stash: c.req.query("stash"),
    }),
  );
  read("/conflict", ({ root }, c) =>
    readConflict(root, c.req.query("path") || ""),
  );
  api.post(base + "/actions", async (c) => {
    try {
      if (IS_PREVIEW_INSTANCE)
        return c.json({ error: previewRefusal("Git 工作台写操作") }, 403);
      const projectId = c.req.param("id") || "";
      const actor = actorOf(c);
      await requireProjectAdmin(actor, projectId);
      const request = parseAction(await c.req.json());
      const { repo, root } = await requestContext(
        actor,
        projectId,
        request.root,
      );
      return c.json(
        await executeWorkbench(
          repo,
          projectId,
          { id: actor.userId || actor.name, name: actor.name },
          { ...request, root },
          (selected, action) =>
            claimWorkbench(repo, selected, projectId, action),
        ),
      );
    } catch (error) {
      return respondError(c, error);
    }
  });
}
