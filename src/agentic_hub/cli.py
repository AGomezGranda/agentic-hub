#!/usr/bin/env python3
"""agentic-hub: install markdown skills into multiple AI agents from one source."""

import argparse
import logging
import sys
from pathlib import Path

from . import agents, catalog

# Progress/diagnostics go to stderr via logging; stdout stays clean for data
# (the `list` output) so it can be piped.
log = logging.getLogger("agentic-hub")


def resolve_agents(arg: str | None) -> list[str]:
    """Parse a comma-separated --agent value, defaulting to all known agents."""
    if not arg:
        return list(agents.AGENTS)
    names = [a.strip() for a in arg.split(",") if a.strip()]
    for a in names:
        if a not in agents.AGENTS:
            sys.exit(f"unknown agent: {a} (choices: {', '.join(agents.AGENTS)})")
    return names


def pick_interactive() -> list[str]:
    """Prompt the user to pick skills by number when none were given on the CLI."""
    skills = catalog.discover_skills()
    if not skills:
        sys.exit("no skills found in " + str(catalog.SKILLS_DIR))
    for i, name in enumerate(skills, 1):
        print(f"{i}) {name}")
    choice = input("install which? (numbers, space/comma-separated): ")
    try:
        idxs = [int(x) for x in choice.replace(",", " ").split()]
        return [skills[i - 1] for i in idxs]
    except (ValueError, IndexError):
        sys.exit("invalid selection")


def cmd_list(args: argparse.Namespace) -> None:
    skills = catalog.discover_skills()
    if not skills:
        print("no skills found in", catalog.SKILLS_DIR)
        return
    for name in skills:
        print(name)
        for agent in agents.AGENTS:
            print(f"  {agent:10s} {agents.status(agent, name)}")


def report(verb: str, done: int, total: int) -> None:
    """Log a one-line summary of how many actions out of the total succeeded."""
    log.info("%s %d/%d", verb, done, total)


def cmd_install(args: argparse.Namespace) -> None:
    names = args.skills or pick_interactive()
    agent_names = resolve_agents(args.agent)
    known = catalog.discover_skills()
    log.debug("installing %s to %s", ", ".join(names), ", ".join(agent_names))
    done = attempted = 0
    for name in names:
        if name not in known:
            log.warning("skip: unknown skill '%s'", name)
            continue
        for agent in agent_names:
            attempted += 1
            done += agents.install_one(agent, name)
    report("installed", done, attempted)


def cmd_remove(args: argparse.Namespace) -> None:
    agent_names = resolve_agents(args.agent)
    done = attempted = 0
    for name in args.skills:
        if name != Path(name).name:
            log.warning("skip: invalid skill name '%s'", name)
            continue
        for agent in agent_names:
            attempted += 1
            done += agents.remove_one(agent, name)
    report("removed", done, attempted)


def cmd_sync(args: argparse.Namespace) -> None:
    skills = catalog.discover_skills()
    log.debug("syncing %d skill(s) to %d agent(s)", len(skills), len(agents.AGENTS))
    done = attempted = 0
    for name in skills:
        for agent in agents.AGENTS:
            attempted += 1
            done += agents.install_one(agent, name)
    report("synced", done, attempted)


def cmd_tui(args: argparse.Namespace) -> None:
    # lazy: scripting subcommands shouldn't pay textual's import cost
    from . import tui  # noqa: PLC0415

    tui.run()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="agentic-hub")
    p.add_argument(
        "-v", "--verbose", action="store_true", help="log skipped no-ops too"
    )
    p.add_argument(
        "-q", "--quiet", action="store_true", help="warnings and errors only"
    )
    p.set_defaults(func=cmd_tui)  # bare `agentic-hub` -> TUI
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("list").set_defaults(func=cmd_list)

    p_install = sub.add_parser("install")
    p_install.add_argument("skills", nargs="*")
    p_install.add_argument("--agent", help="comma-separated agent names (default: all)")
    p_install.set_defaults(func=cmd_install)

    p_remove = sub.add_parser("remove")
    p_remove.add_argument("skills", nargs="+")
    p_remove.add_argument("--agent", help="comma-separated agent names (default: all)")
    p_remove.set_defaults(func=cmd_remove)

    sub.add_parser("sync").set_defaults(func=cmd_sync)
    sub.add_parser("tui").set_defaults(func=cmd_tui)
    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    level = (
        logging.DEBUG
        if args.verbose
        else logging.WARNING
        if args.quiet
        else logging.INFO
    )
    logging.basicConfig(level=level, format="%(message)s", stream=sys.stderr)
    args.func(args)


if __name__ == "__main__":
    main()
