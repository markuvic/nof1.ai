import "dotenv/config";
import { serve } from "@hono/node-server";
import { createPinoLogger } from "@voltagent/logger";
import { createDashboardApp } from "./dashboard/app";

const logger = createPinoLogger({
  name: "multi-trader-dashboard",
  level: (process.env.LOG_LEVEL as any) || "info",
});

const port = Number.parseInt(process.env.DASHBOARD_PORT || "4141", 10);

const app = createDashboardApp();

logger.info(`启动多交易员仪表板，监听端口 ${port}`);

serve({
  fetch: app.fetch,
  port,
});

logger.info(`仪表板访问地址: http://localhost:${port}/dashboard/`);
