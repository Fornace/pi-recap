import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { logError } from "../util/log.js";

/** Where the panel is mounted.
 *
 *   - "aboveEditor" (default): the host's above-editor widget slot, i.e. the
 *     panel sits just above the input box, in the chat column.
 *   - "top": the first row of a fullscreen window. The transcript scrolls
 *     underneath it and the panel never moves. Regular (non-fullscreen) TUIs
 *     have no window root to pin to, so they keep the above-editor slot.
 */
export type PanelPosition = "aboveEditor" | "top";

/** Position used when config.json has no `position` field, or an unknown one.
 *  Also the value every existing user gets after upgrading -- nothing changes
 *  for them until they opt in. */
export const DEFAULT_PANEL_POSITION: PanelPosition = "aboveEditor";

export interface GlobalConfig {
	modelOverride?: string;
	position?: PanelPosition;
}

function resolveConfigPath(): string {
	const envHome = process.env.PI_RECAP_HOME;
	if (envHome && envHome.length > 0) {
		return resolve(envHome, "state", "config.json");
	}
	const cwd = process.cwd();
	const cwdCandidate = resolve(cwd, "state", "config.json");
	if (existsSync(resolve(cwd, "package.json")) && cwd.endsWith("pi-recap")) {
		return cwdCandidate;
	}
	return resolve(homedir(), ".pi", "agent", "extensions", "pi-recap", "state", "config.json");
}

const CONFIG_PATH = resolveConfigPath();

let cache: GlobalConfig | undefined;

function ensureDir(): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	} catch {
		// best effort
	}
}

/** Read config.json from disk, bypassing the cache. */
function readConfigFile(): GlobalConfig {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as GlobalConfig;
	} catch (err) {
		logError("config.json read failed; ignoring", err);
		return {};
	}
}

export function loadConfig(): GlobalConfig {
	if (cache) return cache;
	cache = readConfigFile();
	return cache;
}

/** Write one setting, merging into what is already on disk.
 *
 *  The merge starts from a fresh disk read rather than from the in-memory
 *  cache: two settings live in this file (`modelOverride` and `position`), and
 *  writing one of them must never drop the other -- not even when another
 *  process changed the file since we cached it. */
function writeConfigPatch(patch: Partial<GlobalConfig>): void {
	const next: GlobalConfig = { ...readConfigFile(), ...patch };
	// JSON.stringify drops keys whose value is undefined, which is how a
	// setting is removed (e.g. clearing the model override).
	cache = next;
	ensureDir();
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(next, null, "\t") + "\n", "utf8");
	} catch (err) {
		logError("config.json write failed", err);
	}
}

export function setGlobalModelOverride(id: string | undefined): void {
	if (loadConfig().modelOverride === id) return;
	writeConfigPatch({ modelOverride: id });
}

export function getGlobalModelOverride(): string | undefined {
	return loadConfig().modelOverride;
}

/** Current panel position. Unknown/missing values fall back to the default, so
 *  a hand-edited or outdated config.json can never break startup. */
export function getGlobalPosition(): PanelPosition {
	return loadConfig().position === "top" ? "top" : DEFAULT_PANEL_POSITION;
}

/** Persist the panel position. Leaves `modelOverride` untouched. */
export function setGlobalPosition(pos: PanelPosition): void {
	// Compare against the raw value, not the sanitized getter: a hand-edited
	// unknown value should be repaired when the user picks the default.
	if (loadConfig().position === pos) return;
	writeConfigPatch({ position: pos });
}

/** Flip between the two positions, persist the result, and return the new one. */
export function toggleGlobalPosition(): PanelPosition {
	const next: PanelPosition = getGlobalPosition() === "top" ? "aboveEditor" : "top";
	writeConfigPatch({ position: next });
	return next;
}
