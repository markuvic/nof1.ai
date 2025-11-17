import { Hono } from "hono";
import {
  buildOverview,
  fetchWithTimeout,
  invalidateOverviewCache,
} from "./multiTraderService";
import {
  addNode,
  cleanBaseUrl,
  getStoredNodes,
  removeNode,
  reorderNodes,
} from "./nodeStore";

const router = new Hono();

function extractErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

router.get("/nodes", async (c) => {
  const nodes = await getStoredNodes();
  return c.json({ nodes });
});

router.post("/nodes", async (c) => {
  try {
    const body = await c.req.json<{ baseUrl: string; customName?: string }>();
    const node = await addNode(body.baseUrl, body.customName);
    invalidateOverviewCache();
    return c.json(node, 201);
  } catch (error) {
    return c.json({ error: extractErrorMessage(error, "添加节点失败") }, 400);
  }
});

router.post("/nodes/reorder", async (c) => {
  try {
    const body = await c.req.json<{ ids: string[] }>();
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return c.json({ error: "无效的排序数据" }, 400);
    }
    const nodes = await reorderNodes(body.ids);
    invalidateOverviewCache();
    return c.json({ nodes });
  } catch (error) {
    return c.json({ error: extractErrorMessage(error, "排序失败") }, 400);
  }
});

router.delete("/nodes/:id", async (c) => {
  const id = c.req.param("id");
  await removeNode(id);
  invalidateOverviewCache();
  return c.json({ removed: true });
});

router.post("/nodes/test", async (c) => {
  try {
    const body = await c.req.json<{ baseUrl: string }>();
    const baseUrl = cleanBaseUrl(body.baseUrl);
    const meta = await fetchWithTimeout(`${baseUrl}/api/trader/meta`);
    return c.json({ ok: true, baseUrl, meta });
  } catch (error) {
    return c.json(
      { ok: false, error: extractErrorMessage(error, "连接失败") },
      400,
    );
  }
});

router.get("/overview", async (c) => {
  const nodes = await getStoredNodes();
  if (nodes.length === 0) {
    return c.json({
      nodes: [],
      totals: {
        equity: 0,
        available: 0,
        unrealised: 0,
        initialCapital: 0,
        pnl: 0,
        returnPercent: 0,
      },
      generatedAt: new Date().toISOString(),
    });
  }
  try {
    const overview = await buildOverview(nodes);
    return c.json(overview);
  } catch (error) {
    return c.json(
      { error: extractErrorMessage(error, "获取概要失败") },
      500,
    );
  }
});

export function createDashboardRoutes() {
  return router;
}
