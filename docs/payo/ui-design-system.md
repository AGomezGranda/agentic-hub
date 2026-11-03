# Payo tactical UI

The web console is dark by default, independent of OS theme. The visual direction is an understated operations console: graphite surfaces, amber interaction cues, precise borders, and minimal decoration.

## Foundations

Tokens live in `payo/apps/web/src/app/styles.css`. Use semantic variables rather than literal colors in components.

| Role | Token | Usage |
| --- | --- | --- |
| Canvas | `--canvas` | Page and recessed input backgrounds |
| Surface | `--surface` | Navigation, panels, readable documents |
| Raised surface | `--surface-raised` | Hover states and neutral callouts |
| Text | `--ink`, `--muted` | Primary content and secondary metadata |
| Boundary | `--line` | Dividers and panel borders |
| Interaction | `--accent`, `--accent-strong`, `--accent-ink` | Amber actions, hover, and dark text on amber |
| Selection | `--accent-surface` | Selected rows and navigation |
| Success | `--status-good`, `--success-surface` | Healthy connections and active work |
| Warning | `--status-warn`, `--warning-surface`, `--warning-border` | Attention and review caveats |
| Error | `--danger`, `--danger-surface`, `--danger-border` | Failures and denied actions |

Use system sans-serif for content and `--mono` for operational labels, timestamps, and code. Keep long plan text in sentence case and comfortably spaced. Reserve uppercase tracking for short labels.

## Components

- `console-header`: full-width brand strip with an amber top rule.
- `console-main`: subtle dot-grid workspace background.
- `console-intro`: left-rule page heading treatment.
- `console-panel`: solid, bordered setup panel with a small amber edge marker.
- `console-nav-link`: navigation with an amber left edge for the current page.
- `console-eyebrow`: monospace operational label.
- `console-footer`: compact local-session metadata; not a server-health indicator.
- Shared `Button`: existing primary, secondary, and quiet variants consume the theme tokens.

## Guardrails

Keep status text alongside color cues. Retain visible keyboard focus, labeled inputs, native dark controls, reduced-motion support, and responsive layouts. Do not use decorative live indicators to imply a connection that has not been verified. Avoid glow, animated scanning effects, and external font dependencies.
