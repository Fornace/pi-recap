/**
 * Pure model-picker logic for recap streams (v5, 5-layer chain).
 *
 * Lives in its own file (no pi-ai runtime imports, only types) so the probe
 * harness can exercise the ranking deterministically without hauling in the
 * provider stack at module-load time.
 *
 * The chain (top-to-bottom, every layer skips blacklisted ids):
 *   1. user-locked override (modelOverride / preferredId)        -- never blacklisted
 *   2. cached winner with 24h TTL (cachedWinner.id)              -- skipped if expired or blacklisted
 *   3. CURATED_CHAIN -- a hand-picked list of known-good fast/    -- skipped if blacklisted
 *      cheap models, vetted by the v6 bench. The list is
 *      trivially editable -- it's the named const at the top of
 *      this file. Order matters; lowest-cost / fastest first.
 *   4. regex+sort discovery -- detect family by substring, apply
 *      MIN_VERSION gate, sort by version desc / date desc /
 *      cost asc, take 1 per family in FAMILY_ORDER. Skips ids
 *      already in layers 1-3 and blacklisted ids.
 *   5. ctx.model (the user's session model) -- never blacklisted, last
 *      resort, even if it's a reasoning flagship. thinkingOffOpts disables
 *      reasoning for the recap call.
 *
 * Public surface:
 *   - thinkingOffOpts(model): per-provider knob to disable extended thinking
 *   - findFastModelChain(...): the 5-layer ordered chain
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

// ── REGEX+SORT DISCOVERY LAYER ────────────────────────────────────────

/** Order in which families are walked when building layer 4. Top first. */
const FAMILY_ORDER: ReadonlyArray<string> = [
	"gemini-flash",
	"claude-haiku",
	"gpt-mini-or-nano",
	"qwen-flash",
	"kimi",
	"glm",
	"nemotron-nano",
	"ministral",
	"nova-lite",
	"mimo-flash",
	"generic-cheap",
];

/** Minimum version required to enter a family bucket. Anything below the gate
 *  is skipped (e.g. gemini-1.5-flash never comes back). Tunable. */
const MIN_VERSION: Record<string, number> = {
	"gemini-flash": 2.5,
	"claude-haiku": 4.0,
	"gpt-mini-or-nano": 5,
	"qwen-flash": 3.5,
	"kimi": 2.5,
	"glm": 4.5,
	"nemotron-nano": 3,
	"ministral": 0,
	"nova-lite": 1,
	"mimo-flash": 2,
	"generic-cheap": 0,
};

/** Total token cost ceiling for the "generic-cheap" bucket. Below $1/M
 *  combined input+output is what we consider low-stakes for a 100-char recap. */
const GENERIC_CHEAP_COST_CEILING = 1.0;

/** Detect family by id substring. Order of checks matters -- "gemini" must
 *  be checked before "mini" so the famous ge-MINI bug stays fixed. */
function familyOf(model: Model<Api>): string | null {
	const id = model.id.toLowerCase();
	if (id.includes("gemini") && id.includes("flash")) return "gemini-flash";
	if (id.includes("claude") && id.includes("haiku")) return "claude-haiku";
	if (id.includes("gpt") && (id.includes("mini") || id.includes("nano"))) return "gpt-mini-or-nano";
	if (id.includes("qwen") && (id.includes("flash") || id.includes("turbo"))) return "qwen-flash";
	if (id.includes("kimi")) return "kimi";
	if (id.includes("glm")) return "glm";
	if (id.includes("nemotron") && id.includes("nano")) return "nemotron-nano";
	if (id.includes("ministral")) return "ministral";
	if (id.includes("nova-lite") || id.includes("nova-micro")) return "nova-lite";
	if (id.includes("mimo")) return "mimo-flash";
	// Generic-cheap fallback: anything well under $1/M combined.
	const cost = (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
	if (cost > 0 && cost < GENERIC_CHEAP_COST_CEILING) return "generic-cheap";
	return null;
}

/**
 * Extract version + date ranks from a model id. Date-suffix detection MUST
 * run before generic version regex so e.g. `ministral-3b-2512` parses as
 * v3 + date 2512, not v2512. Returns the largest version found in the tail
 * (after stripping any leading `org/` prefix).
 */
function recencyOf(id: string): { vrank: number; drank: number } {
	const lower = id.toLowerCase();
	const tail = lower.split("/").pop() ?? lower;

	// Date-first: capture and remove any obvious date stamps from the
	// version-search input so they can't pollute the version match.
	let drank = 0;
	const dateMatches = [
		tail.match(/(\d{4}-\d{2}-\d{2})/), // 2024-07-18
		tail.match(/[-_](\d{8})\b/),       // -20240718
		tail.match(/[-_](\d{4})\b/),       // -2512 (mistral encoding)
	];
	let vsearch = tail;
	for (const m of dateMatches) {
		if (!m || !m[1]) continue;
		const d = m[1].replace(/-/g, "");
		if (d.length === 4) drank = Math.max(drank, 200000 + Number(d));
		else if (d.length === 8) drank = Math.max(drank, Number(d));
		// Strip the matched date so vrank doesn't grab e.g. 2512 as a version.
		vsearch = vsearch.replace(m[0], " ");
	}

	let vrank = 0;
	const verMatches = [...vsearch.matchAll(/(?:^|[^0-9])(\d+(?:\.\d+)?)(?:[^0-9]|$)/g)];
	for (const m of verMatches) {
		const n = Number(m[1]);
		if (!Number.isFinite(n)) continue;
		if (n > vrank) vrank = n;
	}

	return { vrank, drank };
}

interface DiscoveryRanked {
	model: Model<Api>;
	family: string;
	vrank: number;
	drank: number;
	cost: number;
}

function totalCost(model: Model<Api>): number {
	return (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
}

/** Hard exclusions that the discovery layer must skip even if family-matched. */
const ID_BLOCKLIST_FRAGMENTS: ReadonlyArray<string> = [
	"embed",                         // embeddings, different API contract
	"-pro", "plus", "max",          // flagship tiers (we want fast/cheap)
	"audio", "tts", "whisper", "transcribe",
	"dall-e", "dalle", "imagen", "stable-diffusion", "midjourney",
	"moderation", "guard",
];

const MIN_CONTEXT_WINDOW = 1024;

function isHardExcluded(model: Model<Api>): boolean {
	const lower = model.id.toLowerCase();
	for (const frag of ID_BLOCKLIST_FRAGMENTS) {
		if (lower.includes(frag)) return true;
	}
	if ((model.contextWindow ?? 0) < MIN_CONTEXT_WINDOW) return true;
	return false;
}

/**
 * Build the discovery layer (layer 4): one candidate per family in
 * FAMILY_ORDER, gated by MIN_VERSION, ranked by version desc / date desc /
 * cost asc inside each family. Ids already in `seen` (layers 1-3) and
 * blacklisted ids are dropped.
 */
function buildDiscoveryLayer(available: Model<Api>[], seen: Set<string>): Model<Api>[] {
	const buckets = new Map<string, DiscoveryRanked[]>();
	for (const model of available) {
		if (seen.has(model.id)) continue;
		if (isBlacklisted(model.id)) continue;
		if (isHardExcluded(model)) continue;
		const fam = familyOf(model);
		if (!fam) continue;
		const r = recencyOf(model.id);
		const min = MIN_VERSION[fam] ?? 0;
		if (r.vrank < min) continue;
		if (!buckets.has(fam)) buckets.set(fam, []);
		buckets.get(fam)!.push({
			model,
			family: fam,
			vrank: r.vrank,
			drank: r.drank,
			cost: totalCost(model),
		});
	}

	const out: Model<Api>[] = [];
	for (const fam of FAMILY_ORDER) {
		const arr = buckets.get(fam);
		if (!arr || arr.length === 0) continue;
		arr.sort((a, b) => {
			if (a.vrank !== b.vrank) return b.vrank - a.vrank;
			if (a.drank !== b.drank) return b.drank - a.drank;
			if (Math.abs(a.cost - b.cost) > 0.0001) return a.cost - b.cost;
			return a.model.id.localeCompare(b.model.id);
		});
		const top = arr[0]!.model;
		out.push(top);
	}
	return out;
}

/**
 * Build the v5 ordered fallback chain.
 *
 * Layer order:
 *   1. preferredId (override) -- ALWAYS placed first if it resolves; sacred,
 *      never blacklist-skipped here (the user explicitly asked for it).
 *   2. cached winner if non-null AND fresh (within TTL) AND not blacklisted.
 *   3. CURATED_CHAIN ids that are available + not blacklisted.
 *   4. discovery layer (1 per family), skipping ids already in layers 1-3.
 *   5. sessionModel (ctx.model) at the very end. Never blacklisted; sacred.
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
	}

	// Layer 4: regex+sort discovery (1 per family). Skip blacklisted; skip
	// ids already pushed by layers 1-3.
	const discovery = buildDiscoveryLayer(available, seen);
	for (const m of discovery) push(m);

	// Layer 5: sessionModel. Never blacklisted; sacred.
	if (sessionModel) push(sessionModel);

	return chain;
}
