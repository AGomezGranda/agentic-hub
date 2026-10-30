/** Role instructions: a pointer to the skill, then each override as its own paragraph. */
export function renderInstructions(
	skillPath: string,
	overrides: readonly string[],
): string {
	return [`Follow the skill at ${skillPath}.`, ...overrides].join("\n\n");
}
