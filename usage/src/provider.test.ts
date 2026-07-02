import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyZaiLimits, type ZaiQuotaLimit } from "./zai.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();

// Regression: the documented "max"-plan codes still resolve both windows
// (proves the extract refactor preserved the original behaviour).
test("standard max-plan codes resolve both 5h and weekly windows", () => {
	const limits: ZaiQuotaLimit[] = [
		{
			type: "TOKENS_LIMIT",
			unit: 3,
			number: 5,
			percentage: 81,
			nextResetTime: now + 5 * HOUR,
		},
		{
			type: "TOKENS_LIMIT",
			unit: 6,
			number: 1,
			percentage: 51,
			nextResetTime: now + 7 * DAY,
		},
	];
	const out = classifyZaiLimits(limits, "max");
	assert.ok(out, "should return a planQuota");
	assert.equal(out?.session5h?.usedPct, 81);
	assert.equal(out?.weekly?.usedPct, 51);
	assert.equal(out?.plan, "max");
});

// THE BUG: other ZAI plans/regions encode the weekly window with a different
// unit/number than the documented (6,1). With the old exact-match-only lookup
// the weekly bar silently disappeared (only 5h showed) for those accounts.
test("weekly resolves when ZAI encodes the window with non-standard codes", () => {
	const limits: ZaiQuotaLimit[] = [
		{
			type: "TOKENS_LIMIT",
			unit: 3,
			number: 5,
			percentage: 42,
			nextResetTime: now + 5 * HOUR,
		},
		// weekly reported with a DIFFERENT code (e.g. unit 7 instead of 6)
		{
			type: "TOKENS_LIMIT",
			unit: 7,
			number: 1,
			percentage: 51,
			nextResetTime: now + 7 * DAY,
		},
	];
	const out = classifyZaiLimits(limits, "pro");
	assert.ok(out, "should return a planQuota");
	assert.ok(out?.session5h, "5h window must still resolve");
	assert.ok(out?.weekly, "weekly window MUST resolve for non-standard codes");
	assert.equal(out?.weekly?.usedPct, 51);
});

// Edge: when BOTH codes differ from the documented ones, fall back to
// reset-window length so the labels stay correct (shorter = 5h, longer = weekly).
test("both windows assign correctly by reset length when no codes match", () => {
	const limits: ZaiQuotaLimit[] = [
		{
			type: "TOKENS_LIMIT",
			unit: 99,
			number: 9,
			percentage: 30,
			nextResetTime: now + 4 * HOUR,
		}, // 5h-ish
		{
			type: "TOKENS_LIMIT",
			unit: 88,
			number: 8,
			percentage: 70,
			nextResetTime: now + 6 * DAY,
		}, // weekly-ish
	];
	const out = classifyZaiLimits(limits, "lite");
	assert.ok(out?.session5h, "shorter window should map to 5h");
	assert.ok(out?.weekly, "longer window should map to weekly");
	assert.equal(out?.session5h?.usedPct, 30);
	assert.equal(out?.weekly?.usedPct, 70);
});

// Regression: web-search (TIME_LIMIT) detection is unaffected.
test("web searches still parsed when present", () => {
	const limits: ZaiQuotaLimit[] = [
		{
			type: "TOKENS_LIMIT",
			unit: 3,
			number: 5,
			percentage: 10,
			nextResetTime: now + 5 * HOUR,
		},
		{
			type: "TIME_LIMIT",
			unit: 5,
			number: 1,
			usage: 4000,
			currentValue: 1200,
			remaining: 2800,
			nextResetTime: now + DAY,
		},
	];
	const out = classifyZaiLimits(limits, "max");
	assert.equal(out?.webSearches?.used, 1200);
	assert.equal(out?.webSearches?.limit, 4000);
});
