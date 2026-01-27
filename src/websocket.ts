import type { ServerWebSocket } from "bun";
import type { IterationHistory, RalphHistory } from "./state";
import type { StructuredTask } from "./tasks";

export type ServerEvent =
	| {
			type: "loop.started";
			loopId: string;
			prompt: string;
			task?: StructuredTask;
	  }
	| { type: "iteration.started"; iteration: number; loopId: string }
	| { type: "iteration.completed"; iteration: number; result: IterationHistory }
	| {
			type: "task.updated";
			task: StructuredTask;
			taskId: string;
			status: string;
	  }
	| { type: "context.received"; text: string }
	| { type: "loop.completed"; history: RalphHistory; loopId: string }
	| { type: "loop.stopped"; reason: string; loopId: string; iteration: number }
	| { type: "error"; message: string };

export type WSData = { id: string };

export class WebSocketManager {
	private clients: Map<string, ServerWebSocket<WSData>> = new Map();
	private clientIdCounter = 0;

	generateClientId(): string {
		return `ws-${Date.now()}-${++this.clientIdCounter}`;
	}

	addClient(ws: ServerWebSocket<WSData>): void {
		this.clients.set(ws.data.id, ws);
		console.log(
			`[WS] Client connected: ${ws.data.id} (${this.clients.size} total)`,
		);
	}

	removeClient(ws: ServerWebSocket<WSData>): void {
		this.clients.delete(ws.data.id);
		console.log(
			`[WS] Client disconnected: ${ws.data.id} (${this.clients.size} total)`,
		);
	}

	broadcast(event: ServerEvent): void {
		const message = JSON.stringify(event);
		console.log(
			`[WS] Broadcasting ${event.type} to ${this.clients.size} client(s)`,
		);

		for (const [id, client] of this.clients) {
			try {
				client.send(message);
			} catch (err) {
				console.error(`[WS] Failed to send to ${id}:`, err);
				this.clients.delete(id);
			}
		}
	}

	getClientCount(): number {
		return this.clients.size;
	}
}

export const wsManager = new WebSocketManager();
