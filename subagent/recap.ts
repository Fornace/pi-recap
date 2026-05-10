/**
 * Sub-agent recap generation, isolated from the main thread (no context rot).
 *
 * Two streamed summaries per turn: one for what the user just asked
 * (`generateUserRecap`) and one for what the assistant did
 * (`generateAgentRecap`). Both stream tokens through `stream()` and forward
 * them to the optional `onDelta` so the widget can render live as text
 * arrives. The returned promise resolves to the cleaned final string
 * (markdown-stripped, first non-empty line, capped at 100 chars).
 *
 * v5 picker integration:
 *   - The picker chain is the 5-layer chain from picker.ts.
 *   - Per-attempt failures are classified into 4 buckets:
 *       * 4xx/5xx (NOT 429)             auto-blacklisted (404 retired etc.)
 *       * empty + reasoning              auto-blacklisted (broken for our use)
 *       * timeout 15s                    auto-blacklisted on non-sacred slots
 *       * 429 / transient                NOT auto-blacklisted; retry next turn
 *   - "Sacred" slots that are NEVER auto-blacklisted: override (layer 1),
 *     cached winner (layer 2 -- we clear the cache instead), and ctx.model
 *     (layer 5). Everything in layers 3 and 4 is fair game.
 */

import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { findFastModelChain, thinkingOffOpts } from "./picker.js";
import { addToBlacklist } from "../state/blacklist.js";
import type { CachedModel } from "../state/state.js";
import { logDebug, logError, logTrace } from "../util/log.js";

/** Per-attempt timeout. Anything slower than this on a non-sacred candidate
 *  gets auto-blacklisted; cached/override/ctx.model candidates only get the
 *  failure logged and skipped. */
const ATTEMPT_TIMEOUT_MS = 15000;

/**
 * List all fast/cheap models the user has keys for. Used by /recap-model
 * to surface the available options without an LLM call.
 */
export async function listAvailableFastModels(registry: ModelRegistry): Promise<string[]> {
	const available = registry.getAvailable();
	const auths = await Promise.all(
		available.map((model) => registry.getApiKeyAndHeaders(model).then((auth) => ({ model, auth }))),
	);
	return auths.filter(({ auth }) => auth.ok && auth.apiKey).map(({ model }) => model.id);
}

/**
 * Pick the picker's likely first attempt for the *next* stream, given the
 * current chain inputs. Used by index.ts to compose the session-start toast
 * BEFORE any recap actually fires. Returns the id (the actual stream() may
 * still pick something else if auth fails).
 */
export function previewFirstPick(
	registry: ModelRegistry,
	preferredId: string | undefined,
	sessionModel: Model<Api> | undefined,
	cachedWinner: CachedModel | undefined,
): string | undefined {
	const chain = findFastModelChain(registry, preferredId, sessionModel, cachedWinner);
	return chain[0]?.id;
}

/**
 * Extract text-only summary from recent messages for the sub-agent.
 * Strips tool calls, images, and other non-text content.
 *
 * Exported so subagent/goal.ts can reuse the same context shaper.
 */
export function extractConversationContext(messages: Message[], maxMessages: number = 8): string {
	// Only keep genuine conversational turns. Drop tool/bashExecution/custom-role
	// messages -- their text bodies are file or command output, not what was
	// said. Without this, a tool-result message carrying file contents would be
	// relabeled "User" by the role check below and the recap model would treat
	// the file as something the user typed (or the assistant did).
	const conversational = messages.filter((m) => m.role === "user" || m.role === "assistant");
	const recent = conversational.slice(-maxMessages);
	const lines: string[] = [];

	for (const msg of recent) {
		const role = msg.role === "assistant" ? "Assistant" : "User";
		const texts: string[] = [];

		if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part.type === "text" && typeof part.text === "string") {
					texts.push(part.text.trim());
				}
			}
		} else if (typeof msg.content === "string") {
			texts.push(msg.content.trim());
		}

		if (texts.length > 0) {
			const text = texts.join(" ");
			lines.push(`${role}: ${text.length > 500 ? text.slice(0, 500) + "…" : text}`);
		}
	}

	return lines.join("\n\n");
}

/**
 * Wrap conversation history for the LLM API.
 *
 * Exported so subagent/goal.ts can reuse the same wrap.
 */
export function buildHistory(context: string): Message[] {
	// Single user message keeps strict-alternation providers happy; framing
	// lives in the system prompt.
	return [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: context || "No conversation context available." }],
			timestamp: Date.now(),
		},
	];
}

const USER_RECAP_SYSTEM = `You summarize what a user just said in one short active sentence. Max 100 characters. Lead with a verb (asked, wants, requested, said, noted, greeted, agreed, …). Describe only what the user actually said — do not infer mood or intent that isn't in the message. Never use "you" or "your". No quotes, markdown, or labels. Just the sentence. Examples: "asked to clean up the empty state placeholder", "wants the recap to stream live as the agent responds", "greeted casually".`;

const AGENT_RECAP_SYSTEM = `You summarize what an assistant just did in one short active sentence. Max 100 characters. Lead with a verb (refactored, fixed, found, drafted, explained, answered, …). Summarize ONLY the assistant's natural-language reply — never describe file contents, command output, or tool results that appear in the context as if the assistant did them. No quotes, markdown, or labels. Just the sentence. Examples: "answered how the auth flow handles refresh tokens", "drafted a migration plan for the v2 schema", "fixed an off-by-one in the pagination clamp".`;

export interface RecapOptions {
	/** Called with the *running* raw text on every text_delta event. */
	onDelta?: (running: string) => void;
	/** Preferred model id (from user override). Falls back to auto if absent
	 *  or if its keys aren't configured. SACRED -- never auto-blacklisted. */
	preferredModelId?: string;
	/** Session model from ctx.model. Used as the last-resort tier in the
	 *  fallback chain, even if it's a reasoning model. SACRED. */
	sessionModel?: Model<Api>;
	/** Cached winner from a previous successful recap in this session.
	 *  Hoisted to layer 2 by findFastModelChain when present and fresh.
	 *  Failure CLEARS this slot (via cachedWinnerCleared); never blacklisted. */
	cachedWinner?: CachedModel | undefined;
}

export interface RecapResult {
	/** Cleaned recap line (≤100 chars, first non-empty line, no fences). */
	recap: string;
	/** ID of the model that actually produced the recap. */
	modelId: string;
}

function cleanRecap(raw: string): string {
	const stripped = raw.replace(/```(?:[\w-]*)\n?/g, "").replace(/```/g, "").trim();
	const firstLine = stripped.split("\n").find((l) => l.trim())?.trim() || stripped;
	return firstLine.slice(0, 100);
}

/**
 * Pull the concatenated TextContent text from an AssistantMessage. Used as
 * an authoritative fallback when a provider's stream emits no text_delta
 * events but lands a done event with the full content (some OpenRouter
 * upstreams behave this way - they buffer and flush everything as text_end
 * or only set message.content on done).
 */
export function extractTextFromMessage(msg: AssistantMessage | undefined): string {
	if (!msg || !Array.isArray(msg.content)) return "";
	const parts: string[] = [];
	for (const part of msg.content) {
		if (part && (part as { type?: string }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("");
}

/**
 * Classify a thrown error / message into a blacklist reason. Returns
 * undefined for transient errors (429, network blip) -- those SHOULD NOT
 * be auto-blacklisted; the next turn can retry the same model.
 */
function classifyFailure(err: unknown): string | undefined {
	const raw = err instanceof Error ? (err.message ?? "") : String(err ?? "");
	const lower = raw.toLowerCase();

	// 429 -- transient, never blacklist.
	if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("too many requests")) {
		return undefined;
	}

	// Specific status codes worth tagging.
	const statusMatch = raw.match(/\b(4\d\d|5\d\d)\b/);
	if (statusMatch) {
		const status = statusMatch[1];
		if (lower.includes("insufficient") || lower.includes("credits") || lower.includes("payment")) {
			return `${status} insufficient credits`;
		}
		if (status === "404" || lower.includes("not found") || lower.includes("retired")) {
			return `${status} endpoint retired`;
		}
		return `${status} ${truncateReason(raw)}`;
	}

	// Generic provider error fall-through.
	return `provider error: ${truncateReason(raw)}`;
}

function truncateReason(s: string): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > 60 ? oneLine.slice(0, 57) + "..." : oneLine;
}

/**
 * Race a stream-iteration loop against a timeout. Resolves with the partial
 * (running, sawTextDelta, finalMessage) on completion OR throws "timeout 15s"
 * if the timeout fires first. The stream's underlying promise is left to
 * resolve in the background -- we just stop reading from it.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout ${Math.round(ms / 1000)}s`)), ms);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

interface AttemptOutcome {
	result?: RecapResult;
	failure?: { reason: string | undefined };
}

/**
 * Stream the running raw text and return the cleaned final line. Walks the
 * v5 5-layer chain. On a failure that we can classify, the candidate may be
 * auto-blacklisted (only if it's a non-sacred slot -- not the override, not
 * the cached winner, not ctx.model).
 *
 * Returns:
 *   - { result } on success
 *   - { result: null, cachedWinnerCleared: true } if the failure path landed
 *     on the cached winner; the caller should drop the cache.
 *   - null if every candidate failed.
 *
 * Shared between user and agent recap variants - they only differ in the
 * system prompt and the input shaping.
 */
async function streamRecap(
	registry: ModelRegistry,
	systemPrompt: string,
	userMessages: Message[],
	options: RecapOptions,
): Promise<{ result: RecapResult | null; cachedWinnerCleared: boolean }> {
	const chain = findFastModelChain(
		registry,
		options.preferredModelId,
		options.sessionModel,
		options.cachedWinner,
	);
	if (chain.length === 0) {
		logError("no fast/cheap model (flash/mini/haiku/turbo) with valid API keys found");
		return { result: null, cachedWinnerCleared: false };
	}

	const sacredOverride = options.preferredModelId;
	const sacredCachedId = options.cachedWinner?.id;
	const sacredSessionId = options.sessionModel?.id;

	let lastError: unknown = undefined;
	let cachedWinnerCleared = false;
	const attempted: string[] = [];

	for (let i = 0; i < chain.length; i++) {
		const model = chain[i];
		if (!model) continue;
		attempted.push(model.id);
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			logDebug(`auth not ready for ${model.id}, skipping`);
			continue;
		}

		// Drop deltas to the UI on retries so the user doesn't see flickering
		// half-recaps from a model that errored out mid-stream.
		const isRetry = i > 0;
		const onDelta = isRetry ? undefined : options.onDelta;

		const outcome = await runOneAttempt(
			model,
			auth.apiKey,
			auth.headers || {},
			systemPrompt,
			userMessages,
			onDelta,
		);

		if (outcome.result) {
			if (isRetry) options.onDelta?.(outcome.result.recap);
			logDebug(`recap landed on ${model.id} (attempts: ${attempted.length})`);
			return { result: outcome.result, cachedWinnerCleared };
		}

		// Classify failure for auto-blacklist + cache-clear semantics.
		const reason = outcome.failure?.reason;
		const isOverride = sacredOverride === model.id;
		const isCached = sacredCachedId === model.id;
		const isSession = sacredSessionId === model.id;
		const sacredSlot = isOverride || isCached || isSession;

		if (isCached) {
			// Cached winner failed -- clear it; the caller's setCachedRecapModel
			// path won't fire because we won't return success here.
			cachedWinnerCleared = true;
			logDebug(`cached winner ${model.id} failed (${reason ?? "transient"}); clearing cache`);
		} else if (!sacredSlot && reason) {
			// Auto-blacklist with the classified reason. Transient (429) ->
			// reason is undefined -> we skip the blacklist.
			addToBlacklist(model.id, reason, "auto");
			logDebug(`auto-blacklisted ${model.id}: ${reason}`);
		} else if (sacredSlot && isOverride) {
			logDebug(`override ${model.id} failed this session (${reason ?? "transient"}); not blacklisting`);
		} else if (sacredSlot && isSession) {
			logDebug(`session model ${model.id} failed (${reason ?? "transient"}); not blacklisting`);
		}

		lastError = reason ?? "transient";
		continue;
	}

	logError(`all fallback candidates failed (tried ${attempted.length}: ${attempted.join(", ")})`, lastError);
	return { result: null, cachedWinnerCleared };
}

/**
 * Run one attempt against a single model. Returns the RecapResult on success
 * or a classified failure reason. Empty + reasoning evidence is detected by
 * watching for `thinking_*` events on a stream that produced no text.
 */
async function runOneAttempt(
	model: Model<Api>,
	apiKey: string,
	headers: Record<string, string>,
	systemPrompt: string,
	userMessages: Message[],
	onDelta: ((running: string) => void) | undefined,
): Promise<AttemptOutcome> {
	let running = "";
	let sawTextDelta = false;
	let sawReasoning = false;
	let finalMessage: AssistantMessage | undefined;

	const drain = async (): Promise<void> => {
		const events = stream(
			model,
			{ messages: userMessages, systemPrompt },
			{
				apiKey,
				headers,
				maxTokens: 256,
				temperature: 0,
				...thinkingOffOpts(model),
			},
		);
		for await (const event of events) {
			logTrace(`${model.id} event=${event.type}`);
			if (event.type === "text_delta") {
				sawTextDelta = true;
				running += event.delta;
				onDelta?.(running);
			} else if (event.type === "text_end") {
				if (!sawTextDelta && typeof event.content === "string" && event.content.length > 0) {
					running = event.content;
					onDelta?.(running);
				}
			} else if (event.type === "done") {
				finalMessage = event.message;
			} else if (event.type === "error") {
				finalMessage = event.error;
				const reason = event.error?.errorMessage ?? `stop=${event.error?.stopReason}`;
				throw new Error(`provider error: ${reason}`);
			} else if (typeof event.type === "string" && event.type.toLowerCase().includes("thinking")) {
				// Reasoning-tagged events (thinking_delta / thinking_end) on a
				// model that should have honoured thinking-off. Tracked so we
				// can blacklist "empty + reasoning" patterns specifically.
				sawReasoning = true;
			}
		}

		if (!running && finalMessage) {
			const fromMsg = extractTextFromMessage(finalMessage);
			if (fromMsg) {
				running = fromMsg;
				onDelta?.(running);
			}
		}
	};

	try {
		await withTimeout(drain(), ATTEMPT_TIMEOUT_MS);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.startsWith("timeout ")) {
			logDebug(`${model.id} timed out`);
			return { failure: { reason: message } };
		}
		const classified = classifyFailure(err);
		logDebug(`${model.id} failed (${message}), classifying as ${classified ?? "transient"}`);
		return { failure: { reason: classified } };
	}

	const final = cleanRecap(running);
	if (!final) {
		const reason = sawReasoning ? "empty + reasoning" : "empty response";
		logDebug(`${model.id} produced empty output (${reason})`);
		return { failure: { reason } };
	}
	return { result: { recap: final, modelId: model.id } };
}

/**
 * Stream a recap of what the user just asked. Takes the raw prompt string.
 * Caps the prompt at 4000 chars to keep token use bounded on rare large pastes.
 */
export async function generateUserRecap(
	prompt: string,
	registry: ModelRegistry,
	options: RecapOptions = {},
): Promise<{ result: RecapResult | null; cachedWinnerCleared: boolean }> {
	const truncated = prompt.slice(0, 4000);
	const userMessages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: truncated }],
			timestamp: Date.now(),
		},
	];
	return streamRecap(registry, USER_RECAP_SYSTEM, userMessages, options);
}

/**
 * Stream a recap of what the assistant just did. Takes the agent's emitted
 * messages from the agent_end event. Accepts the wider AgentMessage union
 * (custom roles, bashExecution, etc.) - extractConversationContext keeps only
 * user/assistant roles so file bodies and command output carried by tool /
 * bashExecution messages don't leak into the recap input.
 */
export async function generateAgentRecap(
	messages: readonly any[],
	registry: ModelRegistry,
	options: RecapOptions = {},
): Promise<{ result: RecapResult | null; cachedWinnerCleared: boolean }> {
	const context = extractConversationContext(messages as Message[], 8);
	const userMessages = buildHistory(context);
	return streamRecap(registry, AGENT_RECAP_SYSTEM, userMessages, options);
}
