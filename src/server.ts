import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AppContext, getContextPath, getStateDir } from "./context";
import { loadContext, loadHistory, loadState, saveState } from "./state";
import { loadStructuredTasks } from "./tasks";
import { type WSData, wsManager } from "./websocket";

export const VERSION = "0.2.0";

export const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			...CORS_HEADERS,
		},
	});
}

export function logRequest(method: string, path: string, status: number): void {
	const timestamp = new Date().toISOString();
	console.log(`[${timestamp}] ${method} ${path} -> ${status}`);
}

export function startHttpServer(
	ctx: AppContext,
	port: number,
): ReturnType<typeof Bun.serve> {
	const server = Bun.serve<WSData>({
		port,
		fetch(req, server) {
			const url = new URL(req.url);
			const path = url.pathname;
			const method = req.method;

			if (path === "/events") {
				const clientId = wsManager.generateClientId();
				const upgraded = server.upgrade(req, {
					data: { id: clientId },
				});
				if (upgraded) {
					return undefined;
				}
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (method === "OPTIONS") {
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			}

			let response: Response;

			try {
				if (method === "GET" && path === "/status") {
					const state = loadState(ctx);
					const history = loadHistory(ctx);
					const context = loadContext(ctx);
					response = jsonResponse({
						active: state?.active ?? false,
						state: state ?? null,
						history: history ?? null,
						context: context ?? null,
					});
				} else if (method === "GET" && path === "/health") {
					response = jsonResponse({
						status: "healthy",
						version: VERSION,
					});
				} else if (method === "GET" && path === "/tasks") {
					if (ctx.structuredTasksFile) {
						const data = loadStructuredTasks(ctx);
						if (data) {
							const allTasks = Array.from(data.allTasks.values());
							const complete = allTasks.filter(
								(t) => t.status === "complete",
							).length;
							const inProgress = allTasks.filter(
								(t) => t.status === "in-progress",
							).length;
							const todo = allTasks.filter((t) => t.status === "todo").length;
							response = jsonResponse({
								total: allTasks.length,
								complete,
								inProgress,
								todo,
								tasks: allTasks,
							});
						} else {
							response = jsonResponse({
								total: 0,
								complete: 0,
								inProgress: 0,
								todo: 0,
								tasks: [],
							});
						}
					} else {
						response = jsonResponse({
							total: 0,
							complete: 0,
							inProgress: 0,
							todo: 0,
							tasks: [],
						});
					}
				} else if (method === "POST" && path === "/context") {
					return (async () => {
						try {
							const body = await req.json();
							const text = body.text as string;

							if (!text) {
								return jsonResponse(
									{ success: false, error: "Missing 'text' field" },
									400,
								);
							}

							const stateDir = getStateDir(ctx);
							if (!existsSync(stateDir))
								mkdirSync(stateDir, { recursive: true });

							const timestamp = new Date().toISOString();
							const newEntry = `\n## Context added at ${timestamp}\n${text}\n`;

							const contextPath = getContextPath(ctx);
							if (existsSync(contextPath)) {
								const existing = readFileSync(contextPath, "utf-8");
								writeFileSync(contextPath, existing + newEntry);
							} else {
								writeFileSync(contextPath, `# Ralph Loop Context\n${newEntry}`);
							}

							wsManager.broadcast({
								type: "context.received",
								text,
							});

							console.log(
								`\nCONTEXT INJECTED: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`,
							);

							return jsonResponse({ success: true, action: "added" });
						} catch {
							return jsonResponse(
								{ success: false, error: "Invalid JSON body" },
								400,
							);
						}
					})();
				} else if (method === "POST" && path === "/stop") {
					const state = loadState(ctx);
					if (state?.active) {
						state.active = false;
						saveState(ctx, state);
						wsManager.broadcast({
							type: "loop.stopped",
							reason: "Stopped via HTTP",
							loopId: state.loopId || "",
							iteration: state.iteration,
						});
						console.log(`\nLOOP STOP REQUESTED via HTTP`);
						response = jsonResponse({
							success: true,
							stoppedAt: new Date().toISOString(),
							iteration: state.iteration,
						});
					} else {
						response = jsonResponse(
							{ success: false, error: "No active loop" },
							400,
						);
					}
				} else {
					response = jsonResponse({ error: "Not found" }, 404);
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Internal server error";
				response = jsonResponse({ error: message }, 500);
			}

			logRequest(method, path, response.status);
			return response;
		},
		websocket: {
			open(ws) {
				wsManager.addClient(ws);
			},
			message(ws, message) {
				console.log(`[WS] Received message from ${ws.data.id}: ${message}`);
			},
			close(ws) {
				wsManager.removeClient(ws);
			},
		},
	});

	return server;
}
