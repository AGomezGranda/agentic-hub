# Review evidence and completion

Record the source state, scope and governing rules. Inventory relevant modules,
interfaces, behaviors or plan requirements before judging. Track each applicable
check as checked (with evidence), not applicable (with reason), or unverified
(with next probe). Disclose sampling; it does not establish full coverage.

Investigate candidates against original source, callers, tests and configuration.
Look for counterevidence and read enough context to establish the contract.
A matching quotation or another agent's summary is insufficient. Expand reads
when necessary, without compulsory whole-file rereads. Separate confirmed,
rejected and unresolved candidates. Only confirmed findings enter the defect
list; unresolved concerns retain their missing evidence and next probe.

Each finding includes a stable ID, severity, confidence, location, evidence,
violated contract, concrete consequence, and smallest sufficient correction.
Explain material counterevidence considered. Group instances of the same root
cause with representative locations and affected scope; keep distinct causes
separate. Do not cap valid findings or invent findings to fill categories.
Repository prevalence establishes scope, not correctness.

Severity: P0 is a critical failure requiring immediate action; P1 requires
correction before proceeding with the affected change; P2 is a material,
nonblocking improvement. Apply explicit severity rules of the selected
architecture standard where present. Confidence in a rule violation and
confidence in its consequences are separate judgments. Preferences without
a governing rule or demonstrated consequence are not defects.

Report findings by severity, then consequence/confidence, followed by coverage
and unresolved concerns. Use the caller's output contract when supplied;
otherwise concise Markdown is sufficient. No mandatory index or strengths
quota. With no findings, state what was checked and the evidence supporting
that bounded conclusion.

An audit is complete only when every applicable check in the declared scope
is covered. Fixing reported findings does not complete uncovered work. Required
unverified areas make a report incomplete, never clean. If limits prevent
completion, report remaining work. A failed or malformed child result is an
investigation failure with uncovered scope, never a defect in the code.

On a subsequent pass, compare scope, source state and prior findings. Classify
new findings as previously missed, introduced by fixes, newly exposed, or changed
scope/standard. Recheck fixes and affected callers or boundaries; do not silently
broaden the audit. Review is read-only unless fixes are separately authorized.
