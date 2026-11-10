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
 *   - Bottom border carries a contextual hint: "click or scroll" when idle,
 *     "↑↓/wheel scroll · click/esc release" when focused. Always visible.
 *     Solves the v3 complaint that the hint was invisible, and advertises the
 *     mouse affordances for terminals where ctrl+shift+r never arrives.
 *   - Mouse: the panel implements handleMouse, so a wheel over it pages
 *     through older entries and a left press focuses it / selects the clicked
 *     row / releases it. Typing anything hands focus back to the editor and
 *     replays the keystroke, so no Esc is needed to resume composing.
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
import { clearNotice, getActiveState, getActiveSessionId } from "../state/store.js";
import type { HistoryEntry, Speaker } from "../state/state.js";
import { formatDate } from "../util/date.js";
import { fgAnsi, parseHex, rgbLerp, RESET, type RGB, newestColor, textColor, colorText, isLightBg } from "./anim.js";

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

/** The slice of pi-tui's mouse event the panel reads. Declared structurally on
 *  purpose: pi-tui only gained the mouse API in 1.x, and this file must keep
 *  compiling against older dev installs (types are erased at runtime, and the
 *  host passes the real event object through unchanged). */
interface MouseEventLike {
	type: "press" | "release" | "move" | "drag" | "click" | "wheel";
	button: "left" | "middle" | "right" | "none";
	/** Zero-based row inside this component, counting the decoy row above the card. */
	y: number;
	/** Logical lines; negative scrolls up. */
	wheelDelta?: number;
}

/** The slice of pi-tui's mouse result the panel returns. */
interface MouseResultLike {
	handled?: boolean;
	capture?: boolean;
	focus?: boolean;
	render?: boolean;
}

/** Where the card's rows landed in the last render() call. Mouse coordinates
 *  arrive relative to the component's own top edge, so hit-testing needs the
 *  same row numbering the terminal is showing right now: the decoy row sits
 *  above the card and shifts everything down by one, and short histories
 *  render fewer than VIEW_SIZE content rows. */
interface RowMap {
	/** Row index of the first interior (recap) row. */
	firstHistoryRow: number;
	/** How many interior rows are recap entries. */
	historyRows: number;
	/** True when those interior rows are selectable recap entries (not bench /
	 *  setup / empty-placeholder content). */
	interactive: boolean;
}

export class StatusWidget implements Component {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private firstDeltaAfterRegistration = true;
	private tui: TUI | undefined;
	private currentTheme: Theme | undefined;
	private disposed = false;

	/** The component that had focus before we stole it (typically the host
	 *  editor). Captured in toggleFocus() and restored in releaseFocus().
	 *  pi-tui's `focusedComponent` is private in TS but reachable at runtime —
	 *  we read it via a small cast. setFocus(null) cannot be used as a release
	 *  because the editor isn't reachable any other way and goes unfocused
	 *  forever, swallowing all keystrokes. */
	private previousFocus: Component | null = null;

	private focused = false;
	private scrollOffset = 0;
	private selectedRow = VIEW_SIZE - 1;
	/** Row numbering of the last painted frame, used by handleMouse(). */
	private rowMap: RowMap | undefined;

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
	/** Slow tick for time counter freshness after animations settle. */
	private slowTimer: ReturnType<typeof setInterval> | undefined;
	private slowInterval: number = 30_000;

	/** Transient bench progress lines. When set, the widget interior shows
	 *  bench progress/results instead of normal recap rows. */
	private benchLines: string[] | undefined;

	/** When true and there's no recap history, show a setup invitation
	 *  in the widget interior asking the user to run /recap. Cleared
	 *  automatically once the user configures a recap model. */
	private setupNeeded = false;

	/** Per-instance render counter. Drives the decoy-row width so the decoy
	 *  changes whenever the widget height changes (new history entry arrives).
	 *  pi-tui diffs frames by string equality per row index — a changing
	 *  decoy forces every subsequent row to be re-rendered, which prevents
	 *  orphaned border fragments in scrollback when the chat grows.
	 *  Only bumping on height change (not every render) avoids re-rendering
	 *  images from pi-banana and other inline terminal content. */
	private decoyTick = 0;
	/** Last render's history length. Used to detect height changes. */
	private lastHistoryLength = 0;

	/** When true, render() returns [] so the widget disappears while a
	 *  custom UI overlay (e.g. pi-bench's Select) is active. Prevents the
	 *  animation timer from painting stale frames over the overlay. */
	private renderingPaused = false;

	// ── Lifecycle wiring (called from index.ts) ───────────────────────

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
		// Always reset rendering pause on new session — the widget is reused
		// across sessions (??= in session_start), and a previous session may
		// have ended while the bench overlay was active.
		this.renderingPaused = false;
	}

	/** Whether the widget currently has keyboard focus. */
	get isFocused(): boolean {
		return this.focused;
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
			// On the very first delta after registration, force a full redraw
			// to clear pi-tui's frame cache. This prevents the stale initial
			// frame (empty widget) from remaining visible as a ghost top border
			// when content arrives. Subsequent updates use normal incremental
			// rendering for performance.
			if (this.firstDeltaAfterRegistration) {
				this.firstDeltaAfterRegistration = false;
				this.tui?.requestRender(true);
			} else {
				this.tui?.requestRender();
			}
		}
		this.ensureAnimTimer();
	}

	/** Called by index.ts to push bench progress into the widget interior.
	 *  Pass lines to display; pass undefined to clear and restore normal view. */
	setBenchProgress(lines: string[] | undefined): void {
		this.benchLines = lines;
		this.update();
	}

	/** Called by index.ts on session_start when no recap model is configured.
	 *  Shows a setup invitation in the widget interior. Auto-clears once the
	 *  user configures a recap model (modelOverride or lastModel). */
	setSetupNeeded(needed: boolean): void {
		this.setupNeeded = needed;
		this.update();
	}

	/** Temporarily stop rendering. Returns [] from render() so the widget
	 *  disappears while a custom UI overlay (e.g. pi-bench's Select) is
	 *  active. Call resumeRendering() after the overlay is dismissed.
	 *  Also clears benchLines so there's no intermediate render with
	 *  stale bench content between pause and overlay appearance. */
	pauseRendering(): void {
		this.renderingPaused = true;
		this.benchLines = undefined;
		this.stopAnimTimer();
		this.stopSlowTimer();
		// Force a full redraw so the last widget frame is cleared from the
		// terminal before the overlay paints.
		this.tui?.requestRender(true);
	}

	/** Resume rendering after a pause (e.g. after the overlay is dismissed).
	 *  Just clears the flag — does NOT call update(). The next natural render
	 *  cycle (from a state change, streaming delta, or slow timer) will bring
	 *  the widget back. This avoids racing with overlay dismissal. */
	resumeRendering(): void {
		this.renderingPaused = false;
	}

	/** Bound to the ctrl+shift+r shortcut (and to clicks on the card). Toggles
	 *  focus. Snap, never animate. */
	toggleFocus(): void {
		if (!this.tui) return;
		const history = getActiveState().history;
		if (!this.focused) {
			if (history.length === 0) return;
			this.focused = true;
			this.scrollOffset = 0;
			this.selectedRow = VIEW_SIZE - 1;
			this.clampSelectedRow(history.length);
			// Capture the current focus target (typically the host editor) so
			// releaseFocus() can hand it back. TUI.focusedComponent is private
			// in the TS surface but a plain field at runtime.
			this.previousFocus = (this.tui as unknown as { focusedComponent: Component | null }).focusedComponent;
			this.tui.setFocus(this);
		} else {
			this.releaseFocus();
		}
		this.tui.requestRender();
	}

	/** Take focus and point the selection at one visible row. Shared by the
	 *  keyboard shortcut and the mouse press path; keeps the previously focused
	 *  component so releaseFocus() can hand it back. */
	private grabFocus(rowIndex: number): void {
		const tui = this.tui;
		if (!tui) return;
		if (!this.focused) {
			const current = (tui as unknown as { focusedComponent: Component | null }).focusedComponent;
			this.previousFocus = current && current !== this ? current : null;
			this.focused = true;
			tui.setFocus(this);
		}
		this.selectedRow = rowIndex;
		this.clampSelectedRow();
	}

	/** Number of recap rows the current scroll offset actually shows. */
	private visibleCount(total = getActiveState().history.length): number {
		return Math.min(VIEW_SIZE, Math.max(0, total - this.scrollOffset));
	}

	/** Keep selectedRow inside the visible window after any scroll change. */
	private clampSelectedRow(total = getActiveState().history.length): void {
		const count = this.visibleCount(total);
		this.selectedRow = count === 0 ? 0 : Math.max(0, Math.min(count - 1, this.selectedRow));
	}

	/** Re-derive the focused flag from the renderer.
	 *
	 *  A click on the editor or transcript hands focus elsewhere without ever
	 *  calling into this component (pi-tui dispatches the synthesized click
	 *  straight to the new target). Without this check the panel would keep its
	 *  selection marker and focused hint, and a later click would take the
	 *  "already focused" branch while the keyboard actually lives elsewhere. */
	private syncFocusFromTui(): void {
		if (!this.focused) return;
		const tui = this.tui as unknown as { getFocusedComponent?: () => Component | null } | undefined;
		if (!tui || typeof tui.getFocusedComponent !== "function") return;
		if (tui.getFocusedComponent() !== this) {
			this.focused = false;
			this.previousFocus = null;
		}
	}

	/** Release keyboard focus and hand it back to whatever was focused before
	 *  the widget grabbed it (the editor in normal interactive mode). Never
	 *  call setFocus(null) here — that leaves the TUI with no focused
	 *  component and the editor never receives keystrokes again. */
	private releaseFocus(): void {
		this.focused = false;
		this.tui?.setFocus(this.previousFocus);
		this.previousFocus = null;
		this.clampSelectedRow();
	}

	dispose(): void {
		// Reentry guard: setExtensionWidget(undefined) in pi-host calls back
		// into dispose() before our `widgetRegistered` flag is meaningful, so
		// without this we recur until the stack overflows.
		if (this.disposed) return;
		this.disposed = true;
		this.renderingPaused = false;
		this.stopAnimTimer();
		this.stopSlowTimer();
		const ctx = this.uiCtx;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.currentTheme = undefined;
		this.uiCtx = undefined;
		this.focused = false;
		this.previousFocus = null;
		this.rowMap = undefined;
		this.entryAnim.clear();
		this.lastSeenText.clear();
		this.wasStreaming.clear();
		if (ctx) ctx.setWidget(WIDGET_KEY, undefined);
	}

	// ── Component interface ───────────────────────────────────────────

	render(width: number): string[] {
		const theme = this.currentTheme;
		if (!theme) return [];
		// A focus change outside this component (click on the editor, an overlay
		// taking over) must drop the selection chrome on the next frame.
		this.syncFocusFromTui();
		// Rounded card needs at least the two corners + 1 cell of horizontal
		// payload between them. Below that we just emit nothing.
		if (width < 4) return [];

		// Paused while a custom UI overlay (e.g. pi-bench's Select) is
		// active, so the animation timer can't paint stale frames over it.
		if (this.renderingPaused) return [];

		const state = getActiveState();
		const { goal, history } = state;
		const now = Date.now();

		// Drop expired notices before computing the title row so the toast
		// disappears on the very tick after expiresAt without leaving a stale
		// label flashing for one frame.
		if (state.notice && state.notice.expiresAt <= now) {
			const activeId = getActiveSessionId();
			if (activeId) clearNotice(activeId);
		}

		this.reconcileAnim(history, now);

		// Adaptive slow tick, driven by the newest visible entry (the youngest
		// timestamp is always the one closest to its next display threshold):
		//   < 1 min   → 1 s   (so "now" → "1m" flips on time)
		//   < 1 hour  → 20 s  (so "Xm" → "X+1m" stays roughly fresh)
		//   ≥ 1 hour  → off   (formatDate is absolute from here on — no need to
		//                      re-render until state actually changes)
		const newestAge = history.length > 0 ? now - history[history.length - 1]!.timestamp : Infinity;
		const slowInterval = newestAge < 60_000 ? 1_000 : newestAge < 3_600_000 ? 20_000 : undefined;
		this.ensureSlowTimer(slowInterval);

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
		// Bump the decoy on EVERY render so the whitespace sentinel above the
		// card always changes. pi-tui diffs frames by row-level string equality
		// — if the decoy is identical between two renders where the widget
		// shifted vertically, pi-tui skips clearing the old rows and strands a
		// ghost box in scrollback. The previous conditional bump ("only when
		// history length changes") had a gap: update() preemptively bumped
		// before the history grew, then render() saw the length change and
		// skipped, reusing the same decoy value at the new position.
		//
		// Trade-off: every row below the widget re-renders each tick (80 ms
		// during animation), which can cause inline images to flash. The
		// alternative — a ghosted duplicate status box — is worse.
		this.decoyTick = (this.decoyTick + 1) % 8;
		this.lastHistoryLength = history.length;
		lines.push(" ".repeat(1 + this.decoyTick));

		const liveNotice = state.notice && state.notice.expiresAt > now ? state.notice : undefined;
		lines.push(
			this.renderTopBorder(theme, width, goal, state.lastModel, state.modelOverride, liveNotice?.text),
		);
		// Everything pushed from here to the bottom border is a card interior row;
		// the branches below record how many of those rows are recap entries.
		const firstHistoryRow = lines.length;

		const innerWidth = Math.max(0, width - 2 * (1 + BORDER_PAD)); // border+pad on each side

		// Bench mode: show progress lines instead of normal history.
		if (this.benchLines && this.benchLines.length > 0) {
			const benchVisible = this.benchLines.slice(-VIEW_SIZE);
			benchVisible.forEach((line: string) => {
				const truncated = line.length > innerWidth ? line.slice(0, innerWidth - 1) + "…" : line;
				const padded = truncated + " ".repeat(Math.max(0, innerWidth - truncated.length));
				lines.push(this.padRow(theme, width, padded));
			});
			// Pad remaining view rows so the card height stays consistent.
			for (let i = benchVisible.length; i < VIEW_SIZE; i++) {
				lines.push(this.padRow(theme, width, ""));
			}
			this.rowMap = { firstHistoryRow, historyRows: 0, interactive: false };
			lines.push(this.renderBottomBorder(theme, width, history.length));
			return lines;
		}

		// Setup invitation: show when no recap model is configured, regardless
		// of whether recap history exists. The user can run /recap → Benchmark
		// to pick the fastest model, or /recap → Model to choose manually.
		// Auto-clears once modelOverride or lastModel is set.
		if (this.setupNeeded && !state.modelOverride && !state.lastModel) {
			const setupLines = [
				theme.fg("accent", "Finish setup: run /recap to pick your recap model"),
				theme.fg("warning", "⚡ Use Benchmark for the best pick"),
			];
			setupLines.forEach((line) => {
				const truncated = line.length > innerWidth ? line.slice(0, innerWidth - 1) + "…" : line;
				const padded = truncated + " ".repeat(Math.max(0, innerWidth - truncated.length));
				lines.push(this.padRow(theme, width, padded));
			});
			for (let i = setupLines.length; i < VIEW_SIZE; i++) {
				lines.push(this.padRow(theme, width, ""));
			}
			this.rowMap = { firstHistoryRow, historyRows: 0, interactive: false };
			lines.push(this.renderBottomBorder(theme, width, history.length));
			return lines;
		}

		const total = history.length;
		const maxOffset = Math.max(0, total - VIEW_SIZE);
		if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
		const end = total - this.scrollOffset;
		const start = Math.max(0, end - VIEW_SIZE);
		const visible = history.slice(start, end);

		if (visible.length === 0) {
			// Empty interior: render one blank padded row so the card has a
			// vertical body even before the first turn.
			if (state.modelWarning) {
				lines.push(this.padRow(theme, width, theme.fg("warning", state.modelWarning)));
				lines.push(this.padRow(theme, width, theme.fg("warning", "Use /recap to run the benchmark and pick another.")));
			} else {
				lines.push(this.padRow(theme, width, ""));
			}
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
			
			if (state.modelWarning) {
				lines.push(this.padRow(theme, width, theme.fg("warning", state.modelWarning)));
				lines.push(this.padRow(theme, width, theme.fg("warning", "Use /recap to run the benchmark and pick another.")));
			}
		}

		lines.push(this.renderBottomBorder(theme, width, total));

		this.rowMap = {
			firstHistoryRow,
			historyRows: visible.length,
			interactive: visible.length > 0,
		};

		return lines;
	}

	// ── Mouse ─────────────────────────────────────────────────────────

	/**
	 * Mouse contract (pi-tui calls this for events inside the panel's layout
	 * box: the above-editor widget container forwards them with local
	 * coordinates, where y=0 is the decoy row above the top border):
	 *   - wheel: page through older / newer recap entries without needing focus
	 *     first, and swallow the event so the transcript underneath stays put.
	 *   - left press on an entry row: focus + select it; press the already
	 *     selected row to release; press a frame row to toggle focus.
	 * Focus is moved with tui.setFocus() here instead of returning
	 * `focus: true`, so releaseFocus() can hand the keyboard back to the exact
	 * component that had it.
	 */
	handleMouse(event: MouseEventLike): MouseResultLike | undefined {
		if (this.disposed || this.renderingPaused) return undefined;
		if (event.type === "wheel") return this.handleWheel(event);
		if (event.type !== "press" || event.button !== "left") return undefined;
		return this.handlePress(event);
	}

	private handleWheel(event: MouseEventLike): MouseResultLike | undefined {
		const total = getActiveState().history.length;
		const maxOffset = Math.max(0, total - VIEW_SIZE);
		const delta = event.wheelDelta ?? 0;
		if (delta === 0) return undefined;
		if (maxOffset === 0) {
			// Nothing older to show. When focused the panel still owns the wheel
			// (arrows and wheel do the same thing); when idle the host keeps it so
			// the transcript still scrolls under a pointer resting on the card.
			return this.focused ? { handled: true, render: false } : undefined;
		}
		const step = Math.max(1, Math.min(VIEW_SIZE, Math.abs(delta)));
		const next = delta < 0
			? Math.min(maxOffset, this.scrollOffset + step) // wheel up: older entries
			: Math.max(0, this.scrollOffset - step); // wheel down: newer entries
		if (next === this.scrollOffset) {
			// Already at an end of the history: consume anyway so the wheel does
			// not fall through and scroll the chat behind the panel.
			return { handled: true, render: false };
		}
		this.scrollOffset = next;
		this.clampSelectedRow(total);
		this.tui?.requestRender();
		return { handled: true, render: true };
	}

	private handlePress(event: MouseEventLike): MouseResultLike | undefined {
		const map = this.rowMap;
		if (!map) return undefined;
		this.syncFocusFromTui();
		const total = getActiveState().history.length;
		const rowIndex = event.y - map.firstHistoryRow;
		const onEntryRow = map.interactive && rowIndex >= 0 && rowIndex < map.historyRows;

		if (onEntryRow) {
			if (!this.focused) {
				this.grabFocus(rowIndex);
			} else if (rowIndex === this.selectedRow) {
				// Second click on the row already selected: done reading.
				this.releaseFocus();
			} else {
				this.selectedRow = rowIndex;
			}
			this.tui?.requestRender();
			return { handled: true, render: true };
		}

		// Frame rows (top / bottom border, blank filler, bench or setup body)
		// have nothing to select: a press there just toggles focus.
		if (!this.focused && total === 0) return undefined;
		this.toggleFocus();
		return { handled: true, render: true };
	}

	handleInput(data: string): void {
		if (!this.focused) return;
		const total = getActiveState().history.length;
		if (total === 0) {
			this.releaseFocus();
			this.tui?.requestRender();
			return;
		}

		if (matchesKey(data, Key.ctrlShift("r")) || matchesKey(data, Key.escape)) {
			this.releaseFocus();
			this.tui?.requestRender();
			return;
		}

		if (matchesKey(data, Key.up)) {
			if (this.selectedRow > 0) {
				this.selectedRow--;
			} else if (this.scrollOffset + VIEW_SIZE < total) {
				this.scrollOffset++;
				this.clampSelectedRow(total);
			}
			this.tui?.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.selectedRow < this.visibleCount(total) - 1) {
				this.selectedRow++;
			} else if (this.scrollOffset > 0) {
				this.scrollOffset--;
				this.clampSelectedRow(total);
			}
			this.tui?.requestRender();
			return;
		}

		// Any other key means the user is done reading and wants to type. Hand
		// focus back to the editor and replay the keystroke into it, so no Esc or
		// extra click is needed to resume composing.
		const target = this.previousFocus;
		if (!target) return;
		if (data === "\r") this.bumpDecoy();
		this.releaseFocus();
		this.tui?.requestRender();
		target.handleInput?.(data);
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
		const notice = getActiveState().notice;
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
			titleStyled = theme.bold(theme.fg("accent", truncated));
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
	 * Bottom border with a contextual hint cut in. Always visible, so the mouse
	 * affordances are discoverable without poking around:
	 *   - not focused        -> "click or scroll" (+ "(↑N more)" when older
	 *                           entries are out of view)
	 *   - focused            -> "↑↓/wheel scroll · click/esc release" (+ "+N older")
	 */
	private renderBottomBorder(theme: Theme, width: number, totalEntries: number): string {
		const borderColor = (s: string) => theme.fg("border", s);
		const olderCount = Math.max(0, totalEntries - VIEW_SIZE - this.scrollOffset);

		let hint: string;
		if (!this.focused) {
			hint = olderCount > 0 ? `click or scroll (↑${olderCount} more)` : "click or scroll";
		} else if (olderCount > 0) {
			hint = `↑↓/wheel scroll · click/esc release · +${olderCount} older`;
		} else {
			hint = `↑↓/wheel scroll · click/esc release`;
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

	/** Bump the decoy row width. Called before state changes that may shift
	 *  the widget vertically, so pi-tui clears the old rows. */
	bumpDecoy(): void {
		this.decoyTick = (this.decoyTick + 1) % 8;
	}

	/** Force a full redraw by clearing pi-tui's frame cache. This ensures
	 *  the changed decoy row paints immediately, before any subsequent
	 *  content (user message, agent output) composites on screen. */
	forceRender(): void {
		this.tui?.requestRender(true);
	}

	/** Reconcile the slow tick to the interval requested by render(). Pass
	 *  `undefined` to stop ticking — used once every visible timestamp is
	 *  absolute and re-renders would just be wasted wakeups. */
	private ensureSlowTimer(wantInterval: number | undefined): void {
		if (this.disposed) return;
		if (wantInterval === undefined) {
			this.stopSlowTimer();
			return;
		}
		// If timer exists but at the wrong interval, restart it.
		if (this.slowTimer && this.slowInterval !== wantInterval) {
			this.stopSlowTimer();
		}
		if (!this.slowTimer) {
			this.slowInterval = wantInterval;
			this.slowTimer = setInterval(() => {
				if (this.disposed) {
					this.stopSlowTimer();
					return;
				}
				this.tui?.requestRender();
			}, wantInterval);
		}
	}

	private stopSlowTimer(): void {
		if (this.slowTimer) {
			clearInterval(this.slowTimer);
			this.slowTimer = undefined;
		}
	}
}
