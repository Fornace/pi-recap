/**
 * Persistent model blacklist for pi-recap.
 *
 * Lives at <ext>/state/blacklist.json. Tracks model ids the picker must skip
 * at every layer (cached winner included; the only sacred slots are the
 * user override and ctx.model). Entries are tagged with a reason and an
 * `addedBy` source ("auto" from picker failure detection, "user" from the
 * /recap-blacklist add command).
 *
 * Bootstrap: on first ever load (no file exists), `seedBlacklist()` writes
 * the BLACKLIST_SEED from pi-bench. After that the file is the source of truth.
 * `resetBlacklist()` writes an empty `entries: []` and does NOT re-bootstrap
 * from SEED -- the user explicitly asked for empty.
 *
 * All filesystem writes are best-effort. A permission or disk error must
 * never crash the extension host -- we log and keep the in-memory copy.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { logDebug, logError } from "../util/log.js";
import { BLACKLIST_SEED } from "pi-bench";

export interface BlacklistEntry {
	id: string;
	reason: string;
	addedAt: string;
	addedBy: "auto" | "user";
}

export interface Blacklist {
	version: 1;
	entries: BlacklistEntry[];
}

/**
 * Locate the blacklist file. Mirrors util/log.ts's resolution strategy so
 * a custom PI_RECAP_HOME points both files at the same _tmp / state dir
 * during e2e tests.
 *
 * Candidates (first wins):
 *   1. <PI_RECAP_HOME>/state/blacklist.json if env var is set
 *   2. <cwd>/state/blacklist.json when cwd looks like the pi-recap project
 *   3. <HOME>/.pi/agent/extensions/pi-recap/state/blacklist.json (canonical)
 */
function resolveBlacklistPath(): string {
	const envHome = process.env.PI_RECAP_HOME;
	if (envHome && envHome.length > 0) {
		return resolve(envHome, "state", "blacklist.json");
	}
	const cwd = process.cwd();
	const cwdCandidate = resolve(cwd, "state", "blacklist.json");
	if (existsSync(resolve(cwd, "package.json")) && cwd.endsWith("pi-recap")) {
		return cwdCandidate;
	}
	return resolve(homedir(), ".pi", "agent", "extensions", "pi-recap", "state", "blacklist.json");
}

const BLACKLIST_PATH = resolveBlacklistPath();
export const BLACKLIST_FILE_PATH = BLACKLIST_PATH;

let cache: Blacklist | undefined;

function ensureDir(): void {
	try {
		mkdirSync(dirname(BLACKLIST_PATH), { recursive: true });
	} catch {
		// best effort
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

function isEntry(value: unknown): value is BlacklistEntry {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		typeof v.reason === "string" &&
		typeof v.addedAt === "string" &&
		(v.addedBy === "auto" || v.addedBy === "user")
	);
}

function isBlacklistShape(value: unknown): value is Blacklist {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return v.version === 1 && Array.isArray(v.entries) && v.entries.every(isEntry);
}

function readFromDisk(): Blacklist | undefined {
	if (!existsSync(BLACKLIST_PATH)) return undefined;
	try {
		const raw = readFileSync(BLACKLIST_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (isBlacklistShape(parsed)) return parsed;
		logError(`blacklist.json malformed; ignoring on-disk file`);
		return { version: 1, entries: [] };
	} catch (err) {
		logError("blacklist.json read failed; ignoring", err);
		return { version: 1, entries: [] };
	}
}

function writeToDisk(b: Blacklist): void {
	ensureDir();
	try {
		writeFileSync(BLACKLIST_PATH, JSON.stringify(b, null, "\t") + "\n", "utf8");
	} catch (err) {
		logError("blacklist.json write failed", err);
	}
}

/**
 * Load the blacklist into the module-level cache. On a brand-new install
 * (no file), seeds with BLACKLIST_SEED and writes immediately so the user can inspect
 * /Users/.../state/blacklist.json after the first session_start.
 */
export function loadBlacklist(): Blacklist {
	if (cache) return cache;
	const fromDisk = readFromDisk();
	if (fromDisk) {
		cache = fromDisk;
	} else {
		cache = { version: 1, entries: [] };
		seedBlacklist(); // writes & updates cache
	}
	return cache;
}

export function saveBlacklist(b: Blacklist): void {
	cache = b;
	writeToDisk(b);
}

export function isBlacklisted(id: string): boolean {
	const b = loadBlacklist();
	for (const entry of b.entries) {
		if (entry.id === id) return true;
	}
	return false;
}

/**
 * Append an entry. No-op if the id is already present (we keep the older
 * entry's reason/timestamp -- first-failure wins for diagnostic provenance).
 */
export function addToBlacklist(id: string, reason: string, by: "auto" | "user"): void {
	const b = loadBlacklist();
	if (b.entries.some((e) => e.id === id)) {
		logDebug(`blacklist: ${id} already present, skipping (${by} requested ${reason})`);
		return;
	}
	const entry: BlacklistEntry = {
		id,
		reason,
		addedAt: nowIso(),
		addedBy: by,
	};
	const next: Blacklist = { version: 1, entries: [...b.entries, entry] };
	saveBlacklist(next);
	logDebug(`blacklist: added ${id} (${by}: ${reason})`);
}

export function removeFromBlacklist(id: string): boolean {
	const b = loadBlacklist();
	const filtered = b.entries.filter((e) => e.id !== id);
	if (filtered.length === b.entries.length) return false;
	saveBlacklist({ version: 1, entries: filtered });
	logDebug(`blacklist: removed ${id}`);
	return true;
}

/**
 * Hard-reset: write an empty list. Does NOT re-apply BLACKLIST_SEED; the user
 * asked for empty, so empty is what we give them. They can run
 * /recap-blacklist seed to bring it back.
 */
export function resetBlacklist(): void {
	saveBlacklist({ version: 1, entries: [] });
	logDebug("blacklist: reset (empty)");
}

/**
 * Apply BLACKLIST_SEED from pi-bench idempotently. Existing entries are kept.
 * Used for the first-session bootstrap path and the /recap-blacklist seed command.
 */
export function seedBlacklist(): void {
	const current = cache ?? readFromDisk() ?? { version: 1, entries: [] };
	const knownIds = new Set(current.entries.map((e) => e.id));
	const additions: BlacklistEntry[] = [];
	for (const spec of BLACKLIST_SEED) {
		if (knownIds.has(spec.id)) continue;
		additions.push({
			id: spec.id,
			reason: spec.reason,
			addedAt: nowIso(),
			addedBy: "auto",
		});
	}
	if (additions.length === 0) {
		cache = current;
		logDebug("blacklist: seed already present, no changes");
		return;
	}
	const next: Blacklist = { version: 1, entries: [...current.entries, ...additions] };
	saveBlacklist(next);
	logDebug(`blacklist: seeded ${additions.length} entries`);
}

/** Test/helper: drop the in-memory cache so the next load re-reads disk. */
export function __resetBlacklistCache(): void {
	cache = undefined;
}
