import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import { convertResponsesMessages, convertResponsesTools } from "../src/api/openai-responses-shared.ts";
import type { Message, Model, Tool } from "../src/types.ts";
import { normalizeContext, toToolDeclaration } from "../src/utils/transcript.ts";

const capturedRequests: Record<string, unknown>[] = [];
const fakeWSState = vi.hoisted(() => ({
	instances: [] as unknown[],
	mode: "steering" as "steering" | "pending" | "failed" | "async",
}));
let responseIndex = 0;

vi.mock("openai/resources/responses/ws", () => ({
	ResponsesWS: class FakeResponsesWS {
		sent: Record<string, unknown>[] = [];
		private releaseSteer!: () => void;
		private resolveCreated!: () => void;
		private streamCount = 0;
		readonly steerReceived = new Promise<void>((resolve) => {
			this.releaseSteer = resolve;
		});
		readonly created = new Promise<void>((resolve) => {
			this.resolveCreated = resolve;
		});

		constructor() {
			fakeWSState.instances.push(this);
		}

		send(event: Record<string, unknown>) {
			this.sent.push(event);
			if (event.type === "response.steer") this.releaseSteer();
		}

		close() {}

		async *stream() {
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
				yield { type: "message", message: { type: "response.steer.pending" } };
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
							name: "work",
							arguments: "{}",
						},
					},
				};
				yield {
					type: "message",
					message: { type: "response.completed", response: { id: "response-pending", status: "completed" } },
				};
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
						item: { type: "function_call", id: "fc-async", call_id: "call-async", name: "work", arguments: "" },
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
						item: { type: "function_call", id: "fc-async", call_id: "call-async", name: "work", arguments: "{}" },
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

	it("steers an active response on the same WebSocket and follows its successor", async () => {
		fakeWSState.instances.length = 0;
		fakeWSState.mode = "steering";
		const model = { ...createModel(), compat: { supportsNativeSteering: true } };
		const response = stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "start", timestamp: 1 }] }),
			{
				apiKey: "test",
				sessionId: "steering-test",
			},
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
		await expect(
			response.activeResponseController?.steer({ role: "user", content: "Leave auth.ts unchanged.", timestamp: 2 }),
		).resolves.toBe(true);
		await events;

		expect(ws.sent[0]).toMatchObject({ type: "response.create" });
		expect(ws.sent[1]).toMatchObject({
			type: "response.steer",
			previous_response_id: "response-active",
			input: [{ role: "user", content: [{ type: "input_text", text: "Leave auth.ts unchanged." }] }],
		});
		expect(await response.result()).toMatchObject({ responseId: "response-successor", stopReason: "stop" });
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
		expect(call).toMatchObject({ id: "call-async|fc-async", name: "work" });
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
