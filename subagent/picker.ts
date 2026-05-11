/**
 * Pure model-picker logic for recap streams (v6, 4-layer chain).
 *
 * Lives in its own file (no pi-ai runtime imports, only types) so the probe
 * harness can exercise the ranking deterministically without hauling in the
 * provider stack at module-load time.
 *
 * The chain (top-to-bottom, every layer skips blacklisted ids):
 *   1. user-locked override (modelOverride / preferredId)        -- never blacklisted
 *   2. cached winner with 24h TTL (cachedWinner.id)              -- skipped if expired or blacklisted
 *   3. CURATED_CHAIN (imported from pi-bench)                    -- skipped if blacklisted
 *   4. ctx.model (the user's session model) -- never blacklisted, last
 *      resort, even if it's a reasoning flagship. thinkingOffOpts disables
 *      reasoning for the recap call.
 *
 * v6 removes the regex+sort discovery layer (old layer 4). pi-bench is the
 * source of truth — if a model isn't benched, the session model is a safer
 * fallback than guessing from naming patterns and version numbers.
 *
 * Public surface:
 *   - thinkingOffOpts(model): per-provider knob to disable extended thinking
 *   - findFastModelChain(...): the 4-layer ordered chain
 *   - CURATED_CHAIN: editable -- one named const, no scattered literals.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { type CachedModel, isCachedModelFresh } from "../state/state.js";
import { isBlacklisted } from "../state/blacklist.js";
import { CURATED_CHAIN } from "pi-bench";

export function thinkingOffOpts(model: Model<Api>): Record<string, unknown> {
	switch (model.api) {
		case "anthropic-messages":
			return { thinkingEnabled: false };
		case "google-generative-ai":
		case "google-vertex":
			return { thinking: { enabled: false } };
		default:
			return {};
	}
}

// ── CURATED CHAIN ──────────────────────────────────────────────────────
//
// Imported from pi-bench (the source of truth for bench data).
// Run a new bench → pi-bench updates CURATED_CHAIN → pi-recap picks it up.

export { CURATED_CHAIN };

/**
 * Build the v6 ordered fallback chain.
 *
 * Layer order:
 *   1. preferredId (override) -- ALWAYS placed first if it resolves; sacred,
 *      never blacklist-skipped here (the user explicitly asked for it).
 *   2. cached winner if non-null AND fresh (within TTL) AND not blacklisted.
 *   3. CURATED_CHAIN ids that are available + not blacklisted.
 *   4. sessionModel (ctx.model) at the very end. Never blacklisted; sacred.
 *
 * Filters duplicates by model.id so the same handle isn't tried twice.
 */
export function findFastModelChain(
	registry: { getAvailable(): Model<Api>[] },
	preferredId: string | undefined,
	sessionModel: Model<Api> | undefined,
	cachedWinner?: CachedModel | undefined,
	now: number = Date.now(),
): Model<Api>[] {
	const available = registry.getAvailable();
	const byId = new Map<string, Model<Api>>();
	for (const m of available) byId.set(m.id, m);

	const seen = new Set<string>();
	const chain: Model<Api>[] = [];

	const push = (m: Model<Api> | undefined): void => {
		if (!m) return;
		if (seen.has(m.id)) return;
		seen.add(m.id);
		chain.push(m);
	};

	// Layer 1: user override. Never blacklist-checked here -- sacred.
	if (preferredId) {
		const target = byId.get(preferredId);
		if (target) push(target);
		else {
			// Fallback: resolve bench CSV bare handle (e.g. "claude-haiku-4.5")
			// to pi-ai registry ID (e.g. "anthropic.claude-haiku-4-5-20251001-v1:0").
			// Handles dot→dash normalization and provider-prefix suffix matching.
			const normalized = preferredId.replace(/\./g, "-");
			const resolved = available.find(
				(m) =>
					m.id === normalized ||
					m.id.endsWith("." + normalized) ||
					m.id.endsWith("." + preferredId) ||
					m.id.endsWith("-" + preferredId),
			);
			if (resolved) push(resolved);
		}
	}

	// Layer 2: cached winner with 24h TTL. Skip if expired or blacklisted.
	if (isCachedModelFresh(cachedWinner, now) && cachedWinner) {
		if (!isBlacklisted(cachedWinner.id)) {
			const cached = byId.get(cachedWinner.id);
			if (cached) push(cached);
		}
	}

	// Layer 3: curated chain. Skip blacklisted.
	for (const id of CURATED_CHAIN) {
		if (isBlacklisted(id)) continue;
		const m = byId.get(id);
		if (m) push(m);
		else {
			// Fallback: resolve bare handle to registry ID.
			const normalized = id.replace(/\./g, "-");
			const resolved = available.find(
				(a) =>
					a.id === normalized ||
					a.id.endsWith("." + normalized) ||
					a.id.endsWith("." + id) ||
					a.id.endsWith("-" + id),
			);
			if (resolved && !isBlacklisted(resolved.id)) push(resolved);
		}
	}

	// Layer 4: sessionModel. Never blacklisted; sacred.
	if (sessionModel) push(sessionModel);

	return chain;
}
