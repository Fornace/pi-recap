/**
 * Animation primitives for the recap panel.
 *
 * Tiny on purpose. Builds truecolor gradients (rgbLerp + parseHex) for the
 * shimmer / settle effects, plus the easeOut helper for soft landings.
 *
 * Theme tokens (theme.fg / theme.getFgAnsi) cover the static palette. The
 * gradients here are only used for *internal* animations where we want
 * sub-token brightness steps a theme can't provide. They live on the same
 * hue family as the theme accent so they don't clash with any user theme.
 */

export type RGB = readonly [number, number, number];

export function parseHex(hex: string): RGB {
	const h = hex.replace(/^#/, "");
	const n = parseInt(h.length === 3
		? h.split("").map((c) => c + c).join("")
		: h, 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Linear RGB lerp. Cheap and good enough at our brightness range. */
export function rgbLerp(a: RGB, b: RGB, t: number): RGB {
	const k = Math.max(0, Math.min(1, t));
	return [
		Math.round(a[0] + (b[0] - a[0]) * k),
		Math.round(a[1] + (b[1] - a[1]) * k),
		Math.round(a[2] + (b[2] - a[2]) * k),
	];
}

/** ANSI 24-bit foreground. Pair every call with `RESET`. */
export function fgAnsi(rgb: RGB): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

export const RESET = "\x1b[0m";

// ── Universal text colors (theme-agnostic) ──────────────────────────────
//
// Hardcoded truecolor values for content text that must be readable
// regardless of the user's theme. Used for recap headlines and body text.
// Decorative elements (borders, speaker tags, timestamps) still use
// theme tokens.

/** Detect light vs dark terminal background via COLORFGBG env var. */
export function isLightBg(): boolean {
	const fgbg = process.env.COLORFGBG;
	if (fgbg) {
		const parts = fgbg.split(";");
		const bg = parseInt(parts[parts.length - 1] ?? "0", 10);
		if (!Number.isNaN(bg)) return bg >= 8;
	}
	return false; // default: dark
}

/** Title text: purple-ish, matching custom tool labels (#9575cd). */
export function titleColor(): RGB {
	return isLightBg() ? [10, 10, 10] : [149, 117, 205];
}

/** Newest recap text: barely off-white on dark, barely off-black on light. */
export function newestColor(): RGB {
	return isLightBg() ? [26, 26, 26] : [232, 232, 232];
}

/** General content text color. */
export function textColor(): RGB {
	return isLightBg() ? [15, 15, 15] : [240, 240, 240];
}

/** Wrap text with a universal fg color and reset. */
export function colorText(color: RGB, text: string): string {
	return `${fgAnsi(color)}${text}${RESET}`;
}

/** easeOutCubic - fast start, soft landing. Good for settle animations. */
export function easeOut(t: number): number {
	const k = Math.max(0, Math.min(1, t));
	return 1 - Math.pow(1 - k, 3);
}
