/**
 * Replay state from session branch.
 *
 * Walks the branch chronologically; the last matching custom entry wins.
 * Streaming flags are stripped on replay -- a row that was mid-stream when
 * the session was last persisted shouldn't come back as a zombie spinner.
 *
 * Migration:
 *   - Pre-auto-goal sessions had no goalSource field. If a non-empty goal is
 *     present we treat it as manually locked so the next agent_end won't
 *     overwrite a hand-picked title.
 *   - v4.1 sessions stored cachedRecapModelId / cachedGoalModelId as bare
 *     strings. v5 wraps both in {id, cachedAt}; we synthesize cachedAt = 0
 *     so isCachedModelFresh treats them as expired and forces a re-walk.
 *     The user-visible effect: the first turn after upgrading walks the
 *     curated chain instead of trusting an unbounded-age cache.
 */

import type { CachedModel, GoalSource, Speaker, StatusState } from "./state.js";
import { EMPTY_STATE } from "./state.js";

interface CachedShape {
	id?: unknown;
	cachedAt?: unknown;
}

interface StatusDetails {
	goal: string;
	status: string;
	history: Array<{ id: number; timestamp: number; recap: string; speaker?: Speaker; streaming?: boolean }>;
	nextId: number;
	lastModel?: string;
	modelOverride?: string;
	goalSource?: GoalSource;
	goalAutoTurnsApplied?: number;
	/** v5 wrapped shape. */
	cachedRecapModel?: CachedShape;
	cachedGoalModel?: CachedShape;
	/** v4.1 legacy bare-string shape, migrated to expired CachedModel below. */
	cachedRecapModelId?: string;
	cachedGoalModelId?: string;
}

function isStatusDetails(value: unknown): value is StatusDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.goal === "string" &&
		typeof v.status === "string" &&
		Array.isArray(v.history) &&
		typeof v.nextId === "number"
	);
}

/**
 * Coerce one persisted cached-model field into CachedModel | undefined.
 * Accepts:
 *   - the v5 wrapped shape {id, cachedAt}
 *   - the legacy bare-string field name (passed via legacyId)
 * Legacy entries get cachedAt = 0 so isCachedModelFresh marks them expired.
 */
function coerceCached(wrapped: CachedShape | undefined, legacyId: string | undefined): CachedModel | undefined {
	if (wrapped && typeof wrapped.id === "string" && wrapped.id.length > 0) {
		const at = typeof wrapped.cachedAt === "number" ? wrapped.cachedAt : 0;
		return { id: wrapped.id, cachedAt: at };
	}
	if (typeof legacyId === "string" && legacyId.length > 0) {
		return { id: legacyId, cachedAt: 0 };
	}
	return undefined;
}

export function replayFromBranch(ctx: {
	sessionManager: { getBranch(): Iterable<unknown> };
}): StatusState {
	let result: StatusState = { ...EMPTY_STATE, history: [] };

	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as {
			type?: string;
			customType?: string;
			data?: unknown;
		};
		if (e.type !== "custom" || e.customType !== "recap") continue;
		if (!isStatusDetails(e.data)) continue;

		const hasGoalFields = e.data.goalSource !== undefined;
		const migratedSource: GoalSource = hasGoalFields
			? (e.data.goalSource as GoalSource)
			: (e.data.goal ? "manual" : "auto");
		const migratedTurns = hasGoalFields
			? (typeof e.data.goalAutoTurnsApplied === "number" ? e.data.goalAutoTurnsApplied : 0)
			: (e.data.goal ? 2 : 0);

		// Strip streaming flag on replay. A persisted streaming entry means the
		// session was killed mid-stream; we keep whatever text made it in but
		// the row is no longer "live".
		const cleanHistory = e.data.history
			.filter((h) => h.recap && h.recap.length > 0)
			.map((h) => ({
				id: h.id,
				timestamp: h.timestamp,
				recap: h.recap,
				speaker: h.speaker,
			}));

		result = {
			goal: e.data.goal,
			goalSource: migratedSource,
			goalAutoTurnsApplied: migratedTurns,
			status: e.data.status,
			history: cleanHistory,
			nextId: e.data.nextId,
			lastModel: typeof e.data.lastModel === "string" ? e.data.lastModel : undefined,
			modelOverride: typeof e.data.modelOverride === "string" ? e.data.modelOverride : undefined,
			cachedRecapModel: coerceCached(e.data.cachedRecapModel, e.data.cachedRecapModelId),
			cachedGoalModel: coerceCached(e.data.cachedGoalModel, e.data.cachedGoalModelId),
		};
	}

	return result;
}
