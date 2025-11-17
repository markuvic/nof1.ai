import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createDashboardRoutes } from "./routes";

function stripDashboardPrefix(requestPath: string) {
	const withoutPrefix = requestPath.replace(/^\/dashboard/, "");
	if (withoutPrefix.startsWith("/")) {
		return withoutPrefix.slice(1);
	}
	return withoutPrefix || "";
}

export function createDashboardApp() {
	const app = new Hono();

	app.get("/healthz", (c) => c.json({ ok: true }));
	app.route("/dashboard/api", createDashboardRoutes());

	app.use(
		"/dashboard/*",
		serveStatic({
			root: "./dashboard",
			rewriteRequestPath: (path) => stripDashboardPrefix(path),
		}),
	);

	app.get("/dashboard", (c) => c.redirect("/dashboard/"));
	app.get("/", (c) => c.redirect("/dashboard/"));

	return app;
}
