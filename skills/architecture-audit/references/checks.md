# Architecture checks

Apply the governing architecture contract and its accepted exceptions. These
checks guide investigation; the selected standard defines mandatory rules.

## Boundaries

Inventory dependency edges and compare each with permitted directions.
Inspect both ends, including signatures, errors and data representations.
Look for cycles, imports past public surfaces, vendor types leaking inward,
and access to another context's storage. Include annotation-only edges when
the selected rule prohibits them; distinguish runtime failures from type
coupling. Record dynamic edges that static searches cannot establish.

Cite the edge, rule and consequence. Framework types in inbound adapters are
legitimate. Missing __all__ alone does not prove internal API misuse.
A port returning ORM rows or driver errors still couples its consumer.

## Responsibilities

Identify the owner of each business rule and state transition. Trace relevant
entry points and state writers, including jobs, handlers and imports.
Find duplicated rules with different owners, bypassable invariant checks,
and modules whose independent responsibilities force unrelated changes
together. Cite affected paths and explain the rightful owner.
Data-only objects are valid where no invariant requires enforcement.

Inspect representative changes or concrete change scenarios for locality.
Co-change alone is insufficient; module/test co-change is expected.
High fan-in to a stable shared kernel does not establish a god module.

## Structure

Map each file/module to its responsibility and compare placement against
the adopted layout. Inspect mixed-purpose utilities, competing homes for the
same artifact, public context surfaces and composition roots. Follow actual
responsibilities rather than inferring them from folder names. Naming aliases
such as infrastructure for adapters are valid when the contract allows them.

Report missing prescribed layers as compliance findings where applicable.
For additional reorganization recommendations, identify the ownership or
change-locality problem solved. A compliant tree does not prove correct
responsibility assignment.

## Enforcement

Inspect configured boundary checks and their scope. For adopted rules requiring
CI enforcement, establish whether a checker covers them. Passing import checks
does not prove invariant ownership. Keep manual and automated coverage explicit.
