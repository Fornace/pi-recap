/**
 * Auto-goal pipeline for pi-recap.
 *
 * Two-pass derivation: turn 1 extracts an initial title from the first
 * exchange; turn 2 refines it with more context, returning either KEEP or a
 * replacement. After two applications the goal is locked (state.ts caps
 * goalAutoTurnsApplied at 2). Manual /goal also locks (goalSource = manual).
 *
 * Both functions stream tokens but do NOT forward deltas — goal updates are
 * not part of the live recap UI. The pipeline runs in parallel to the agent
 * recap, outside the live-UI promise chain in index.ts.
 *
 * v5: shares the picker chain + auto-blacklist semantics with recap.ts.
 * Result objects expose `cachedWinnerCleared` so the caller can drop the
 * goal-side cache slot independently from the recap-side cache.
 */

import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { extractConversationContext, buildHistory, extractTextFromMessage } from "./recap.js";
import { findFastModelChain, thinkingOffOpts } from "./picker.js";
import { addToBlacklist } from "../state/blacklist.js";
import type { CachedModel } from "../state/state.js";
import { logDebug, logError, logTrace } from "../util/log.js";

const ATTEMPT_TIMEOUT_MS = 15000;

const GOAL_INITIAL_SYSTEM = `You title work sessions. Read the conversation excerpt and return a single short noun phrase (max 60 chars) naming what the user is trying to accomplish. No verbs in imperative, no quotes, no markdown, no trailing punctuation. Title Case. Examples: "Auth refactor for /api/v2", "Investigate flaky CI on Linux", "Recap UI styling pass". If the user's intent is unclear, return exactly the token UNCLEAR.`;

const GOAL_REFINE_SYSTEM = (current: string): string =>
	`You title work sessions. The current title is: "${current}". Read the new conversation excerpt and decide if the title still captures the user's true intent now that more is known. If the existing title is still accurate, return exactly KEEP. Otherwise return ONE replacement title (noun phrase, max 60 chars, Title Case, no quotes/markdown/trailing punctuation).`;

export interface GoalResult {
	action: "update" | "keep";
	goal?: string;
	modelId: string;
}

export interface GoalOptions {
	preferredModelId?: string;
	/** Session model from ctx.model. Last-resort tier in the fallback chain. */
	sessionModel?: Model<Api>;
	/** Cached winner from a previous successful goal stream this session.
	 *  Hoisted to layer 2 of the picker chain when present and fresh. */
	cachedWinner?: CachedModel | undefined;
}

export interface GoalResponse {
	result: GoalResult | null;
	cachedWinnerCleared: boolean;
}

function cleanGoal(raw: string): string {
	const stripped = raw.replace(/```(?:[\w-]*)\n?/g, "").replace(/```/g, "").trim();
	const firstLine = stripped.split("\n").find((l) => l.trim())?.trim() ?? "";
	// Drop trailing punctuation and surrounding quotes if the model snuck them in.
	const dequoted = firstLine.replace(/^["'`]+|["'`]+$/g, "").trim();
	return dequoted.slice(0, 60);
}

function classifyFailure(err: unknown): string | undefined {
	const raw = err instanceof Error ? (err.message ?? "") : String(err ?? "");
	const lower = raw.toLowerCase();
	if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("too many requests")) {
		return undefined;
	}
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
	return `provider error: ${truncateReason(raw)}`;
}

function truncateReason(s: string): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > 60 ? oneLine.slice(0, 57) + "..." : oneLine;
}

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

async function streamOnce(
	registry: ModelRegistry,
	systemPrompt: string,
	userMessages: Message[],
	options: GoalOptions,
): Promise<{ raw: string; modelId: string; cachedWinnerCleared: boolean } | { result: null; cachedWinnerCleared: boolean }> {
	const chain = findFastModelChain(
		registry,
		options.preferredModelId,
		options.sessionModel,
		options.cachedWinner,
	);
	if (chain.length === 0) {
		logError("goal: no fast model available");
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
			logDebug(`goal: auth not ready for ${model.id}, skipping`);
			continue;
		}

		let running = "";
		let sawTextDelta = false;
		let sawReasoning = false;
		let finalMessage: AssistantMessage | undefined;

		const drain = async (): Promise<void> => {
			const events = stream(
				model,
				{ messages: userMessages, systemPrompt },
				{
					apiKey: auth.apiKey!,
					headers: auth.headers || {},
					maxTokens: 64,
					temperature: 0,
					...thinkingOffOpts(model),
				},
			);
			for await (const event of events) {
				logTrace(`goal ${model.id} event=${event.type}`);
				if (event.type === "text_delta") {
					sawTextDelta = true;
					running += event.delta;
				} else if (event.type === "text_end") {
					if (!sawTextDelta && typeof event.content === "string" && event.content.length > 0) {
						running = event.content;
					}
				} else if (event.type === "done") {
					finalMessage = event.message;
				} else if (event.type === "error") {
					finalMessage = event.error;
					const reason = event.error?.errorMessage ?? `stop=${event.error?.stopReason}`;
					throw new Error(`provider error: ${reason}`);
				} else if (typeof event.type === "string" && event.type.toLowerCase().includes("thinking")) {
					sawReasoning = true;
				}
			}
			if (!running && finalMessage) {
				const fromMsg = extractTextFromMessage(finalMessage);
				if (fromMsg) running = fromMsg;
			}
		};

		try {
			await withTimeout(drain(), ATTEMPT_TIMEOUT_MS);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const reason = message.startsWith("timeout ") ? message : classifyFailure(err);
			handleFailure(model.id, reason, sacredOverride, sacredCachedId, sacredSessionId, () => {
				cachedWinnerCleared = true;
			});
			lastError = reason ?? "transient";
			continue;
		}

		if (!running.trim()) {
			const reason = sawReasoning ? "empty + reasoning" : "empty response";
			handleFailure(model.id, reason, sacredOverride, sacredCachedId, sacredSessionId, () => {
				cachedWinnerCleared = true;
			});
			lastError = reason;
			continue;
		}

		logDebug(`goal landed on ${model.id} (attempts: ${attempted.length})`);
		return { raw: running, modelId: model.id, cachedWinnerCleared };
	}

	logError(`goal: all fallback candidates failed (tried ${attempted.length}: ${attempted.join(", ")})`, lastError);
	return { result: null, cachedWinnerCleared };
}

function handleFailure(
	id: string,
	reason: string | undefined,
	sacredOverride: string | undefined,
	sacredCachedId: string | undefined,
	sacredSessionId: string | undefined,
	onCacheClear: () => void,
): void {
	const isOverride = sacredOverride === id;
	const isCached = sacredCachedId === id;
	const isSession = sacredSessionId === id;
	if (isCached) {
		onCacheClear();
		logDebug(`goal: cached winner ${id} failed (${reason ?? "transient"}); clearing cache`);
		return;
	}
	if (isOverride || isSession) {
		logDebug(`goal: sacred slot ${id} failed (${reason ?? "transient"}); not blacklisting`);
		return;
	}
	if (reason) {
		addToBlacklist(id, reason, "auto");
		logDebug(`goal: auto-blacklisted ${id}: ${reason}`);
	}
}

/**
 * Initial extraction — turn 1. Looks at user-side text-only context.
 * Returns null when the model is unavailable or returns UNCLEAR.
 */
export async function deriveGoalInitial(
	messages: readonly any[],
	registry: ModelRegistry,
	options: GoalOptions = {},
): Promise<GoalResponse> {
	const context = extractConversationContext(messages as Message[], 8);
	const userMessages = buildHistory(context);
	const out = await streamOnce(registry, GOAL_INITIAL_SYSTEM, userMessages, options);
	if ("result" in out) {
		return { result: null, cachedWinnerCleared: out.cachedWinnerCleared };
	}

	const cleaned = cleanGoal(out.raw);
	if (!cleaned) return { result: null, cachedWinnerCleared: out.cachedWinnerCleared };
	if (cleaned.toUpperCase() === "UNCLEAR") {
		// Still a successful stream -- treat as keep, modelId still valid.
		return { result: { action: "keep", modelId: out.modelId }, cachedWinnerCleared: out.cachedWinnerCleared };
	}

	return {
		result: { action: "update", goal: cleaned, modelId: out.modelId },
		cachedWinnerCleared: out.cachedWinnerCleared,
	};
}

/**
 * Refinement check — turn 2. Given the existing goal, decides KEEP or replaces.
 */
export async function deriveGoalRefine(
	currentGoal: string,
	messages: readonly any[],
	registry: ModelRegistry,
	options: GoalOptions = {},
): Promise<GoalResponse> {
	const context = extractConversationContext(messages as Message[], 8);
	const userMessages = buildHistory(context);
	const out = await streamOnce(registry, GOAL_REFINE_SYSTEM(currentGoal), userMessages, options);
	if ("result" in out) {
		return { result: null, cachedWinnerCleared: out.cachedWinnerCleared };
	}

	const cleaned = cleanGoal(out.raw);
	if (!cleaned) {
		return { result: { action: "keep", modelId: out.modelId }, cachedWinnerCleared: out.cachedWinnerCleared };
	}
	if (cleaned.toUpperCase() === "KEEP") {
		return { result: { action: "keep", modelId: out.modelId }, cachedWinnerCleared: out.cachedWinnerCleared };
	}

	return {
		result: { action: "update", goal: cleaned, modelId: out.modelId },
		cachedWinnerCleared: out.cachedWinnerCleared,
	};
}
