import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logError } from "../util/log.js";

export interface GlobalConfig {
	modelOverride?: string;
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
	const xdg = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
		? process.env.XDG_STATE_HOME
		: resolve(process.env.HOME || "", ".local", "state");
	const xdgCandidate = resolve(xdg, "pi-recap", "state", "config.json");
	if (existsSync(xdgCandidate)) {
		return xdgCandidate;
	}
	const legacy = resolve(process.env.HOME || "", ".pi", "agent", "extensions", "pi-recap", "state", "config.json");
	if (existsSync(legacy)) {
		return legacy;
	}
	return xdgCandidate;
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

export function loadConfig(): GlobalConfig {
	if (cache) return cache;
	if (!existsSync(CONFIG_PATH)) {
		cache = {};
		return cache;
	}
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		cache = JSON.parse(raw) as GlobalConfig;
	} catch (err) {
		logError("config.json read failed; ignoring", err);
		cache = {};
	}
	return cache;
}

export function setGlobalModelOverride(id: string | undefined): void {
	const config = loadConfig();
	if (config.modelOverride === id) return;
	config.modelOverride = id;
	ensureDir();
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
	} catch (err) {
		logError("config.json write failed", err);
	}
}

export function getGlobalModelOverride(): string | undefined {
	return loadConfig().modelOverride;
}
