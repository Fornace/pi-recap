/**
 * Compact, calm timestamp formatting.
 *
 * Always ≤5 cells so it never crowds the recap text:
 *   < 1 min  → "now"
 *   < 1 h    → "Xm" / "XXm"   (e.g. "2m", "59m")
 *   same day → "HH:MM"        (e.g. "14:30")
 *   yesterday→ "HH:MM"        (no "y" prefix; columns stay tight - the
 *                              previous-day distinction is implicit from the
 *                              row's position in the trail)
 *   same yr  → "Mon D"        (e.g. "May 9"; "May 13" would be 6 - we clip)
 *   else     → "YYYY"
 */

const MONTHS = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

export function formatDate(timestamp: number, now?: number): string {
	const current = now ?? Date.now();
	const diff = current - timestamp;
	const date = new Date(timestamp);
	const today = new Date(current);

	if (diff < 60_000) return "now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;

	if (isSameDay(date, today)) {
		return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}

	const yesterday = new Date(current - 86_400_000);
	if (isSameDay(date, yesterday)) {
		// Same compact form as today; the previous-day distinction is implicit.
		return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}

	if (date.getFullYear() === today.getFullYear()) {
		// "Mon D" fits in 5; "Mon DD" is clipped to 5 cells.
		const s = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
		return s.length > 5 ? s.slice(0, 5) : s;
	}

	return `${date.getFullYear()}`;
}
