export function contextHint(expanded: boolean): string {
	return expanded
		? "Enter collapse · r refresh · q close"
		: "Tab details · e export · i import · h handoff · q close";
}

/** Structured shortcut list for aligned footer row. */
export function contextShortcuts(expanded: boolean): { key: string; label: string }[] {
	if (expanded) {
		return [
			{ key: "Enter", label: "collapse" },
			{ key: "r", label: "refresh" },
			{ key: "q", label: "close" },
		];
	}
	return [
		{ key: "Tab", label: "details" },
		{ key: "e", label: "export" },
		{ key: "i", label: "import" },
		{ key: "h", label: "handoff" },
		{ key: "q", label: "close" },
	];
}

export function formatShortcutList(
	shortcuts: { key: string; label: string }[],
): string {
	return shortcuts.map((s) => `${s.key} ${s.label}`).join("  ·  ");
}

/** Mascot removed — footer uses structured Note/Keys rows. */
export function renderContextMascot(): string[] {
	return [];
}
