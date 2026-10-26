---
name: mucho-texto
description: Create a visual, mid-length summary of an existing plan, research report, RFC, or technical document while preserving the original. Use when the user wants the main point, changes, and tradeoffs explained quickly. Not a substitute for creating, reviewing, or implementing the source document.
---

# Mucho Texto

Create a separate summary the reader can follow in a few minutes.
Explain the main point, how it works, what matters, and what needs a decision. Keep the
source unchanged as the implementation and evidence reference.

## Read and preserve

Read the whole source, including tables and appendices. Read linked material
when a claim depends on it; do not expand this into new research. If the source
is missing, ask for it. If only part is accessible, label the output partial
and state what could not be read.

Use the requested audience and language; otherwise match the source language
and write for a colleague who knows the field but has not read the document.
When paired with a planning or research workflow, produce the companion after
the source is written. Do not weaken that workflow's requirements or alter its
approval status.

## Summarize with room to explain

Default to 200–300 lines of Markdown, including tables, diagrams, and blank
lines; use fewer for a short source. Treat this as a target, not a quota. Follow a requested
length instead. Exceed the target only to preserve decision-critical meaning,
and briefly explain why. Do not add an appendix to hide extra prose.

Use this reading path, merging or omitting parts that add no value:

1. **Main point:** a short paragraph on the problem, context, and proposed
   outcome or research finding.
2. **How it works / what we found:** one or more visuals, each followed by
   short prose or bullets for facts the visual cannot convey. Walk through
   the main parts of the source in order, with a short section for each.
3. **Alternatives and rationale:** options considered, why the chosen
   approach won, and its main tradeoff.
4. **Risks and open questions:** material risks, blockers, assumptions, and
   conflicting evidence.
5. **What proves success / next decisions:** success criteria, validation,
   and the decisions the reader must make.

Group ideas by importance, but cover every major source section with enough
detail that the reader does not need the source to follow the argument. Keep conditions that could change the reader's
decision inline. Link to exact source sections for file lists, commands,
interfaces, test matrices, detailed phase steps, and supporting evidence.
Mention delivery order only when it explains a dependency or decision.

Use concrete words, short paragraphs, and one idea per bullet. Keep essential
technical names, but omit incidental implementation names. No repeated
summary, exhaustive checklist, or prose that restates a table or diagram.

## Use visuals to save reading

Prefer a few small visuals when they make the explanation quicker:

- **Flow or dependency:** a Mermaid diagram with roughly 3–7 nodes.
- **Behavior change:** a compact before/after table.
- **Alternatives:** a small table showing the meaningful differences.

Each visual replaces prose. Use short, readable labels and only relationships
supported by the source. Label proposed behavior and uncertainty when relevant;
do not turn a tentative relationship into a definite arrow. Avoid decorative
graphics, dense architecture maps, and tables containing paragraphs. If a
sentence explains the idea faster, skip the visual. If Mermaid is unsupported
in the requested format, use a simple text flow or table instead.

## Check meaning before saving

Check every claim and visual against the source. Preserve decision-critical
conditions, numbers, units, negation, scope, and obligation. Keep proposals,
accepted decisions, observations, and assumptions distinct. Retain material
uncertainty, conflicting evidence, and research limits; do not invent rationale
or turn findings into recommendations.

Read the summary alone: can the reader explain the main point, why it matters,
the tradeoff, and the next decision or success condition? Restore missing
meaning, then cut duplication. This checks fidelity, not source correctness.

Save beside the source as `<stem>.summary.md`, unless the user specifies a path
or format. Do not overwrite the source or an unrelated existing file. Update
an existing companion only when the request is to refresh it; otherwise use
a distinct name. Include a source link, its available date/version, and the
companion's creation date. Do not invent a version. Identify multiple sources
separately and keep references traceable. Preserve valid links after moving text.

Return the companion link and a brief note about any source gaps. Do not paste
the document into chat or deliver the working checklist unless requested.

## Basis

These principles are already incorporated; browsing is not required to use them.

- [ASD-STE100](https://www.asd-ste100.org/): borrow clear sentence structure
  and consistent terminology. This skill does not enforce the controlled
  dictionary or claim STE compliance.
- [Plain-language principles](https://www.archives.gov/open/plain-writing/10-principles.html):
  reader needs, main point first, concrete language, and useful organization.
- [Diátaxis explanation](https://diataxis.fr/explanation/): make reasons and
  context understandable, while keeping detailed reference material accessible.
