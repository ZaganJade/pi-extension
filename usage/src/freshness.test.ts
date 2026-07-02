import { test } from "node:test";
import assert from "node:assert/strict";
import { isReportCacheFresh } from "./freshness.ts";

const TTL = 120_000; // 2 minutes, matching index.ts CACHE_TTL

test("not fresh when no cache exists yet", () => {
	assert.equal(isReportCacheFresh(null, 30_000, 0, TTL), false);
});

test("fresh within TTL when no new turn has arrived", () => {
	// Cache built at t=0, no turn after, now=30s (< TTL).
	assert.equal(isReportCacheFresh({ at: 0 }, 30_000, 0, TTL), true);
});

test("stale once the TTL window has elapsed", () => {
	assert.equal(isReportCacheFresh({ at: 0 }, 200_000, 0, TTL), false);
});

test("THE BUG: stale when a new turn arrived after the cache was built, even within TTL", () => {
	// This is the "graph always the same" symptom: a turn lands at t=10s,
	// user reopens at t=30s (still inside the 2-minute TTL). The time-only
	// cache would wrongly serve the stale snapshot, so the trend graph would
	// not reflect the new turn. The cache MUST be treated as stale here so the
	// next open rescans the (fresh) session files.
	assert.equal(isReportCacheFresh({ at: 0 }, 30_000, 10_000, TTL), false);
});

test("fresh again once the turn-aware cache is rebuilt after the turn", () => {
	// After the turn at t=10s, a rescan rebuilds the cache at t=12s.
	// Reopening at t=30s with no further turn is fresh again.
	assert.equal(isReportCacheFresh({ at: 12_000 }, 30_000, 10_000, TTL), true);
});

test("a turn at exactly the cache time does not invalidate (>= would be too eager)", () => {
	// lastTurnAt == cached.at means the cache already includes that turn.
	assert.equal(isReportCacheFresh({ at: 10_000 }, 30_000, 10_000, TTL), true);
});
