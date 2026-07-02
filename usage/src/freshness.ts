/**
 * In-memory report-cache freshness decision.
 *
 * The usage panel reuses a scanned `Report` for up to `CACHE_TTL` to avoid
 * re-reading hundreds of session files on every `/usage` open. That TTL is
 * purely time-based — which is exactly the bug behind the trend graph looking
 * frozen ("always the same"): a user who opens the panel, spends more tokens,
 * and reopens within the TTL window gets the *same* stale snapshot back, even
 * though the live session file on disk already has the new turns.
 *
 * The fix is to also invalidate the cache whenever a new assistant turn has
 * landed since the cache was built. Because pi flushes each turn to disk in
 * realtime, a fresh scan will then pick those turns up, so the trend (and every
 * other panel view) reflects current usage instead of a snapshot from up to
 * two minutes ago.
 *
 * This module is intentionally dependency-free so the decision is unit-testable
 * in isolation.
 */

/** A cache entry carrying the epoch-ms timestamp it was built at. */
export interface ReportCacheStamp {
	at: number;
}

/**
 * Is the in-memory report cache still fresh enough to reuse without rescanning?
 *
 * Fresh only when ALL of:
 *   1. a cache exists,
 *   2. we're still inside the TTL window, and
 *   3. no assistant turn has arrived after the cache was built.
 *
 * Condition (3) is the realtime fix: a new turn means the on-disk session file
 * changed, so the cached report is stale regardless of the TTL window.
 *
 * @param cached     The current in-memory cache stamp (or null when none yet).
 * @param now        Current epoch-ms.
 * @param lastTurnAt Epoch-ms of the most recent assistant turn seen this pi run,
 *                   or 0 when no turn has been observed.
 * @param ttlMs      Max age of a cache entry before it is considered stale.
 */
export function isReportCacheFresh(
	cached: ReportCacheStamp | null,
	now: number,
	lastTurnAt: number,
	ttlMs: number,
): boolean {
	if (!cached) return false;
	if (now - cached.at >= ttlMs) return false;
	// A turn that arrived after the cache was built invalidates it, regardless
	// of the TTL window, so the next open re-reads the (fresh) session files.
	if (lastTurnAt > cached.at) return false;
	return true;
}
