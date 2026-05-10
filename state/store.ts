/**
 * Module-level state cell for pi-recap.
 *
 * Adds per-entry helpers used by the streaming pipeline:
 *   - addStreamingEntry(speaker)    starts a new history row in streaming mode
 *   - updateEntryText(id, text)     replaces the running text for that row
 *   - finalizeEntry(id, recap)      drops streaming flag, swaps in clean recap
 *   - removeEntry(id)               drops a row (used when the stream fails)
 *
 * Cached-winner helpers (v5):
 *   - setCachedRecapModel(id)       wraps in {id, cachedAt: now}
 *   - clearCachedRecapModel()       drops the cache (after detected failure)
 *   - setCachedGoalModel / clear    same for goal
 *
 * Notice (v5):
 *   - setNotice(text, durationMs)   transient title-right toast, NOT persisted
 *   - clearNotice()                 explicit clear (animation tick on expiry)
 *
 * Each helper mutates the module-level cell and returns void; the widget
 * renders straight from getState() so the next render sees the change.
 */

import {
	EMPTY_STATE,
	type CachedModel,
	type HistoryEntry,
	type Speaker,
	type StatusNotice,
	type StatusState,
} from "./state.js";

let state: StatusState = { ...EMPTY_STATE, history: [] };

export function getState(): StatusState {
	return state;
}

export function getGoal(): string {
	return state.goal;
}

export function getStatus(): string {
	return state.status;
}

export function getHistory(): readonly HistoryEntry[] {
	return state.history;
}

export function replaceState(next: StatusState): void {
	state = next;
}

export function commitState(next: StatusState): void {
	state = next;
}

/**
 * Append a new streaming entry and return its id. The recap text starts
 * empty; the widget shows the pulsating thinking-dot until the first delta
 * arrives, then swaps in live text + caret.
 */
export function addStreamingEntry(speaker: Speaker, timestamp: number = Date.now()): number {
	const id = state.nextId;
	const entry: HistoryEntry = {
		id,
		timestamp,
		recap: "",
		speaker,
		streaming: true,
	};
	state = {
		...state,
		history: [...state.history, entry],
		nextId: id + 1,
	};
	return id;
}

/** Replace the running text on a streaming entry. No-op if the id is gone. */
export function updateEntryText(id: number, running: string): void {
	const idx = state.history.findIndex((h) => h.id === id);
	if (idx < 0) return;
	const next = state.history.slice();
	next[idx] = { ...next[idx]!, recap: running };
	state = { ...state, history: next };
}

/**
 * Finalize a streaming entry: clear the flag, swap in the cleaned recap,
 * bump status / lastModel for the surface. No-op if the id is gone.
 */
export function finalizeEntry(id: number, recap: string, modelId?: string): void {
	const idx = state.history.findIndex((h) => h.id === id);
	if (idx < 0) return;
	const next = state.history.slice();
	next[idx] = { ...next[idx]!, recap, streaming: false };
	state = {
		...state,
		history: next,
		status: recap,
		lastModel: modelId ?? state.lastModel,
	};
}

/** Drop a streaming entry that never produced any text (e.g. the LLM call
 *  errored out). Keeps the history clean instead of leaving a zombie row. */
export function removeEntry(id: number): void {
	const next = state.history.filter((h) => h.id !== id);
	if (next.length === state.history.length) return;
	state = { ...state, history: next };
}

/** Seed lastModel only when it's currently empty. Used at session_start to
 *  avoid a blank title-right slot in the window between toast expiry (2.5s)
 *  and the first finalizeEntry. The real winner from finalizeEntry overwrites
 *  this on the first successful recap. No-op when lastModel is already set. */
export function seedLastModel(id: string): void {
	if (state.lastModel) return;
	state = { ...state, lastModel: id };
}

/** Pin a model id as the next-attempt winner for recap streams. Stamps cachedAt
 *  to now() so the 24h TTL window starts from this success. */
export function setCachedRecapModel(id: string): void {
	const next: CachedModel = { id, cachedAt: Date.now() };
	state = { ...state, cachedRecapModel: next };
}

/** Drop the recap cached winner. Used when the cached id failed this turn,
 *  forcing the next stream to re-walk the chain. */
export function clearCachedRecapModel(): void {
	if (!state.cachedRecapModel) return;
	state = { ...state, cachedRecapModel: undefined };
}

/** Pin a model id as the next-attempt winner for goal streams. Idempotent. */
export function setCachedGoalModel(id: string): void {
	const next: CachedModel = { id, cachedAt: Date.now() };
	state = { ...state, cachedGoalModel: next };
}

export function clearCachedGoalModel(): void {
	if (!state.cachedGoalModel) return;
	state = { ...state, cachedGoalModel: undefined };
}

/**
 * Set a transient title-right toast for `durationMs` from now. The widget
 * polls expiry on each animation tick; once expired, the renderer shows
 * the model tag again. Notice is intentionally NOT persisted to disk -- it's
 * a soft suggestion that should not survive the session.
 */
export function setNotice(text: string, durationMs: number): void {
	const next: StatusNotice = { text, expiresAt: Date.now() + durationMs };
	state = { ...state, notice: next };
}

export function clearNotice(): void {
	if (!state.notice) return;
	state = { ...state, notice: undefined };
}

export function __resetState(): void {
	state = { ...EMPTY_STATE, history: [] };
}
