# Code quality checks

Inspect relevant contracts and consumers for each applicable dimension.
Require a violated project rule or concrete design consequence; name the
smallest correction preserving valid behavior.

## Responsibilities and interfaces (SOLID)

Identify independent reasons to change; size or method count alone is not SRP.
Trace substitutability: subtypes must not narrow accepted inputs, weaken
guarantees or introduce unexpected effects. Check whether consumers depend on
unused capabilities. Extension mechanisms need actual extension requirements;
a new branch or stable conditional is not automatically an OCP violation.

## Dependency injection

Trace side-effecting dependencies from construction through use and cleanup.
Check the adopted DI contract, lifecycle ownership, testability and configuration.
Prefer narrow parameters or constructor dependencies; do not require containers
or interfaces over pure helpers. Framework-managed injection at a clear
composition boundary and resources built in a script entry point are legitimate.

If an adopted strict profile prohibits constructing side-effecting collaborators
in domain/application code, report violations even with one implementation.
Distinguish compliance from inferred lifecycle problems. Cross-module ownership
corrections belong to architecture findings.

## Duplication (DRY)

Trace repeated business knowledge to its owner and change trigger. Report
copies that must change together with locations and a divergence scenario.
Similar code implementing independent rules is legitimate repetition;
merging it would create false coupling. Report duplicated business knowledge
once as a DRY finding; if consolidation changes cross-module ownership,
note that architectural decision within the finding rather than duplicating
or suppressing it.

## Simplicity (KISS)

Inventory consumers and protected invariants before recommending removal.
Find speculative extension points, wrappers exposing the wrapped API unchanged,
and unnecessary indirection. Show a simpler shape preserving validation and
error handling. One implementation alone does not invalidate a useful boundary.
Preserve seams required by the adopted contract; question applicability
separately rather than silently deleting them.

## Types and input boundaries

Trace unsafe escapes, unchecked casts, ambiguous identifiers, optional states
and missing variant handling to invalid states consumers can observe.
Check exhaustiveness with the project's actual checker. Distinguish validated
narrowing from unchecked assertions. Nominal IDs prevent some argument mixups
but do not validate runtime input. Primitive parameters are not automatically
defective without a rule or concrete ambiguity.

## Errors

Follow failures to caller-observable outcomes: raised error, explicit result,
retry, partial success or log only. Find success reported after failure,
lost context and fallback masking permanent failure. Broad catches at deliberate
process/task boundaries are legitimate when failures remain visible and
lifecycles are handled correctly. Preserve useful causes and language conventions.
