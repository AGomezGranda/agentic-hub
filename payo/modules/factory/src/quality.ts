/**
 * Shared design expectations for planning and execution roles. Keep this the
 * single source of truth; role sources supply the detailed audit rubrics.
 */
export const QUALITY_EXPECTATIONS = `Design quality expectations (apply proportionately to the change):
- Name the domain language, bounded context, owned invariants, and aggregate boundaries.
- Keep clean/onion dependency direction inward: domain and application policy must not depend on infrastructure, transport, persistence, or framework details.
- Separate domain policy from application orchestration and infrastructure adapters; adapters depend inward.
- Apply SOLID, dependency injection at useful seams, and DRY for duplicated knowledge rather than incidental similarity.
- Use explicit typing and error handling, and prefer established codebase patterns over new abstractions.
- Do not invent aggregates, classes, interfaces, layers, or patterns without a present invariant or collaboration. Simplicity and clarity take precedence over ceremony.`;
