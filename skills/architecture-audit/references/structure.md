# Structure — is the code where a newcomer would look for it?

Check procedure: classify the scope (standard.md, Applicability), then
compare the directory tree against the target layout (standard.md, S1–S6).
The existing layout is the subject of the audit; never adopt it as the
target because it is consistent. Evidence needed: the tree excerpt
(`find <src> -type d` to depth 4, with file counts), the rule ID it breaks,
and a concrete change scenario: which folders a typical feature change must
touch today versus under the target layout. The co-change table backs this
with real commits.

Check, in order:

1. **Organising axis** (S1, S2): does the top level name bounded contexts
   or features, or technical layers? Does each context have its own
   domain, application and adapters?
2. **Domain visibility**: is there a domain layer at all where invariants
   exist? Business rules spread across handlers and ORM models with no
   `domain/` is a structure finding *and* a responsibilities finding. File
   it once, under responsibilities, and reference it here.
3. **Junk drawers** (S3): `utils`, `helpers`, `common`, `core`, `misc`.
   List what each holds and which context owns each item.
4. **Placement drift** (S4): the same kind of artefact in two places
   (`schemas.py` in some features, `api/models/` in others; settings read
   in three modules).
5. **Public surface** (S5): does each context expose a package-root API,
   and do other contexts import through it?
6. **Composition root** (D2): one discoverable place per process where
   the graph is wired, versus clients built at import time across modules.
7. **Test layout**: tests mirror `src/` and are split by level, so the
   level and owner of a test is obvious from its path.

## Layer-first layout

```text
# ❌ a "change refund rules" ticket edits four top-level folders
src/app/models/{payment,refund,customer}.py
src/app/services/{payment,refund,customer}_service.py
src/app/repositories/{payment,refund,customer}_repo.py
src/app/api/{payment,refund,customer}.py

# ✅ the ticket stays inside one context
src/app/refunds/{domain,application,adapters}/
src/app/payments/{domain,application,adapters}/
```
Consequence: no folder owns "refunds", reviewers can't see a context's
surface, and cross-feature imports look local. Correction: move per
context, one context per PR, starting with the highest-churn one.

## Junk drawer

```text
src/app/utils/
  money.py      # Money rounding: pricing owns it, or shared_kernel
  s3.py         # S3 client: adapters/storage of the context that uses it
  refunds.py    # refund eligibility rule: refunds/domain
```
Consequence: business rules hide where nobody looks, and `utils` becomes a
fan-in hub every feature edits. Correction: move each item to its owner.
Keep only genuinely context-free, low-churn primitives in `shared_kernel`.

## Non-findings

- A single-context service with `domain/`, `application/`, `adapters/` at
  the top level and no `<context>/` folder (S1 allows it).
- A small, stable `shared_kernel` with high fan-in and low churn.
- A script or CLI tool with flat modules and no domain rules, classified as
  such with evidence.
- Naming that differs from the S1 example (`infrastructure/` for
  `adapters/`, `use_cases/` for `application/`) but keeps the same split
  and dependency direction.

Severity: per the Severity section of `standard.md`, the single source.
