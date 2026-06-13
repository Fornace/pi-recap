/**
 * Pi-recap debug logger.
 *
 * Two surfaces:
 *   - File log at <ext>/_tmp/recap.log: always-on, best-effort. Captures the
 *     fallback chain walk, empty-response notes, and any other diagnostics
 *     for after-the-fact debugging without polluting user-visible stderr.
 *   - Stderr: only when env PI_RECAP_DEBUG=1, or for unrecoverable errors
 *     (full chain failure, dispose crash) emitted via logError. Successful
 *     fallback walks stay file-only so the user's terminal stays quiet.
 *
 * All log lines are tagged "[recap] ...". Best-effort filesystem writes:
 * an EROFS or permission error must NEVER crash the extension host.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Locate the project _tmp directory.
 *
 * Candidates (first existing-or-creatable wins):
 *   1. <PI_RECAP_HOME>/_tmp/recap.log if env var is set (escape hatch)
 *   2. <cwd>/_tmp/recap.log when cwd looks like the pi-recap project
 *   3. <XDG_STATE_HOME or ~/.local/state>/pi-recap/_tmp/recap.log
 *   4. <HOME>/.pi/agent/extensions/pi-recap/_tmp/recap.log (legacy)
 */
function resolveLogPath(): string {
	const envHome = process.env.PI_RECAP_HOME;
	if (envHome && envHome.length > 0) {
		return resolve(envHome, "_tmp", "recap.log");
	}
	const cwd = process.cwd();
	const cwdCandidate = resolve(cwd, "_tmp", "recap.log");
	if (existsSync(resolve(cwd, "package.json")) && cwd.endsWith("pi-recap")) {
		return cwdCandidate;
	}
	const xdg = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
		? process.env.XDG_STATE_HOME
		: resolve(process.env.HOME || "", ".local", "state");
	const xdgCandidate = resolve(xdg, "pi-recap", "_tmp", "recap.log");
	if (existsSync(xdgCandidate)) {
		return xdgCandidate;
	}
	const legacy = resolve(process.env.HOME || "", ".pi", "agent", "extensions", "pi-recap", "_tmp", "recap.log");
	if (existsSync(legacy)) {
		return legacy;
	}
	return xdgCandidate;
}

const LOG_PATH = resolveLogPath();

let dirEnsured = false;
function ensureDir(): void {
	if (dirEnsured) return;
	try {
		mkdirSync(dirname(LOG_PATH), { recursive: true });
		dirEnsured = true;
	} catch {
		// best-effort. If we can't make the dir, the writes below also fail
		// silently and the extension keeps running.
	}
}

function ts(): string {
	const d = new Date();
	const pad = (n: number, w: number = 2): string => String(n).padStart(w, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function writeFileLine(line: string): void {
	ensureDir();
	try {
		appendFileSync(LOG_PATH, line + "\n", "utf8");
	} catch {
		// swallow. Filesystem failures are not the user's problem.
	}
}

function debugMode(): boolean {
	return process.env.PI_RECAP_DEBUG === "1";
}

/**
 * Routine diagnostic. Always written to the log file; only echoed to stderr
 * when PI_RECAP_DEBUG=1. Successful fallback walks live here.
 */
export function logDebug(message: string): void {
	const line = `[${ts()}] [recap] ${message}`;
	writeFileLine(line);
	if (debugMode()) {
		// eslint-disable-next-line no-console
		console.error(line);
	}
}

/**
 * Unrecoverable error path. Always written to the log file AND stderr - the
 * user should see "every model failed" or "dispose crashed" in their session
 * even without the debug flag.
 */
export function logError(message: string, err?: unknown): void {
	const detail = err === undefined ? "" : ` ${formatErr(err)}`;
	const line = `[${ts()}] [recap] ${message}${detail}`;
	writeFileLine(line);
	// eslint-disable-next-line no-console
	console.error(line);
}

function formatErr(err: unknown): string {
	if (err instanceof Error) return err.stack ?? err.message;
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

/**
 * Optional one-shot trace helper used while debugging the streaming-event bug.
 * Gated on env PI_RECAP_TRACE=1 so it stays free at runtime when not set.
 */
export function logTrace(message: string): void {
	if (process.env.PI_RECAP_TRACE !== "1") return;
	const line = `[${ts()}] [recap-trace] ${message}`;
	writeFileLine(line);
	// eslint-disable-next-line no-console
	console.error(line);
}

export const LOG_FILE_PATH = LOG_PATH;
