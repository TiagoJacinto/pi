import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import { convertResponsesMessages, convertResponsesTools } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { Message, Model, Tool } from "../src/types.ts";
import { normalizeContext, toToolDeclaration } from "../src/utils/transcript.ts";

const capturedRequests: Record<string, unknown>[] = [];
const fakeWSState = vi.hoisted(() => ({
	instances: [] as unknown[],
	mode: "steering" as
		| "steering"
		| "pending"
		| "failed"
		| "late-failed"
		| "cancelled"
		| "async"
		| "duplicate-steer"
		| "ephemeral",
	ephemeralAsync: false,
}));
let responseIndex = 0;

vi.mock("openai/resources/responses/ws", () => ({
	ResponsesWS: class FakeResponsesWS {
		sent: Record<string, unknown>[] = [];
		socket = { readyState: 1 };
		private releaseSteer!: () => void;
		private resolveCreated!: () => void;
		private resolveClosed!: () => void;
		private streamCount = 0;
		readonly steerReceived = new Promise<void>((resolve) => {
			this.releaseSteer = resolve;
		});
		readonly created = new Promise<void>((resolve) => {
			this.resolveCreated = resolve;
		});
		readonly closed = new Promise<void>((resolve) => {
			this.resolveClosed = resolve;
		});

		constructor() {
			fakeWSState.instances.push(this);
		}

		send(event: Record<string, unknown>) {
			this.sent.push(event);
			if (event.type === "response.steer") this.releaseSteer();
		}

		close() {
			this.socket.readyState = 3;
			this.resolveClosed();
		}

		async *stream() {
			if (fakeWSState.mode === "ephemeral") {
				const requestIndex = fakeWSState.instances.indexOf(this);
				const responseId = requestIndex === 0 ? "response-ephemeral-a" : "response-ephemeral-b";
				yield { type: "message", message: { type: "response.created", response: { id: responseId } } };
				this.resolveCreated();
				if (requestIndex === 0 && fakeWSState.ephemeralAsync) {
					yield {
						type: "message",
						message: {
							type: "response.output_item.added",
							output_index: 0,
							item: {
								type: "function_call",
								id: "fc-ephemeral",
								call_id: "call-ephemeral",
								name: "work",
								arguments: "{}",
								async: true,
							},
						},
					};
					yield {
						type: "message",
						message: {
							type: "response.output_item.done",
							output_index: 0,
							item: {
								type: "function_call",
								id: "fc-ephemeral",
								call_id: "call-ephemeral",
								name: "work",
								arguments: "{}",
								async: true,
							},
						},
					};
				} else if (requestIndex === 0) {
					yield {
						type: "message",
						message: {
							type: "response.output_item.added",
							output_index: 0,
							item: {
								type: "message",
								id: "msg-ephemeral",
								role: "assistant",
								status: "in_progress",
								content: [],
							},
						},
					};
					yield {
						type: "message",
						message: {
							type: "response.output_item.done",
							output_index: 0,
							item: {
								type: "message",
								id: "msg-ephemeral",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "first answer", annotations: [] }],
							},
						},
					};
				}
				yield {
					type: "message",
					message: { type: "response.completed", response: { id: responseId, status: "completed" } },
				};
				return;
			}
			if (fakeWSState.mode === "cancelled") {
				yield { type: "message", message: { type: "response.created", response: { id: "response-cancelled" } } };
				this.resolveCreated();
				await this.closed;
				return;
			}
			if (fakeWSState.mode === "failed") {
				yield { type: "message", message: { type: "response.created", response: { id: "response-active" } } };
				this.resolveCreated();
				await this.steerReceived;
				yield { type: "message", message: { type: "response.steer.failed" } };
				yield {
					type: "message",
					message: { type: "response.completed", response: { id: "response-active", status: "completed" } },
				};
				return;
			}
			if (fakeWSState.mode === "duplicate-steer" && this.streamCount++ > 0) {
				yield { type: "message", message: { type: "response.created", response: { id: "response-after-steer" } } };
				yield {
					type: "message",
					message: { type: "response.completed", response: { id: "response-after-steer", status: "completed" } },
				};
				return;
			}
			if (fakeWSState.mode === "late-failed" && this.streamCount++ > 0) {
				yield {
					type: "message",
					message: { type: "response.created", response: { id: "response-after-failure" } },
				};
				yield {
					type: "message",
					message: { type: "response.completed", response: { id: "response-after-failure", status: "completed" } },
				};
				return;
			}
			if (fakeWSState.mode === "late-failed") {
				yield { type: "message", message: { type: "response.created", response: { id: "response-late-failure" } } };
				this.resolveCreated();
				await this.steerReceived;
				yield { type: "message", message: { type: "response.steer.accepted", steer: { id: "steer-late" } } };
				yield {
					type: "message",
					message: { type: "response.completed", response: { id: "response-late-failure", status: "completed" } },
				};
				yield { type: "message", message: { type: "response.steer.failed", steer: { id: "steer-late" } } };
				return;
			}
			if (fakeWSState.mode === "pending" && this.streamCount++ > 0) {
				yield { type: "message", message: { type: "response.created", response: { id: "response-after-tools" } } };
				yield {
					type: "message",
					message: {
						type: "response.completed",
						response: { id: "response-after-tools", status: "completed" },
					},
				};
				return;
			}
			if (fakeWSState.mode === "pending") {
				yield { type: "message", message: { type: "response.created", response: { id: "response-pending" } } };
				this.resolveCreated();
				await this.steerReceived;
				yield { type: "message", message: { type: "response.steer.accepted" } };
				yield {
					type: "message",
					message: {
						type: "response.output_item.added",
						output_index: 0,
						item: {
							type: "function_call",
							id: "fc-pending",
							call_id: "call-pending",
							name: "work",
							arguments: "{}",
						},
					},
				};
				yield {
					type: "message",
					message: {
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "function_call",
							id: "fc-pending",
							call_id: "call-pending",
							async: true,
							name: "work",
							arguments: "{}",
						},
					},
				};
				yield {
					type: "message",
					message: { type: "response.completed", response: { id: "response-pending", status: "completed" } },
				};
				yield { type: "message", message: { type: "response.steer.pending" } };
				return;
			}
			if (fakeWSState.mode === "async" && this.streamCount++ > 0) {
				yield { type: "message", message: { type: "response.created", response: { id: "response-latest" } } };
				yield {
					type: "message",
					message: { type: "response.completed", response: { id: "response-latest", status: "completed" } },
				};
				return;
			}
			if (fakeWSState.mode === "async") {
				yield { type: "message", message: { type: "response.created", response: { id: "response-async" } } };
				yield {
					type: "message",
					message: {
						type: "response.output_item.added",
						output_index: 0,
						item: {
							type: "function_call",
							id: "fc-async",
							call_id: "call-async",
							name: "work",
							arguments: "",
							async: true,
						},
					},
				};
				yield {
					type: "message",
					message: { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
				};
				yield {
					type: "message",
					message: {
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "function_call",
							id: "fc-async",
							call_id: "call-async",
							name: "work",
							arguments: "{}",
							async: true,
						},
					},
				};
				yield {
					type: "message",
					message: {
						type: "response.output_item.added",
						output_index: 1,
						item: {
							type: "message",
							id: "msg-after-tool",
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					},
				};
				yield {
					type: "message",
					message: {
						type: "response.output_item.done",
						output_index: 1,
						item: {
							type: "message",
							id: "msg-after-tool",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "still streaming", annotations: [] }],
						},
					},
				};
				yield {
					type: "message",
					message: { type: "response.completed", response: { id: "response-async", status: "completed" } },
				};
				return;
			}
			yield {
				type: "message",
				message: { type: "response.created", response: { id: "response-active" } },
			};
			this.resolveCreated();
			await this.steerReceived;
			yield { type: "message", message: { type: "response.steer.accepted" } };
			yield {
				type: "message",
				message: { type: "response.completed", response: { id: "response-active", status: "completed" } },
			};
			yield {
				type: "message",
				message: { type: "response.created", response: { id: "response-successor" } },
			};
			yield {
				type: "message",
				message: { type: "response.completed", response: { id: "response-successor", status: "completed" } },
			};
		}
	},
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: (params: Record<string, unknown>) => {
				capturedRequests.push(params);
				const id = `response-${++responseIndex}`;
				async function* responseEvents(): AsyncIterable<ResponseStreamEvent> {
					yield {
						type: "response.completed",
						sequence_number: 0,
						response: { id, status: "completed" },
					} as ResponseStreamEvent;
				}
				const data = responseEvents();
				const request = Promise.resolve(data) as Promise<AsyncIterable<ResponseStreamEvent>> & {
					withResponse(): Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
						response: { status: number; headers: Headers };
					}>;
				};
				request.withResponse = async () => ({ data, response: { status: 200, headers: new Headers() } });
				return request;
			},
		};
	}
	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-6-test",
		name: "GPT-6 Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 1000,
		compat: { supportsReasoningEffortUpdates: true },
	};
}

async function captureRequest(
	model: Model<"openai-responses">,
	messages: Message[],
	reasoningEffort: "low" | "medium" | "high",
): Promise<import("../src/types.ts").AssistantMessage> {
	const response = stream(model, normalizeContext({ messages: messages as never }), {
		apiKey: "test",
		reasoningEffort,
	});
	for await (const _event of response) {
		// Drain provider stream to complete the request.
	}
	return response.result();
}

describe("OpenAI Responses native controls serialization", () => {
	it("loads independent native capability flags from direct OpenAI model metadata", () => {
		for (const modelId of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const) {
			const compat = getModel("openai", modelId)?.compat;
			expect(compat).toMatchObject({
				supportsAsyncToolCalling: true,
				supportsNativeSteering: true,
				supportsReasoningEffortUpdates: true,
			});
		}
		expect(getModel("openai", "gpt-5.6-luna")?.compat).not.toMatchObject({
			supportsAsyncToolCalling: true,
			supportsNativeSteering: true,
			supportsReasoningEffortUpdates: true,
		});
	});

	it("pins request effort while successive configuration updates change effective effort", async () => {
		capturedRequests.length = 0;
		responseIndex = 0;
		const model = createModel();
		const initialUser = { role: "user" as const, content: "start", timestamp: 1 };
		const firstAssistant = await captureRequest(model, [initialUser], "low");
		const secondAssistant = await captureRequest(
			model,
			[initialUser, firstAssistant, { role: "system", content: "", reasoningEffortUpdate: "high", timestamp: 2 }],
			"high",
		);
		const thirdAssistant = await captureRequest(
			model,
			[
				initialUser,
				firstAssistant,
				{ role: "system", content: "", reasoningEffortUpdate: "high", timestamp: 2 },
				secondAssistant,
				{ role: "system", content: "", reasoningEffortUpdate: "medium", timestamp: 3 },
			],
			"medium",
		);
		await captureRequest(
			model,
			[
				initialUser,
				firstAssistant,
				{ role: "system", content: "", reasoningEffortUpdate: "high", timestamp: 2 },
				secondAssistant,
				{ role: "system", content: "", reasoningEffortUpdate: "medium", timestamp: 3 },
				thirdAssistant,
				{ role: "system", content: "", reasoningEffortUpdate: "low", timestamp: 4 },
			],
			"low",
		);

		expect(capturedRequests).toHaveLength(4);
		expect(capturedRequests.map((request) => (request.reasoning as { effort?: string }).effort)).toEqual([
			"low",
			"low",
			"low",
			"low",
		]);
		const secondInput = capturedRequests[1].input as Array<{ type?: string; reasoning?: { effort?: string } }>;
		const thirdInput = capturedRequests[2].input as Array<{ type?: string; reasoning?: { effort?: string } }>;
		const fourthInput = capturedRequests[3].input as Array<{ type?: string; reasoning?: { effort?: string } }>;
		expect(secondInput[0]).toEqual((capturedRequests[0].input as unknown[])[0]);
		expect(secondInput.find((item) => item.type === "configuration_update")?.reasoning?.effort).toBe("high");
		expect(thirdInput.filter((item) => item.type === "configuration_update").at(-1)?.reasoning?.effort).toBe(
			"medium",
		);
		expect(fourthInput.filter((item) => item.type === "configuration_update").at(-1)?.reasoning?.effort).toBe("low");
	});

	it("establishes a new reasoning baseline for a model or context window", async () => {
		capturedRequests.length = 0;
		responseIndex = 0;
		const model = createModel();
		const user = { role: "user" as const, content: "start", timestamp: 1 };
		const previousAssistant = await captureRequest(model, [user], "low");
		const switchedModel = { ...model, id: "gpt-6-next" };
		await captureRequest(switchedModel, [user, previousAssistant], "high");
		await captureRequest(
			model,
			[
				{
					role: "user",
					content: "compacted",
					reasoningEffortBaseline: true,
					timestamp: 4,
				},
				{ role: "user", content: "continue", timestamp: 5 },
			],
			"medium",
		);

		expect(capturedRequests.map((request) => (request.reasoning as { effort?: string }).effort)).toEqual([
			"low",
			"high",
			"medium",
		]);
	});

	it("keeps request-level effort behavior for models without update support", async () => {
		capturedRequests.length = 0;
		responseIndex = 0;
		const model = { ...createModel(), compat: {} };
		const user = { role: "user" as const, content: "start", timestamp: 1 };
		const assistant = await captureRequest(model, [user], "low");
		const next = await captureRequest(
			model,
			[user, assistant, { role: "system", content: "", reasoningEffortUpdate: "high", timestamp: 2 }],
			"high",
		);

		expect(capturedRequests.map((request) => (request.reasoning as { effort?: string }).effort)).toEqual([
			"low",
			"high",
		]);
		expect(
			(capturedRequests[1].input as Array<{ type?: string }>).some((item) => item.type === "configuration_update"),
		).toBe(false);
		expect(next.reasoningEffortBaseline).toBe("high");
	});

	it("replays reasoning updates on a fresh no-sessionId socket with the pinned baseline", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "ephemeral";
		fakeWSState.ephemeralAsync = false;
		const model = {
			...createModel(),
			compat: { supportsReasoningEffortUpdates: true, supportsNativeSteering: true },
		};
		const firstUser = { role: "user" as const, content: "first turn", timestamp: 1 };
		const first = stream(model, normalizeContext({ messages: [firstUser] }), {
			apiKey: "test",
			reasoningEffort: "low",
		});
		for await (const _event of first) {
			// Drain the first ephemeral response.
		}
		const firstAssistant = await first.result();
		const update = { role: "system" as const, content: "", reasoningEffortUpdate: "high" as const, timestamp: 2 };
		const secondUser = { role: "user" as const, content: "second turn", timestamp: 3 };
		const second = stream(model, normalizeContext({ messages: [firstUser, firstAssistant, update, secondUser] }), {
			apiKey: "test",
			reasoningEffort: "high",
		});
		for await (const _event of second) {
			// Drain the fresh full-history request.
		}

		const [socketA, socketB] = fakeWSState.instances as Array<{
			sent: Array<Record<string, unknown>>;
			socket: { readyState: number };
		}>;
		expect((await first.result()).responseId).toBe("response-ephemeral-a");
		expect(socketA.socket.readyState).toBe(3);
		expect(socketB.sent[0]).not.toHaveProperty("previous_response_id");
		const request = socketB.sent[0] as {
			reasoning?: { effort?: string };
			input: Array<{
				type?: string;
				role?: string;
				content?: Array<{ text?: string }>;
				reasoning?: { effort?: string };
			}>;
		};
		expect(request.reasoning?.effort).toBe("low");
		const updateIndex = request.input.findIndex((item) => item.type === "configuration_update");
		expect(request.input[updateIndex]).toMatchObject({ reasoning: { effort: "high" } });
		expect(request.input[updateIndex - 1]).toMatchObject({ role: "assistant" });
		expect(request.input[updateIndex + 1]).toMatchObject({ role: "user" });
	});

	it("replays a late async result by call_id on a fresh no-sessionId socket", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "ephemeral";
		fakeWSState.ephemeralAsync = true;
		const model = { ...createModel(), compat: { supportsAsyncToolCalling: true } };
		const tool = {
			name: "work",
			label: "Work",
			description: "Do work",
			parameters: { type: "object", properties: {} },
			async: true,
		} as unknown as Tool;
		const user = { role: "user" as const, content: "start", timestamp: 1 };
		const first = stream(model, normalizeContext({ messages: [user], tools: [tool] }), { apiKey: "test" });
		for await (const _event of first) {
			// The response finishes while the async tool result is still pending in Pi.
		}
		const assistant = await first.result();
		const call = assistant.content.find((item) => item.type === "toolCall");
		expect(call).toMatchObject({ id: "call-ephemeral|fc-ephemeral", async: true });

		const second = stream(
			model,
			normalizeContext({
				messages: [
					user,
					assistant,
					{
						role: "toolResult",
						toolCallId: call!.id,
						toolName: "work",
						content: [{ type: "text", text: "late result" }],
						isError: false,
						timestamp: 2,
					},
				],
				tools: [tool],
			}),
			{ apiKey: "test" },
		);
		for await (const _event of second) {
			// Drain the fresh full-history continuation.
		}

		const [socketA, socketB] = fakeWSState.instances as Array<{
			sent: Array<Record<string, unknown>>;
			socket: { readyState: number };
		}>;
		expect((await first.result()).responseId).toBe("response-ephemeral-a");
		expect(socketA.socket.readyState).toBe(3);
		expect(socketB.sent[0]).not.toHaveProperty("previous_response_id");
		const replay = (socketB.sent[0] as { input: Array<Record<string, unknown>> }).input;
		expect(replay).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "function_call", call_id: "call-ephemeral" }),
				expect.objectContaining({ type: "function_call_output", call_id: "call-ephemeral", output: "late result" }),
			]),
		);
	});

	it("steers an active response on the same WebSocket and follows its successor", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "steering";
		const model = { ...createModel(), compat: { supportsNativeSteering: true } };
		const response = stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "start", timestamp: 1 }] }),
			{ apiKey: "test" },
		);
		const events = (async () => {
			for await (const _event of response) {
				// Drain until successor response completes.
			}
		})();
		await vi.waitFor(() => expect(fakeWSState.instances).toHaveLength(1));
		const ws = fakeWSState.instances[0] as {
			sent: Record<string, unknown>[];
			created: Promise<void>;
		};
		await ws.created;
		const staleController = response.activeResponseController;
		await expect(
			staleController?.steer({ role: "user", content: "Leave auth.ts unchanged.", timestamp: 2 }),
		).resolves.toBe(true);
		await events;

		expect(ws.sent[0]).toMatchObject({ type: "response.create" });
		expect(ws.sent[1]).toMatchObject({
			type: "response.steer",
			previous_response_id: "response-active",
			input: [{ role: "user", content: [{ type: "input_text", text: "Leave auth.ts unchanged." }] }],
		});
		expect(await response.result()).toMatchObject({ responseId: "response-successor", stopReason: "stop" });
		expect(ws.sent).toHaveLength(2);
		expect(response.activeResponseController).toBeUndefined();
		await expect(staleController?.steer({ role: "user", content: "too late", timestamp: 3 })).resolves.toBe(false);
		expect(ws.sent).toHaveLength(2);
	});

	it("removes only the accepted copy of repeated steering text during continuation", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "duplicate-steer";
		const model = { ...createModel(), compat: { supportsNativeSteering: true } };
		const initial = { role: "user" as const, content: "start", timestamp: 1 };
		const steer = { role: "user" as const, content: "repeat this", timestamp: 2 };
		const first = stream(model, normalizeContext({ messages: [initial] }), {
			apiKey: "test",
			sessionId: "duplicate-steer-test",
		});
		const completed = (async () => {
			for await (const _event of first) {
				// Drain the active response.
			}
		})();
		await vi.waitFor(() => expect(fakeWSState.instances).toHaveLength(1));
		const ws = fakeWSState.instances[0] as { created: Promise<void> };
		await ws.created;
		await expect(first.activeResponseController?.steer(steer)).resolves.toBe(true);
		await completed;

		const continuation = stream(
			model,
			normalizeContext({ messages: [initial, await first.result(), steer, { ...steer, timestamp: 3 }] }),
			{ apiKey: "test", sessionId: "duplicate-steer-test" },
		);
		for await (const _event of continuation) {
			// Drain the continuation.
		}
		const sent = (fakeWSState.instances[0] as { sent: Record<string, unknown>[] }).sent;
		const request = sent[1] as { input: Array<{ content?: Array<{ text?: string }> }> };
		expect(request.input.filter((item) => item.content?.some((part) => part.text === "repeat this"))).toHaveLength(1);
	});

	it("returns rejected steering so Pi can keep its queued fallback", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "failed";
		const model = { ...createModel(), compat: { supportsNativeSteering: true } };
		const response = stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "start", timestamp: 1 }] }),
			{ apiKey: "test", sessionId: "failed-steer-test" },
		);
		const completed = (async () => {
			for await (const _event of response) {
				// Drain until the failed steering event and response terminal event.
			}
		})();
		await vi.waitFor(() => expect(fakeWSState.instances).toHaveLength(1));
		const ws = fakeWSState.instances[0] as { created: Promise<void> };
		await ws.created;
		await expect(
			response.activeResponseController?.steer({ role: "user", content: "try again", timestamp: 2 }),
		).resolves.toBe(false);
		await completed;
		expect((await response.result()).stopReason).toBe("stop");
	});

	it("does not reuse a session WebSocket after API credentials change", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "async";
		const model = { ...createModel(), compat: { supportsNativeSteering: true } };
		const user = { role: "user" as const, content: "start", timestamp: 1 };
		const first = stream(model, normalizeContext({ messages: [user] }), {
			apiKey: "first-key",
			sessionId: "credential-change-test",
		});
		for await (const _event of first) {
			// Drain the first authenticated connection.
		}
		const second = stream(model, normalizeContext({ messages: [user, await first.result()] }), {
			apiKey: "second-key",
			sessionId: "credential-change-test",
		});
		for await (const _event of second) {
			// Drain the replacement connection.
		}

		expect(fakeWSState.instances).toHaveLength(2);
		const replacement = fakeWSState.instances[1] as { sent: Record<string, unknown>[] };
		expect(replacement.sent[0]).not.toHaveProperty("previous_response_id");
	});

	it("replays full history after a cached WebSocket disconnects", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "async";
		const model = { ...createModel(), compat: { supportsNativeSteering: true } };
		const user = { role: "user" as const, content: "start", timestamp: 1 };
		const first = stream(model, normalizeContext({ messages: [user] }), {
			apiKey: "test",
			sessionId: "disconnect-replay-test",
		});
		for await (const _event of first) {
			// Drain the first response.
		}
		const original = fakeWSState.instances[0] as { socket: { readyState: number } };
		original.socket.readyState = 3;
		const second = stream(model, normalizeContext({ messages: [user, await first.result()] }), {
			apiKey: "test",
			sessionId: "disconnect-replay-test",
		});
		for await (const _event of second) {
			// Drain the replacement response.
		}

		expect(fakeWSState.instances).toHaveLength(2);
		const replacement = fakeWSState.instances[1] as { sent: Record<string, unknown>[] };
		expect(replacement.sent[0]).not.toHaveProperty("previous_response_id");
		expect(replacement.sent[0].input).toEqual(
			expect.arrayContaining([
				{ role: "user", content: [{ type: "input_text", text: "start" }] },
				expect.objectContaining({ type: "function_call", call_id: "call-async", async: true }),
			]),
		);
	});

	it("closes an active WebSocket when the request is cancelled", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "cancelled";
		const model = { ...createModel(), compat: { supportsNativeSteering: true } };
		const abortController = new AbortController();
		const response = stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "start", timestamp: 1 }] }),
			{ apiKey: "test", sessionId: "cancelled-response-test", signal: abortController.signal },
		);
		const completed = (async () => {
			for await (const _event of response) {
				// Drain until cancellation closes the response.
			}
		})();
		await vi.waitFor(() => expect(fakeWSState.instances).toHaveLength(1));
		const ws = fakeWSState.instances[0] as { created: Promise<void> };
		await ws.created;
		abortController.abort();
		await completed;

		expect((await response.result()).stopReason).toBe("aborted");
	});

	it("replays a steer when the server later rejects an accepted steering event", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "late-failed";
		const model = { ...createModel(), compat: { supportsNativeSteering: true } };
		const user = { role: "user" as const, content: "start", timestamp: 1 };
		const steer = { role: "user" as const, content: "keep the file unchanged", timestamp: 2 };
		const first = stream(model, normalizeContext({ messages: [user] }), {
			apiKey: "test",
			sessionId: "late-failed-steer-test",
		});
		const firstEvents = (async () => {
			for await (const _event of first) {
				// Drain the original response and late failure event.
			}
		})();
		await vi.waitFor(() => expect(fakeWSState.instances).toHaveLength(1));
		const ws = fakeWSState.instances[0] as { sent: Record<string, unknown>[]; created: Promise<void> };
		await ws.created;
		await expect(first.activeResponseController?.steer(steer)).resolves.toBe(true);
		await firstEvents;
		const assistant = await first.result();
		const next = stream(model, normalizeContext({ messages: [user, assistant, steer] }), {
			apiKey: "test",
			sessionId: "late-failed-steer-test",
		});
		for await (const _event of next) {
			// Drain the continuation.
		}

		expect(ws.sent[2]).toMatchObject({
			type: "response.create",
			previous_response_id: "response-late-failure",
			input: [{ role: "user", content: [{ type: "input_text", text: "keep the file unchanged" }] }],
		});
	});

	it("accepts pending steering and sends only the tool result in its continuation", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "pending";
		const model = { ...createModel(), compat: { supportsAsyncToolCalling: true, supportsNativeSteering: true } };
		const tool = {
			name: "work",
			label: "Work",
			description: "Do work",
			parameters: { type: "object", properties: {} },
			async: true,
		} as unknown as Tool;
		const user = { role: "user" as const, content: "start", timestamp: 1 };
		const first = stream(model, normalizeContext({ messages: [user], tools: [tool] }), {
			apiKey: "test",
			sessionId: "pending-steer-test",
		});
		const firstEvents = (async () => {
			for await (const _event of first) {
				// Drain until pending response ends.
			}
		})();
		await vi.waitFor(() => expect(fakeWSState.instances).toHaveLength(1));
		const ws = fakeWSState.instances[0] as { sent: Record<string, unknown>[]; created: Promise<void> };
		await ws.created;
		await expect(
			first.activeResponseController?.steer({ role: "user", content: "Leave auth.ts unchanged.", timestamp: 2 }),
		).resolves.toBe(true);
		await firstEvents;
		const assistant = await first.result();
		const call = assistant.content.find((item) => item.type === "toolCall");
		const second = stream(
			model,
			normalizeContext({
				messages: [
					user,
					assistant,
					{
						role: "toolResult",
						toolCallId: call!.id,
						toolName: "work",
						content: [{ type: "text", text: "tool result" }],
						isError: false,
						timestamp: 3,
					},
					{ role: "user", content: "Leave auth.ts unchanged.", timestamp: 2 },
				],
				tools: [tool],
			}),
			{ apiKey: "test", sessionId: "pending-steer-test" },
		);
		for await (const _event of second) {
			// Drain pending continuation.
		}
		expect(ws.sent[2]).toMatchObject({
			type: "response.create",
			previous_response_id: "response-pending",
			input: [{ type: "function_call_output", call_id: "call-pending", output: "tool result" }],
		});
	});

	it("retains an async call_id and continues with the latest response ID", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "async";
		const model = { ...createModel(), compat: { supportsAsyncToolCalling: true } };
		const tool = {
			name: "work",
			label: "Work",
			description: "Do work",
			parameters: { type: "object", properties: {} },
			async: true,
		} as unknown as Tool;
		const user = { role: "user" as const, content: "start", timestamp: 1 };
		const first = stream(model, normalizeContext({ messages: [user], tools: [tool] }), {
			apiKey: "test",
			sessionId: "async-tool-test",
		});
		const firstEvents: string[] = [];
		for await (const event of first) firstEvents.push(event.type);
		const assistant = await first.result();
		const call = assistant.content.find((item) => item.type === "toolCall");
		expect(call).toMatchObject({ id: "call-async|fc-async", name: "work", async: true });
		expect(firstEvents.indexOf("toolcall_end")).toBeLessThan(firstEvents.indexOf("text_end"));

		const second = stream(
			model,
			normalizeContext({
				messages: [
					user,
					assistant,
					{
						role: "toolResult",
						toolCallId: call!.id,
						toolName: "work",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: 2,
					},
				],
				tools: [tool],
			}),
			{ apiKey: "test", sessionId: "async-tool-test" },
		);
		for await (const _event of second) {
			// Drain the follow-up response.
		}
		const ws = fakeWSState.instances[0] as { sent: Array<Record<string, unknown>> };
		expect(ws.sent[0]).toMatchObject({
			type: "response.create",
			tools: [{ name: "work", async: true }],
		});
		expect(ws.sent[1]).toMatchObject({
			type: "response.create",
			previous_response_id: "response-async",
			input: [{ type: "function_call_output", call_id: "call-async", output: "done" }],
		});
	});

	it("omits async tool calling when the caller forces SSE", async () => {
		capturedRequests.length = 0;
		fakeWSState.instances.length = 0;
		const model = { ...createModel(), compat: { supportsAsyncToolCalling: true } };
		const tool = {
			name: "work",
			label: "Work",
			description: "Do work",
			parameters: { type: "object", properties: {} },
			async: true,
		} as unknown as Tool;
		const response = stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "start", timestamp: 1 }], tools: [tool] }),
			{ apiKey: "test", transport: "sse" },
		);
		for await (const _event of response) {
			// Drain the HTTP stream.
		}

		expect(capturedRequests[0].tools).toMatchObject([{ name: "work" }]);
		expect((capturedRequests[0].tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty("async");
		expect(fakeWSState.instances).toHaveLength(0);
	});

	it("serializes async function tools only when the capability and tool opt in", () => {
		const tool = {
			name: "read_file",
			label: "Read file",
			description: "Read a file",
			parameters: { type: "object", properties: {} },
			async: true,
		} as unknown as Tool;
		expect(toToolDeclaration(tool).async).toBe(true);
		expect(convertResponsesTools([tool], { supportsAsyncToolCalling: true })).toMatchObject([{ async: true }]);
		expect(convertResponsesTools([tool], { supportsAsyncToolCalling: false })[0]).not.toHaveProperty("async");
	});

	it("places configuration_update after the existing input prefix", () => {
		const model = createModel();
		const prefix = { role: "user" as const, content: "keep this prefix", timestamp: 1 };
		const items = convertResponsesMessages(
			model,
			normalizeContext({
				messages: [prefix, { role: "system", content: "", reasoningEffortUpdate: "high", timestamp: 2 }],
			}),
			new Set(["openai"]),
			{ supportsReasoningEffortUpdates: true },
		);
		expect(items[0]).toMatchObject({ role: "user" });
		expect(items[1]).toMatchObject({ type: "configuration_update", reasoning: { effort: "high" } });
	});
});
