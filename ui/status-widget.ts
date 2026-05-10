/**
 * Recap surface, mounted aboveEditor.
 *
 * Visual language (v4):
 *   - The whole panel is wrapped in a single rounded card. Glyphs ╭ ╮ ╰ ╯ ─ │
 *     in the theme border color. No inner rules between rows: the border plus
 *     the recap-fg ramp (text -> muted -> dim) carry the trail.
 *   - Title cuts into the top border on the left. Model tag cuts in on the
 *     right with a `*` suffix when locked via /recap-model. A pristine session
 *     (no goal yet) renders the placeholder dim+italic in the same slot.
 *   - Bottom border carries a contextual focus hint: "ctrl+shift+r focus"
 *     when not focused, "↑↓ navigate · esc release [+N older]" when focused.
 *     Always visible. Solves the v3 complaint that the hint was invisible.
 *   - Interior rows: 1 space inside each border. Then a fixed-width time
 *     column (right-aligned, dim), 2 spaces, a 3-cell speaker tag colored
 *     per role (you = borderAccent blue, pi = accent purple), 2 spaces,
 *     recap text. No leading gutter glyph - the border owns that signal.
 *   - Streaming rows: the pulsating dot lives in the time column (replaces
 *     the timestamp). Once text starts arriving, the dot is gone and the
 *     timestamp comes back. Reserved column width keeps the speaker and
 *     recap columns from jumping when the dot finalizes.
 *   - Settle: when a streaming row drops its flag, a 180 ms color sweep
 *     plays on the recap text. No row-level shift.
 *
 * Two streams in parallel: each binds to its own HistoryEntry id and writes
 * directly to that entry's text. Both rows render their own animation, with
 * the dot's breathing phase offset by each entry's startedAt so two
 * concurrent streams pulse independently.
 *
 * Motion: 80 ms tick, only while at least one row is animating. Idle = zero
 * CPU, zero bytes.
 *
 * Dispose is idempotent. The host calls setWidget(null) which itself calls
 * back into dispose; the disposed flag breaks the recursion.
 */

import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, matchesKey, Key } from "@earendil-works/pi-tui";
import { clearNotice, getState } from "../state/store.js";
import type { HistoryEntry, Speaker } from "../state/state.js";
import { formatDate } from "../util/date.js";
import { fgAnsi, parseHex, rgbLerp, RESET, type RGB, titleColor, newestColor, textColor, colorText, isLightBg } from "./anim.js";

const WIDGET_KEY = "recap";
const VIEW_SIZE = 4;

const TICK_MS = 80;
const THINK_GRACE_MS = 200;
const SETTLE_MS = 180;
const CARET_BLINK_MS = 530;
const CARET_SOLID_AFTER_DELTA_MS = 80;

const PLACEHOLDER_GOAL = "session title · auto-derives after first turn";

// Layout
const TIME_COL_WIDTH = 5;       // " now ", " 14m ", "14:30" all fit in 5
const SPEAKER_COL_WIDTH = 3;    // "you" / "pi "
const COL_GAP = 2;              // spaces between time/speaker and speaker/recap
const BORDER_PAD = 1;           // spaces inside each vertical border

// Pulsating thinking-dot. Single calm breath through the recap-fg accent ramp.
const DOT_GLYPH = "●";
const DOT_CYCLE_MS = 900;
const DOT_DIM: RGB = parseHex("#3a3a52");
const DOT_PEAK: RGB = parseHex("#cba6f7");
// 256-color fallback steps from dim -> accent.
const DOT_FALLBACK_TOKENS: ("borderMuted" | "border" | "accent")[] = [
	"borderMuted",
	"borderMuted",
	"border",
	"accent",
	"accent",
];

// Rounded border glyphs.
const BORDER = {
	tl: "╭",
	tr: "╮",
	bl: "╰",
	br: "╯",
	h: "─",
	v: "│",
} as const;

interface EntryAnim {
	startedAt: number;
	lastDeltaAt: number;
	/** Set when the entry transitions out of streaming. Drives the settle sweep. */
	finalizedAt?: number;
}

export class StatusWidget implements Component {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private currentTheme: Theme | undefined;
	private disposed = false;

	private focused = false;
	private scrollOffset = 0;
	private selectedRow = VIEW_SIZE - 1;

	/** Per-entry animation timing. Keyed by entry id. Populated lazily on
	 *  first render of a streaming row, updated on each render based on the
	 *  current state, dropped after the settle window expires. */
	private entryAnim: Map<number, EntryAnim> = new Map();
	/** Snapshot of entry recap text last render, keyed by id. Used to detect
	 *  delta arrivals so we can pin the caret-solid window. */
	private lastSeenText: Map<number, string> = new Map();
	/** Set of entry ids that were streaming last render. Used to detect the
	 *  streaming -> finalized transition and stamp finalizedAt. */
	private wasStreaming: Set<number> = new Set();

	private animTimer: ReturnType<typeof setInterval> | undefined;

	/** Per-instance render counter. Drives the decoy-row width so every
	 *  consecutive render produces a different row-0 string regardless of
	 *  clock granularity or render cadence. See decoy comment in render(). */
	private decoyTick = 0;

	// ── Lifecycle wiring (called from index.ts) ───────────────────────

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	/** Called whenever state changes (replay, recap commit, /goal, every
	 *  delta from a stream). Idempotent: registers the widget once, then
	 *  just kicks a re-render. */
	update(): void {
		if (this.disposed) return;
		if (!this.uiCtx) return;
		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					this.currentTheme = theme;
					return this;
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
		this.ensureAnimTimer();
	}

	/** Bound to the ctrl+shift+r shortcut. Toggles focus. Snap, never animate. */
	toggleFocus(): void {
		if (!this.tui) return;
		const history = getState().history;
		if (!this.focused) {
			if (history.length === 0) return;
			this.focused = true;
			this.scrollOffset = 0;
			this.selectedRow = Math.min(VIEW_SIZE - 1, history.length - 1);
			this.tui.setFocus(this);
		} else {
			this.focused = false;
			this.tui.setFocus(null);
		}
		this.tui.requestRender();
	}

	dispose(): void {
		// Reentry guard: setExtensionWidget(undefined) in pi-host calls back
		// into dispose() before our `widgetRegistered` flag is meaningful, so
		// without this we recur until the stack overflows.
		if (this.disposed) return;
		this.disposed = true;
		this.stopAnimTimer();
		const ctx = this.uiCtx;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.currentTheme = undefined;
		this.uiCtx = undefined;
		this.focused = false;
		this.entryAnim.clear();
		this.lastSeenText.clear();
		this.wasStreaming.clear();
		if (ctx) ctx.setWidget(WIDGET_KEY, undefined);
	}

	// ── Component interface ───────────────────────────────────────────

	render(width: number): string[] {
		const theme = this.currentTheme;
		if (!theme) return [];
		// Rounded card needs at least the two corners + 1 cell of horizontal
		// payload between them. Below that we just emit nothing.
		if (width < 4) return [];

		const state = getState();
		const { goal, history } = state;
		const now = Date.now();

		// Drop expired notices before computing the title row so the toast
		// disappears on the very tick after expiresAt without leaving a stale
		// label flashing for one frame.
		if (state.notice && state.notice.expiresAt <= now) {
			clearNotice();
		}

		this.reconcileAnim(history, now);

		const lines: string[] = [];

		// Decoy row: a varying-width whitespace line above the rounded card.
		// pi-tui (tui.js doRender) diffs frames by *string equality* per row
		// index. When this line's string is identical across consecutive
		// renders, pi-tui treats every following row as "starts unchanged"
		// until it finds the first divergence, and skips the \x1b[2K clear
		// for any row above that point. That leaves an orphan top-border
		// fragment (╭───╮) stranded in scrollback whenever the chat grew and
		// the widget shifted vertically between renders.
		//
		// Width cycles 1..8 via a per-instance monotonic counter (NOT a
		// clock-derived value). The previous implementation used
		// `frameOf(now, 1, 8)` = `floor(now/1) % 8`; on pi-tui's 16 ms render
		// throttle and the widget's 80 ms tick (both multiples of 8) the
		// width never advanced, so the decoy never actually triggered. The
		// counter is jitter-free and guarantees row 0 differs every render.
		this.decoyTick = (this.decoyTick + 1) % 8;
		lines.push(" ".repeat(1 + this.decoyTick));

		const liveNotice = state.notice && state.notice.expiresAt > now ? state.notice : undefined;
		lines.push(
			this.renderTopBorder(theme, width, goal, state.lastModel, state.modelOverride, liveNotice?.text),
		);

		const innerWidth = Math.max(0, width - 2 * (1 + BORDER_PAD)); // border+pad on each side

		const total = history.length;
		const maxOffset = Math.max(0, total - VIEW_SIZE);
		if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
		const end = total - this.scrollOffset;
		const start = Math.max(0, end - VIEW_SIZE);
		const visible = history.slice(start, end);

		if (visible.length === 0) {
			// Empty interior: render one blank padded row so the card has a
			// vertical body even before the first turn.
			lines.push(this.padRow(theme, width, ""));
		} else {
			visible.forEach((entry, i) => {
				const slot = this.slotFor(start + i, total);
				const isSelected = this.focused && (i === this.selectedRow);
				const anim = this.entryAnim.get(entry.id);

				let interior: string;
				if (entry.streaming) {
					interior = this.renderStreamingInterior(theme, innerWidth, entry, anim, now);
				} else if (anim?.finalizedAt !== undefined && (now - anim.finalizedAt) < SETTLE_MS) {
					interior = this.renderSettlingInterior(theme, innerWidth, entry, anim.finalizedAt, isSelected, now);
				} else {
					interior = this.renderEntryInterior(theme, innerWidth, entry, slot, isSelected);
				}
				lines.push(this.padRow(theme, width, interior));
			});
		}

		lines.push(this.renderBottomBorder(theme, width, total));

		return lines;
	}

	handleInput(data: string): void {
		if (!this.focused) return;
		const total = getState().history.length;
		if (total === 0) {
			this.focused = false;
			this.tui?.setFocus(null);
			this.tui?.requestRender();
			return;
		}

		if (matchesKey(data, Key.ctrlShift("r")) || matchesKey(data, Key.escape)) {
			this.focused = false;
			this.tui?.setFocus(null);
			this.tui?.requestRender();
			return;
		}

		if (matchesKey(data, Key.up)) {
			const visibleCount = Math.min(VIEW_SIZE, total - this.scrollOffset);
			const top = Math.max(0, VIEW_SIZE - visibleCount);
			if (this.selectedRow > top) {
				this.selectedRow--;
			} else if (this.scrollOffset + VIEW_SIZE < total) {
				this.scrollOffset++;
			}
			this.tui?.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.selectedRow < VIEW_SIZE - 1
				&& (this.scrollOffset + (VIEW_SIZE - 1 - this.selectedRow)) < total) {
				this.selectedRow++;
			} else if (this.scrollOffset > 0) {
				this.scrollOffset--;
			}
			this.tui?.requestRender();
			return;
		}
	}

	invalidate(): void {
		// No render caches. The widget recomputes from state every render().
	}

	// ── Animation reconciliation ──────────────────────────────────────

	/** Walk the current history, sync entryAnim with what's actually live. */
	private reconcileAnim(history: HistoryEntry[], now: number): void {
		const liveIds = new Set<number>();

		for (const entry of history) {
			if (entry.streaming) {
				liveIds.add(entry.id);
				let anim = this.entryAnim.get(entry.id);
				if (!anim) {
					// Use the entry's own timestamp (when the streaming row
					// was minted) so the 200 ms grace window starts at the
					// real start of streaming, not the first render call.
					anim = { startedAt: entry.timestamp, lastDeltaAt: 0 };
					this.entryAnim.set(entry.id, anim);
				}
				const prev = this.lastSeenText.get(entry.id) ?? "";
				if (entry.recap !== prev && entry.recap.length > 0) {
					anim.lastDeltaAt = now;
				}
				this.lastSeenText.set(entry.id, entry.recap);
				this.wasStreaming.add(entry.id);
			} else if (this.wasStreaming.has(entry.id)) {
				// Streaming -> finalized transition. Stamp settle start.
				const anim = this.entryAnim.get(entry.id) ?? { startedAt: now, lastDeltaAt: now };
				anim.finalizedAt = now;
				this.entryAnim.set(entry.id, anim);
				this.wasStreaming.delete(entry.id);
				liveIds.add(entry.id);
			} else {
				// Static row that's still inside its settle window.
				const anim = this.entryAnim.get(entry.id);
				if (anim?.finalizedAt !== undefined && (now - anim.finalizedAt) < SETTLE_MS) {
					liveIds.add(entry.id);
				}
			}
		}

		// GC stale entries: animations whose entry id is gone, or whose settle
		// has fully elapsed.
		for (const [id, anim] of this.entryAnim) {
			const stillLive = liveIds.has(id);
			const settleDone = anim.finalizedAt !== undefined && (now - anim.finalizedAt) >= SETTLE_MS;
			if (!stillLive && (settleDone || !this.lastSeenText.has(id))) {
				this.entryAnim.delete(id);
				this.lastSeenText.delete(id);
				this.wasStreaming.delete(id);
			}
		}
	}

	/** True iff at least one row needs the 80 ms tick to keep animating, OR
	 *  a transient notice is still live (so the swap to model-tag is timely). */
	private hasAnimating(): boolean {
		const now = Date.now();
		for (const anim of this.entryAnim.values()) {
			if (anim.finalizedAt === undefined) return true; // streaming
			if ((now - anim.finalizedAt) < SETTLE_MS) return true; // mid-settle
		}
		const notice = getState().notice;
		if (notice && notice.expiresAt > now) return true;
		return false;
	}

	// ── Borders ───────────────────────────────────────────────────────

	/**
	 * Top border with the title (and optional placeholder) cut in on the left
	 * and the model tag cut in on the right. Both segments are wrapped in
	 * "─ X ─" so the cuts read as label notches in the rule. Truncates the
	 * title before the tag so the right-side never gets squeezed off.
	 */
	private renderTopBorder(
		theme: Theme,
		width: number,
		goal: string,
		lastModel: string | undefined,
		modelOverride: string | undefined,
		noticeText: string | undefined,
	): string {
		const borderColor = (s: string) => theme.fg("border", s);

		// Right-side tag. Notice (transient session-start toast) wins over the
		// static model tag while it's live -- a soft suggestion to the user
		// about who's serving recaps right now.
		//
		// Tag content is truncated so the rendered line never exceeds `width`.
		// Budget reserves: 2 corners + 1 leading h + 1-char title + 2 spaces
		// around title + 2 trailing h-rule + 4 tag wrapper ("─ X ─") = 12.
		// Without this truncation, long /recap-model notices in narrow
		// terminals crash pi-tui's overflow guard.
		const tagContentBudget = Math.max(0, width - 12);
		let tagSegment = "";
		let tagVis = 0;
		const buildTag = (raw: string, color: "accent" | "dim"): void => {
			const truncated = this.truncateText(raw, tagContentBudget);
			const vis = visibleWidth(truncated);
			if (vis === 0) return;
			const styled = theme.fg(color, truncated);
			tagSegment = `${borderColor(BORDER.h)} ${styled} ${borderColor(BORDER.h)}`;
			tagVis = 1 + 1 + vis + 1 + 1;
		};
		if (noticeText) {
			buildTag(noticeText, "accent");
		} else {
			const modelId = modelOverride ?? lastModel;
			if (modelId) buildTag(modelOverride ? `${modelId} *` : modelId, "dim");
		}

		// Left-side title segment, sized to fit.
		// Reserve: 2 corners (tl + tr) + 1 leading "─" before title + at least
		// 2 trailing "─" (a continuous rule between the title cut and the tag,
		// or the right corner).
		const cornersAndPadding = 2 /*corners*/ + 1 /*leading h*/ + 2 /*trailing h before tag/corner*/;
		// Title cut: "─ {title} ─" - the leading h is shared with the
		// continuous rule; we just need " {title} ".
		const availableForTitle = Math.max(0, width - cornersAndPadding - tagVis - 2 /* spaces around title */);

		let titleStyled: string;
		let titleVisRaw: number;
		if (goal) {
			const truncated = this.truncateText(goal, availableForTitle);
			titleVisRaw = visibleWidth(truncated);
			titleStyled = theme.bold(colorText(titleColor(), truncated));
		} else {
			const truncated = this.truncateText(PLACEHOLDER_GOAL, availableForTitle);
			titleVisRaw = visibleWidth(truncated);
			titleStyled = theme.italic(theme.fg("dim", truncated));
		}

		// Build: tl + h + " " + title + " " + h... + tag + h... + tr
		const titleCutVis = 1 /*leading h*/ + 1 /*space*/ + titleVisRaw + 1 /*space*/;
		const consumed = 1 /*tl*/ + titleCutVis + tagVis + 1 /*tr*/;
		const fillCount = Math.max(0, width - consumed);
		const fill = borderColor(BORDER.h.repeat(fillCount));

		return (
			borderColor(BORDER.tl) +
			borderColor(BORDER.h) +
			" " +
			titleStyled +
			" " +
			fill +
			tagSegment +
			borderColor(BORDER.tr)
		);
	}

	/**
	 * Bottom border with a contextual focus hint cut in. Always visible, so
	 * users discover ctrl+shift+r without poking around. Hint copy:
	 *   - not focused                 -> "ctrl+shift+r focus"
	 *   - focused                     -> "↑↓ navigate · esc release"
	 *   - focused with older entries  -> "↑↓ navigate · esc release · +N older"
	 */
	private renderBottomBorder(theme: Theme, width: number, totalEntries: number): string {
		const borderColor = (s: string) => theme.fg("border", s);
		const olderCount = Math.max(0, totalEntries - VIEW_SIZE - this.scrollOffset);

		let hint: string;
		if (!this.focused) {
			hint = "ctrl+shift+r focus";
		} else if (olderCount > 0) {
			hint = `↑↓ navigate · esc release · +${olderCount} older`;
		} else {
			hint = "↑↓ navigate · esc release";
		}

		// Same construction as the top border, but with the cut on the LEFT.
		// Reserve: 2 corners + 2 leading h-rule cells (border-cut visual).
		const reserve = 2 + 2;
		const available = Math.max(1, width - reserve - 2 /* spaces around hint */);
		const truncated = this.truncateText(hint, available);
		const hintVis = visibleWidth(truncated);
		const hintStyled = theme.fg("dim", truncated);

		// Build: bl + h + h + " " + hint + " " + h... + br
		const consumed = 1 /*bl*/ + 2 /*hh*/ + 1 /*space*/ + hintVis + 1 /*space*/ + 1 /*br*/;
		const fillCount = Math.max(0, width - consumed);
		const fill = borderColor(BORDER.h.repeat(fillCount));

		return (
			borderColor(BORDER.bl) +
			borderColor(BORDER.h.repeat(2)) +
			" " +
			hintStyled +
			" " +
			fill +
			borderColor(BORDER.br)
		);
	}

	/**
	 * Wrap an interior payload with vertical borders + 1 cell of padding on
	 * each side. The interior payload visible width is expected to be at most
	 * (width - 4); this method right-pads with spaces.
	 */
	private padRow(theme: Theme, width: number, interior: string): string {
		const borderColor = (s: string) => theme.fg("border", s);
		const innerWidth = Math.max(0, width - 4);
		const truncated = truncateToWidth(interior, innerWidth, "…");
		const vis = visibleWidth(truncated);
		const padRight = " ".repeat(Math.max(0, innerWidth - vis));
		return borderColor(BORDER.v) + " " + truncated + padRight + " " + borderColor(BORDER.v);
	}

	// ── Interior renderers (no border, just the data cells) ──────────

	private renderEntryInterior(
		theme: Theme,
		innerWidth: number,
		entry: HistoryEntry,
		slot: "newest" | "mid" | "old",
		isSelected: boolean,
	): string {
		const time = this.timeCellStyled(theme, formatDate(entry.timestamp));
		const speaker = this.speakerCellStyled(theme, entry.speaker);
		const recap = this.recapForSlot(theme, entry.recap, slot, innerWidth);
		const selectorPrefix = isSelected ? theme.fg("accent", "❯ ") : "";
		const head = `${time}${this.gap()}${speaker}${this.gap()}${selectorPrefix}`;
		return head + recap;
	}

	private renderStreamingInterior(
		theme: Theme,
		innerWidth: number,
		entry: HistoryEntry,
		anim: EntryAnim | undefined,
		now: number,
	): string {
		const startedAt = anim?.startedAt ?? entry.timestamp;
		const lastDeltaAt = anim?.lastDeltaAt ?? 0;

		// Time column: dot replaces the timestamp during streaming. After the
		// 200 ms grace, the dot pulses; before that, it's blank.
		let timeCell: string;
		if (entry.recap.length === 0) {
			const elapsed = now - startedAt;
			if (elapsed < THINK_GRACE_MS) {
				timeCell = " ".repeat(TIME_COL_WIDTH);
			} else {
				timeCell = this.dotInTimeCell(theme, now, startedAt);
			}
		} else {
			// Once text starts arriving, the dot is gone; render a centered
			// dot column with "now" so the time is also there. Per spec the
			// dot lives in the time column only while there's no recap text.
			timeCell = this.timeCellStyled(theme, "now");
		}

		const speaker = this.speakerCellStyled(theme, entry.speaker);

		if (entry.recap.length === 0) {
			// No body yet - just time-cell + speaker, leaving recap empty.
			return `${timeCell}${this.gap()}${speaker}${this.gap()}`;
		}

		const stream = this.streamText(theme, entry.recap, innerWidth);
		const caret = this.caretVisible(now, lastDeltaAt)
			? theme.fg("accent", "▌")
			: " ";
		return `${timeCell}${this.gap()}${speaker}${this.gap()}${stream}${caret}`;
	}

	private renderSettlingInterior(
		theme: Theme,
		innerWidth: number,
		entry: HistoryEntry,
		settleStart: number,
		isSelected: boolean,
		now: number,
	): string {
		const k = Math.max(0, Math.min(1, (now - settleStart) / SETTLE_MS));
		// Need a plain (unstyled) recap before applying ANSI - inner truncation
		// is handled by streamText/recapForSlot logic, so use the same width
		// budget as a finalized row.
		const widthForRecap = Math.max(0, innerWidth - TIME_COL_WIDTH - COL_GAP - SPEAKER_COL_WIDTH - COL_GAP);
		const safe = entry.recap.length > widthForRecap
			? entry.recap.slice(0, widthForRecap)
			: entry.recap;
		let recapStyled: string;
		if (k < 0.33) {
			recapStyled = theme.fg("borderAccent", safe);
		} else if (k < 0.66) {
			recapStyled = theme.bold(theme.fg("accent", safe));
		} else {
			recapStyled = colorText(textColor(), safe);
		}
		const time = this.timeCellStyled(theme, formatDate(entry.timestamp));
		const speaker = this.speakerCellStyled(theme, entry.speaker);
		const selectorPrefix = isSelected ? theme.fg("accent", "❯ ") : "";
		return `${time}${this.gap()}${speaker}${this.gap()}${selectorPrefix}${recapStyled}`;
	}

	// ── Cell builders ────────────────────────────────────────────────

	private gap(): string {
		return " ".repeat(COL_GAP);
	}

	/** Time column: TIME_COL_WIDTH cells, right-aligned, dim. */
	private timeCellStyled(theme: Theme, text: string): string {
		const safe = text.length > TIME_COL_WIDTH ? text.slice(0, TIME_COL_WIDTH) : text;
		const padded = safe.padStart(TIME_COL_WIDTH, " ");
		return theme.fg("dim", padded);
	}

	/** Pulsating dot in the time column. Right-aligned to match the static
	 *  timestamp's resting position so the column doesn't shimmy as it swaps. */
	private dotInTimeCell(theme: Theme, now: number, startedAt: number): string {
		const elapsed = now - startedAt;
		const phase = (elapsed % DOT_CYCLE_MS) / DOT_CYCLE_MS;
		// 0..1 sine cycle, mapped from cosine so we start at the trough
		// (entry just entered post-grace -> dot fades up rather than blinking on).
		const k = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);
		let dot: string;
		if (theme.getColorMode() === "truecolor") {
			const rgb = rgbLerp(DOT_DIM, DOT_PEAK, k);
			dot = `${fgAnsi(rgb)}${DOT_GLYPH}${RESET}`;
		} else {
			const stepIdx = Math.min(
				DOT_FALLBACK_TOKENS.length - 1,
				Math.floor(k * (DOT_FALLBACK_TOKENS.length - 1) + 0.5),
			);
			const token = DOT_FALLBACK_TOKENS[stepIdx] ?? "accent";
			dot = theme.fg(token, DOT_GLYPH);
		}
		// Right-align: pad before the dot. The glyph is 1 cell wide.
		return " ".repeat(TIME_COL_WIDTH - 1) + dot;
	}

	/** Colored speaker tag. user = borderAccent (theme blue), agent = accent
	 *  (theme purple). Legacy entries (no speaker) render as 3 dim spaces so
	 *  the column still aligns under any theme. */
	private speakerCellStyled(theme: Theme, speaker: Speaker | undefined): string {
		if (!speaker) return "   ";
		const text = speaker === "user" ? "you" : "pi ";
		const token = speaker === "user" ? "borderAccent" : "accent";
		return theme.fg(token, text);
	}

	private recapForSlot(theme: Theme, recap: string, slot: "newest" | "mid" | "old", innerWidth: number): string {
		const recapBudget = Math.max(0, innerWidth - TIME_COL_WIDTH - COL_GAP - SPEAKER_COL_WIDTH - COL_GAP);
		const safe = recap.length > recapBudget ? recap.slice(0, Math.max(0, recapBudget - 1)) + "…" : recap;
		if (slot === "newest") return colorText(newestColor(), safe);
		if (slot === "mid") return theme.fg("muted", safe);
		return theme.fg("dim", safe);
	}

	private streamText(theme: Theme, raw: string, innerWidth: number): string {
		const trimmed = raw.replace(/[\r\n]+$/g, "");
		// Reserve room for the caret and the gap structure.
		const recapBudget = Math.max(0, innerWidth - TIME_COL_WIDTH - COL_GAP - SPEAKER_COL_WIDTH - COL_GAP - 1 /*caret*/);
		const capped = trimmed.length > recapBudget ? trimmed.slice(0, Math.max(0, recapBudget - 1)) + "…" : trimmed;
		return colorText(textColor(), capped);
	}

	// ── Animation helpers ─────────────────────────────────────────────

	private caretVisible(now: number, lastDeltaAt: number): boolean {
		if (now - lastDeltaAt < CARET_SOLID_AFTER_DELTA_MS) return true;
		const phase = (now % CARET_BLINK_MS) / CARET_BLINK_MS;
		return phase < 0.5;
	}

	private slotFor(globalIdx: number, total: number): "newest" | "mid" | "old" {
		const fromNewest = total - 1 - globalIdx;
		if (fromNewest === 0) return "newest";
		if (fromNewest === 1) return "mid";
		return "old";
	}

	// ── Truncation that ignores ANSI (we never style before this step) ───

	private truncateText(text: string, max: number): string {
		if (max <= 0) return "";
		if (text.length <= max) return text;
		if (max <= 1) return "…";
		return text.slice(0, max - 1) + "…";
	}

	// ── Animation timer ───────────────────────────────────────────────

	private ensureAnimTimer(): void {
		if (this.disposed) return;
		const needs = this.hasAnimating();
		if (needs && !this.animTimer) {
			this.animTimer = setInterval(() => {
				if (this.disposed) {
					this.stopAnimTimer();
					return;
				}
				if (!this.hasAnimating()) {
					this.stopAnimTimer();
					// One last render so the final settle frame paints.
					this.tui?.requestRender();
					return;
				}
				this.tui?.requestRender();
			}, TICK_MS);
		}
		if (!needs && this.animTimer) this.stopAnimTimer();
	}

	private stopAnimTimer(): void {
		if (this.animTimer) {
			clearInterval(this.animTimer);
			this.animTimer = undefined;
		}
	}
}
