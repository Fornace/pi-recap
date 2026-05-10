/**
 * State types for pi-recap.
 *
 * Each HistoryEntry is the unit the widget renders. Streaming uses
 * `streaming: true` plus the running raw text in `recap`. When a stream
 * completes, the orchestrator commits cleaned text and clears the flag,
 * which kicks the widget into a short "settle" animation.
 *
 * Multiple entries may have streaming = true at the same time (a user
 * recap and an agent recap can overlap). Animation state hangs off the
 * entry id, not a shared slot.
 *
 * v5 changes:
 *   - cachedRecapModel / cachedGoalModel are now objects with a `cachedAt`
 *     epoch ms so the picker can expire stale winners after 24h.
 *   - notice (transient, NOT persisted) drives the session-start toast in
 *     the title-right slot. Cleared by an animation tick after expiresAt.
 */

export type Speaker = "user" | "agent";

export interface HistoryEntry {
	id: number;
	timestamp: number;
	/** Recap text. While `streaming` is true this is the raw running tokens.
	 *  When the stream finishes it is replaced with the cleaned final string. */
	recap: string;
	/** Who the recap describes. "user" rows show "you" prefix, "agent" rows
	 *  show "pi". Optional for back-compat with pre-split persisted entries. */
	speaker?: Speaker;
	/** True while a recap is being streamed into this entry. The widget shows
	 *  spinner + shimmer if no text yet, or live text + caret if text is in. */
	streaming?: boolean;
}

export type GoalSource = "auto" | "manual";

/**
 * Cached winner from a previous successful stream. The `cachedAt` epoch
 * ms drives a 24h TTL: after 24h elapsed since the last success, the
 * picker treats the cache as stale and re-walks the curated chain to
 * pick a fresh winner. Refreshed on every successful stream.
 */
export interface CachedModel {
	id: string;
	cachedAt: number;
}

/**
 * Transient toast in the title-right slot. Used for the session-start
 * "Selected: <id>" notice. Not persisted (the field is stripped from
 * appendEntry payloads); a fresh session starts with notice undefined.
 */
export interface StatusNotice {
	text: string;
	expiresAt: number;
}

export interface StatusState {
	goal: string;
	/** How the current goal was set. "manual" disables all auto-update logic
	 *  (the user explicitly /goal'd it, or it was migrated from a pre-auto
	 *  session). "auto" lets the derive pipeline update it on turns 1 and 2. */
	goalSource: GoalSource;
	/** Number of auto-derivation passes that have been applied. 0 = never,
	 *  1 = initial extract done, 2 = refinement done (locked). The pipeline
	 *  bumps this on each pass; once it hits 2, no further auto-updates. */
	goalAutoTurnsApplied: number;
	status: string;
	history: HistoryEntry[];
	nextId: number;
	/** Model ID actually used for the most recent successful recap.
	 *  Surfaced in the title row as a tag. Persisted so the tag is correct
	 *  immediately on session reload, before the next recap fires. */
	lastModel?: string;
	/** User-set model override via `/recap-model <id>`. When set, picker
	 *  prefers this id at layer 1 of the chain. Sacred -- never auto-blacklisted. */
	modelOverride?: string;
	/** Cached winning model id from the most recent successful recap stream
	 *  in this session. Hoisted to layer 2 of the picker chain on the next
	 *  call. Expires after 24h via cachedAt. v5: now a {id, cachedAt} object;
	 *  legacy v4.1 string-shape entries are migrated by replay.ts as expired. */
	cachedRecapModel?: CachedModel;
	/** Same idea, separate slot for goal derivation - the goal pipeline uses
	 *  a different system prompt, so a model that succeeds for one may not
	 *  succeed for the other. */
	cachedGoalModel?: CachedModel;
	/** Transient toast (NOT persisted). Set on session_start to surface the
	 *  picker's pick to the user; the widget shows it in the title-right
	 *  slot until expiresAt, then reverts to the model tag. */
	notice?: StatusNotice;
}

export const EMPTY_STATE: StatusState = {
	goal: "",
	goalSource: "auto",
	goalAutoTurnsApplied: 0,
	status: "",
	history: [],
	nextId: 1,
};

/** TTL for cached winners. Beyond this, the cache is treated as expired
 *  by the picker so the next stream re-walks the curated chain. */
export const CACHED_MODEL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * True if a cached entry is non-null and within TTL. Used by the picker
 * to decide whether to hoist the cached id to layer 2.
 */
export function isCachedModelFresh(cached: CachedModel | undefined, now: number = Date.now()): boolean {
	if (!cached) return false;
	if (typeof cached.cachedAt !== "number" || cached.cachedAt <= 0) return false;
	return (now - cached.cachedAt) < CACHED_MODEL_TTL_MS;
}
