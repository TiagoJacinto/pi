import OpenAI from "openai";
import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
	ResponsesClientEvent,
} from "openai/resources/responses/responses.js";
import { ResponsesWS } from "openai/resources/responses/ws";
import { clampThinkingLevel } from "../models.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type {
	ActiveResponseController,
	Api,
	AssistantMessage,
	CacheRetention,
	Model,
	ModelThinkingLevel,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getDeclaredTools, normalizeContext, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
		supportsAsyncToolCalling: model.compat?.supportsAsyncToolCalling ?? false,
		supportsNativeSteering: model.compat?.supportsNativeSteering ?? false,
		supportsReasoningEffortUpdates: model.compat?.supportsReasoningEffortUpdates ?? false,
	};
}

function getReasoningEffortBaseline(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	selectedEffort: ModelThinkingLevel | undefined,
): ModelThinkingLevel {
	let pinnedEffort: OpenAIResponsesOptions["reasoningEffort"];
	let baselineEstablished = false;
	for (const message of context.messages) {
		if ((message.role === "system" || message.role === "user") && message.reasoningEffortBaseline) {
			pinnedEffort = selectedEffort;
			baselineEstablished = true;
		}
		if (
			message.role === "assistant" &&
			message.api === model.api &&
			message.provider === model.provider &&
			message.model === model.id &&
			message.providerContextWindow === model.contextWindow &&
			!baselineEstablished
		) {
			pinnedEffort ??= (message.reasoningEffortBaseline ?? message.effectiveThinkingLevel) as
				| OpenAIResponsesOptions["reasoningEffort"]
				| undefined;
		}
	}
	return pinnedEffort ?? selectedEffort ?? "off";
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? "24h"
		: undefined;
}

function getPromptCacheOptions(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): { mode?: "explicit"; ttl?: "30m" } | undefined {
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	if (cacheRetention === "none") return { mode: "explicit" };
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "30m" };
	return undefined;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: ModelThinkingLevel;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const compat = getCompat(model);
	const normalizedContext = resolveTranscript(
		context,
		compat.supportsMidConvoSystemMessages || compat.supportsReasoningEffortUpdates,
	);

	// Start async processing
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			// Create OpenAI client
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const useResponsesWebSocket =
				(compat.supportsNativeSteering || compat.supportsAsyncToolCalling) && options?.transport !== "sse";
			const client = createClient(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				options?.fetch,
				cacheSessionId,
				useResponsesWebSocket,
			);
			const selectedEffort = options?.reasoningEffort;
			const requestEffort = compat.supportsReasoningEffortUpdates
				? getReasoningEffortBaseline(model, normalizedContext, selectedEffort)
				: selectedEffort;
			let params = buildParams(
				model,
				normalizedContext,
				{ ...options, reasoningEffort: requestEffort },
				compat,
				grammarToolInputProperties,
			);
			output.providerThinkingLevel = params.reasoning?.effort ?? requestEffort;
			output.reasoningEffortBaseline = requestEffort as AssistantMessage["reasoningEffortBaseline"];
			output.effectiveThinkingLevel = options?.reasoningEffort;
			output.providerContextWindow = model.contextWindow;
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			if (useResponsesWebSocket) {
				const cacheKey = options?.sessionId
					? `${options.sessionId}\0${model.provider}\0${model.id}\0${model.contextWindow}`
					: undefined;
				let session = cacheKey ? openAIResponsesWebSocketSessions.get(cacheKey) : undefined;
				if (session && session.connection.socket.readyState > 1) {
					openAIResponsesWebSocketSessions.delete(cacheKey!);
					session = undefined;
				} else if (session && (session.baseUrl !== model.baseUrl || session.apiKey !== apiKey)) {
					closeResponsesWebSocket(session.connection, "request credentials changed");
					openAIResponsesWebSocketSessions.delete(cacheKey!);
					session = undefined;
				}
				if (!session) {
					session = {
						connection: new ResponsesWS(client),
						apiKey,
						baseUrl: model.baseUrl,
					};
					if (cacheKey) openAIResponsesWebSocketSessions.set(cacheKey, session);
				}
				const activeSession = session;
				try {
					const steering = createResponsesSteeringController(activeSession.connection);
					if (compat.supportsNativeSteering) stream.activeResponseController = steering.controller;
					stream.push({ type: "start", partial: output });
					const { stream: _stream, ...fullBody } = params;
					const requestBody = buildOpenAIResponsesWebSocketRequest(
						{ ...fullBody, input: (fullBody.input ?? []) as ResponseInput },
						activeSession,
					);
					if (options?.signal?.aborted) throw new Error("Request was aborted");
					activeSession.connection.send({ type: "response.create", ...requestBody } as ResponsesClientEvent);
					const abortResponse = () => closeResponsesWebSocket(activeSession.connection, "request aborted");
					options?.signal?.addEventListener("abort", abortResponse, { once: true });
					try {
						await processResponsesStream(
							responsesWebSocketEvents(activeSession.connection, steering.state, activeSession),
							output,
							stream,
							model,
							{
								onProviderStreamEvent: options?.onProviderStreamEvent,
								serviceTier: options?.serviceTier,
								grammarToolInputProperties,
								applyServiceTierPricing: (usage, serviceTier) =>
									applyServiceTierPricing(usage, serviceTier, model),
							},
						);
					} finally {
						options?.signal?.removeEventListener("abort", abortResponse);
					}
					activeSession.lastRequestBody = { ...fullBody, input: (fullBody.input ?? []) as ResponseInput };
					activeSession.lastResponseId = output.responseId;
					activeSession.lastResponseItems = convertResponsesMessages(
						model,
						normalizeContext({ messages: [output] }),
						OPENAI_TOOL_CALL_PROVIDERS,
						{ includeSystemPrompt: false, grammarToolInputProperties },
					).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
				} catch (error) {
					if (cacheKey && openAIResponsesWebSocketSessions.get(cacheKey) === activeSession) {
						openAIResponsesWebSocketSessions.delete(cacheKey);
					}
					closeResponsesWebSocket(activeSession.connection, "response failed");
					throw error;
				} finally {
					stream.activeResponseController = undefined;
					if (!cacheKey) closeResponsesWebSocket(activeSession.connection, "response complete");
				}
			} else {
				const requestOptions = {
					...(options?.signal ? { signal: options.signal } : {}),
					...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
					maxRetries: 0,
				};
				const { data: openaiStream, response } = await retryProviderRequest(
					() => client.responses.create(params, requestOptions).withResponse(),
					{
						maxRetries: options?.maxRetries,
						maxRetryDelayMs: options?.maxRetryDelayMs,
						signal: options?.signal,
					},
				);
				await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
				stream.push({ type: "start", partial: output });
				await processResponsesStream(openaiStream, output, stream, model, {
					onProviderStreamEvent: options?.onProviderStreamEvent,
					serviceTier: options?.serviceTier,
					grammarToolInputProperties,
					applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
				});
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(
				normalizeProviderError(error),
				`${model.provider === "openai" ? "OpenAI" : model.provider} API error`,
			);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

type OpenAIResponsesWebSocketRequest = Omit<
	ResponseCreateParamsStreaming,
	"stream" | "input" | "previous_response_id"
> & {
	input: ResponseInput;
	previous_response_id?: string | null;
};

type OpenAIResponsesWebSocketSession = {
	connection: ResponsesWS;
	apiKey: string;
	baseUrl: string;
	lastRequestBody?: OpenAIResponsesWebSocketRequest;
	lastResponseId?: string;
	lastResponseItems?: ResponseInput;
	acceptedSteerInputs?: Array<{ steerId?: string; input: ResponseInput }>;
};

const openAIResponsesWebSocketSessions = new Map<string, OpenAIResponsesWebSocketSession>();

function closeOpenAIResponsesWebSocketSessions(sessionId?: string): void {
	for (const [key, session] of openAIResponsesWebSocketSessions) {
		if (sessionId && !key.startsWith(`${sessionId}\0`)) continue;
		closeResponsesWebSocket(session.connection, "session cleanup");
		openAIResponsesWebSocketSessions.delete(key);
	}
}

registerSessionResourceCleanup(closeOpenAIResponsesWebSocketSessions);

function closeResponsesWebSocket(connection: ResponsesWS, reason: string): void {
	try {
		connection.close({ code: 1000, reason });
	} catch {
		// A provider may already have closed the socket after an interrupted response.
	}
}

function buildOpenAIResponsesWebSocketRequest(
	body: OpenAIResponsesWebSocketRequest,
	session: OpenAIResponsesWebSocketSession,
): OpenAIResponsesWebSocketRequest {
	const previousBody = session.lastRequestBody;
	const previousResponseId = session.lastResponseId;
	const previousItems = session.lastResponseItems;
	if (!previousBody || !previousResponseId || !previousItems) {
		session.acceptedSteerInputs = [];
		return body;
	}

	const withoutInput = ({
		input: _input,
		previous_response_id: _previous,
		...rest
	}: OpenAIResponsesWebSocketRequest) => JSON.stringify(rest);
	if (withoutInput(body) !== withoutInput(previousBody)) {
		session.acceptedSteerInputs = [];
		return body;
	}

	const prefix = [...(previousBody.input ?? []), ...previousItems];
	if (body.input.length < prefix.length) {
		session.acceptedSteerInputs = [];
		return body;
	}
	if (JSON.stringify(body.input.slice(0, prefix.length)) !== JSON.stringify(prefix)) {
		session.acceptedSteerInputs = [];
		return body;
	}
	const delta = body.input.slice(prefix.length);
	const continuationInput = [...delta];
	for (const { input } of session.acceptedSteerInputs ?? []) {
		for (const steer of input) {
			const duplicateIndex = continuationInput.findIndex((item) => JSON.stringify(item) === JSON.stringify(steer));
			if (duplicateIndex >= 0) continuationInput.splice(duplicateIndex, 1);
		}
	}
	session.acceptedSteerInputs = [];
	return {
		...body,
		previous_response_id: previousResponseId,
		input: continuationInput,
	};
}

interface ResponsesSteeringState {
	responseId?: string;
	acceptedSteers: number;
	waitingForToolOutput: boolean;
	pendingAcks: Array<{ resolve: (accepted: boolean) => void; input: ResponseInput; sent: boolean }>;
}

function createResponsesSteeringController(connection: ResponsesWS): {
	controller: ActiveResponseController;
	state: ResponsesSteeringState;
} {
	const state: ResponsesSteeringState = {
		acceptedSteers: 0,
		waitingForToolOutput: false,
		pendingAcks: [],
	};
	return {
		state,
		controller: {
			steer(input) {
				if (state.waitingForToolOutput) return Promise.resolve(false);
				const content =
					typeof input.content === "string"
						? [{ type: "input_text", text: input.content }]
						: input.content.map((item) =>
								item.type === "text"
									? { type: "input_text", text: item.text }
									: {
											type: "input_image",
											detail: "auto",
											image_url: `data:${item.mimeType};base64,${item.data}`,
										},
							);
				const steeringInput = [{ role: "user", content }] as ResponseInput;
				return new Promise((resolve) => {
					state.pendingAcks.push({ resolve, input: steeringInput, sent: false });
					if (state.responseId) sendPendingSteers(connection, state);
				});
			},
		},
	};
}

function sendPendingSteers(connection: ResponsesWS, state: ResponsesSteeringState): void {
	if (!state.responseId) return;
	for (const pending of state.pendingAcks) {
		if (pending.sent) continue;
		pending.sent = true;
		try {
			// SAFETY: response.steer is documented by the Responses WebSocket protocol but absent from this SDK version's client-event union.
			connection.send({
				type: "response.steer",
				previous_response_id: state.responseId,
				input: pending.input,
			} as unknown as ResponsesClientEvent);
		} catch {
			state.pendingAcks.splice(state.pendingAcks.indexOf(pending), 1);
			pending.resolve(false);
		}
	}
}

async function* responsesWebSocketEvents(
	connection: ResponsesWS,
	state: ResponsesSteeringState,
	session: OpenAIResponsesWebSocketSession,
): AsyncGenerator<ResponseStreamEvent> {
	let responseFinished = false;
	try {
		for await (const message of connection.stream()) {
			if (message.type === "error") throw message.error;
			if (message.type !== "message") continue;
			const event = message.message as unknown as {
				type: string;
				response?: { id?: string; status?: string; incomplete_details?: { reason?: string } };
				steer?: { id?: string; input?: ResponseInput };
			};
			if (event.type === "response.created" && event.response?.id) {
				if (state.responseId && state.responseId !== event.response.id) state.acceptedSteers = 0;
				state.responseId = event.response.id;
				sendPendingSteers(connection, state);
			} else if (event.type === "response.steer.accepted") {
				state.acceptedSteers++;
				const pending = state.pendingAcks.shift();
				if (pending) {
					pending.resolve(true);
					session.acceptedSteerInputs ??= [];
					session.acceptedSteerInputs.push({ steerId: event.steer?.id, input: pending.input });
				}
			} else if (event.type === "response.steer.pending") {
				state.waitingForToolOutput = true;
			} else if (event.type === "response.steer.failed") {
				const acceptedIndex = session.acceptedSteerInputs?.findIndex((accepted) =>
					event.steer?.id
						? accepted.steerId === event.steer.id
						: JSON.stringify(accepted.input) === JSON.stringify(event.steer?.input),
				);
				if (acceptedIndex !== undefined && acceptedIndex >= 0) {
					session.acceptedSteerInputs?.splice(acceptedIndex, 1);
					state.acceptedSteers = Math.max(0, state.acceptedSteers - 1);
				}
				const pendingIndex = event.steer?.input
					? state.pendingAcks.findIndex(
							(pending) => JSON.stringify(pending.input) === JSON.stringify(event.steer?.input),
						)
					: event.steer?.id
						? -1
						: 0;
				if (pendingIndex >= 0) state.pendingAcks.splice(pendingIndex, 1)[0]?.resolve(false);
			}
			// SAFETY: WebSocket steering acknowledgements are Responses events not yet declared in the SDK event union.
			yield message.message as ResponseStreamEvent;
			if (event.type === "response.completed" || event.type === "response.incomplete") {
				responseFinished = true;
				if (state.waitingForToolOutput || state.acceptedSteers === 0) return;
			} else if (event.type === "response.steer.pending" && responseFinished) {
				// OpenAI reports pending required tool output after the original response terminal event.
				// Return control to Pi so it can execute the tool and continue on this socket.
				return;
			} else if (event.type === "response.steer.failed" && responseFinished && state.acceptedSteers === 0) {
				return;
			}
		}
	} finally {
		for (const pending of state.pendingAcks.splice(0)) pending.resolve(false);
	}
}

function createClient(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
	useResponsesWebSocket = false,
) {
	const compat = getCompat(model);
	const headers: ProviderHeaders = {
		"User-Agent": getPiUserAgent(),
		...(useResponsesWebSocket ? { "OpenAI-Beta": "responses_websockets=2026-02-06" } : {}),
		...model.headers,
	};
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

function buildParams(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat> = getCompat(model),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		compat.supportsOpenAIGrammarTools,
	),
) {
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		compat.supportsAdditionalTools || compat.supportsToolSearch,
	);
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages || compat.supportsReasoningEffortUpdates,
		supportsReasoningEffortUpdates: compat.supportsReasoningEffortUpdates,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
			supportsAsyncToolCalling: compat.supportsAsyncToolCalling && options?.transport !== "sse",
		},
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const params: ResponseCreateParamsStreaming & {
		prompt_cache_options?: { mode?: "explicit"; ttl?: "30m" };
	} = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: getPromptCacheOptions(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens && compat.supportsMaxOutputTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
			supportsAsyncToolCalling: compat.supportsAsyncToolCalling && options?.transport !== "sse",
		});
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ??
					(options.reasoningEffort === "off" ? "none" : options.reasoningEffort))
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}

	// Last so custom keys override the named request fields.
	if (options?.samplingParams) {
		Object.assign(params, options.samplingParams);
	}

	return params;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
