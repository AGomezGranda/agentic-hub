import json
from pathlib import Path
from typing import cast

import pytest

from agentic_hub.pi_handler.config import JSON, Manifest
from agentic_hub.pi_handler.planner import build_plan, delegated_write_issues, equal
from agentic_hub.pi_handler.state import (
    ObservedSettings,
    OwnershipState,
    PackageOwnership,
    SettingOwnership,
    Value,
)


def test_version_grounded_persistence_contract() -> None:
    fixture = json.loads(
        (Path(__file__).parent / "fixtures/pi-1.4.0-persistence.json").read_text()
    )
    assert fixture["provenance"]["version"] == "1.4.0"
    for case in fixture["cases"]:
        observed = cast(dict[str, JSON], case["input"])
        output = cast(dict[str, JSON], case["output"])
        issues = delegated_write_issues(observed)
        assert len(issues) == len(case["blocked_paths"]), case["name"]
        for path in case["blocked_paths"]:
            assert any(path in issue for issue in issues), case["name"]
        if not issues:
            assert equal(
                {k: v for k, v in observed.items() if k != "packages"},
                {k: v for k, v in output.items() if k != "packages"},
            ), case["name"]


def test_empty_setup_has_no_changes(tmp_path: Path) -> None:
    manifest = Manifest(tmp_path / "manifest.json", (), {}, ())
    plan = build_plan(manifest, ObservedSettings(), OwnershipState())
    assert plan.status == "in-sync"
    assert plan.changes == []
    assert not plan.conflicts


def desired(
    tmp_path: Path,
    settings: dict[str, JSON] | None = None,
    packages: tuple[str, ...] = (),
) -> Manifest:
    return Manifest(tmp_path / "manifest.json", packages, settings or {}, ())


def test_unmanaged_siblings_survive_nested_setting_plan(tmp_path: Path) -> None:
    observed = ObservedSettings({"ui": {"private": "do-not-copy"}})
    plan = build_plan(
        desired(tmp_path, {"ui": {"theme": "light"}}), observed, OwnershipState()
    )
    assert [(c.action, c.path) for c in plan.changes] == [("create", ("ui", "theme"))]
    assert observed.data == {"ui": {"private": "do-not-copy"}}


@pytest.mark.parametrize(
    "observed", [{"theme": "other"}, {"theme": {}}, {"theme": False}]
)
def test_unowned_different_value_is_conflict(
    tmp_path: Path, observed: dict[str, JSON]
) -> None:
    assert (
        build_plan(
            desired(tmp_path, {"theme": 0}),
            ObservedSettings(observed),
            OwnershipState(),
        ).status
        == "conflict"
    )


def test_equal_existing_values_are_adopted(tmp_path: Path) -> None:
    plan = build_plan(
        desired(tmp_path, {"theme": "light"}, ("npm:demo@1.0.0",)),
        ObservedSettings({"theme": "light", "packages": ["npm:demo@1.0.0"]}),
        OwnershipState(),
    )
    assert [c.action for c in plan.changes] == ["adopt", "adopt"]
    assert not plan.package_commands


@pytest.mark.parametrize("cleanup", [False, True])
def test_owned_drift_blocks_updates_and_cleanup(tmp_path: Path, cleanup: bool) -> None:
    state = OwnershipState(
        settings=[SettingOwnership(("theme",), "light")],
        packages=[PackageOwnership("demo", "npm:demo@1.0.0")],
    )
    manifest = (
        desired(tmp_path)
        if cleanup
        else desired(tmp_path, {"theme": "new"}, ("npm:demo@2.0.0",))
    )
    plan = build_plan(
        manifest,
        ObservedSettings({"theme": "edited", "packages": ["npm:demo@3.0.0"]}),
        state,
    )
    assert len(plan.conflicts) == 2


def test_release_restores_original_or_removes_introduced_leaf(tmp_path: Path) -> None:
    state = OwnershipState(
        settings=[
            SettingOwnership(("a",), 1, Value(True, 1), "adopted"),
            SettingOwnership(("b",), 2),
        ]
    )
    plan = build_plan(desired(tmp_path), ObservedSettings({"a": 1, "b": 2}), state)
    assert [(c.action, c.after) for c in plan.changes] == [
        ("restore", Value(True, 1)),
        ("remove", Value()),
    ]


def test_only_introduced_empty_containers_are_pruned(tmp_path: Path) -> None:
    state = OwnershipState(
        settings=[SettingOwnership(("ui", "x"), 1)], containers=[("ui",)]
    )
    plan = build_plan(desired(tmp_path), ObservedSettings({"ui": {"x": 1}}), state)
    assert plan.changes[0].prune == (("ui",),)
    state.containers.clear()
    assert (
        not build_plan(desired(tmp_path), ObservedSettings({"ui": {"x": 1}}), state)
        .changes[0]
        .prune
    )


def test_adopted_package_release_preserves_package(tmp_path: Path) -> None:
    state = OwnershipState(packages=[PackageOwnership("demo", "npm:demo@1.0.0", False)])
    plan = build_plan(
        desired(tmp_path), ObservedSettings({"packages": ["npm:demo@1.0.0"]}), state
    )
    assert plan.changes[0].action == "release"
    assert not plan.package_commands
    assert (
        build_plan(
            desired(tmp_path, packages=("npm:demo@2.0.0",)),
            ObservedSettings({"packages": ["npm:demo@1.0.0"]}),
            state,
        ).status
        == "conflict"
    )


@pytest.mark.parametrize(
    "entries",
    [
        [{"source": "npm:demo@1.0.0", "skills": []}],
        ["npm:demo@other"],
        ["npm:demo@1.0.0", "npm:demo@1.0.0"],
    ],
)
def test_package_identity_conflicts_include_filtered_entries(
    tmp_path: Path, entries: list[JSON]
) -> None:
    assert (
        build_plan(
            desired(tmp_path, packages=("npm:demo@1.0.0",)),
            ObservedSettings({"packages": entries}),
            OwnershipState(),
        ).status
        == "conflict"
    )


def test_foreign_manifest_state_blocks_takeover(tmp_path: Path) -> None:
    state = OwnershipState(
        tmp_path / "old.json", settings=[SettingOwnership(("x",), 1)]
    )
    assert build_plan(desired(tmp_path), ObservedSettings(), state).status == "conflict"


@pytest.mark.parametrize(
    "data, path",
    [
        ({"queueMode": "all"}, "queueMode"),
        ({"websockets": False}, "websockets"),
        ({"skills": {"customDirectories": []}}, "skills"),
        ({"retry": {"maxDelayMs": "even-not-a-number"}}, "retry.maxDelayMs"),
        ({"counter": 9007199254740992}, "counter"),
        ({"counter": -9007199254740992}, "counter"),
        ({"nested": [9007199254740993]}, "nested.0"),
    ],
)
def test_package_writes_block_incompatible_settings_only_when_delegated(
    tmp_path: Path, data: dict[str, JSON], path: str
) -> None:
    plan = build_plan(
        desired(tmp_path, packages=("npm:demo@1.0.0",)),
        ObservedSettings(data),
        OwnershipState(),
    )
    assert any(path in conflict for conflict in plan.conflicts)
    assert not build_plan(
        desired(tmp_path, {"new": 1}), ObservedSettings(data), OwnershipState()
    ).conflicts
    adopted = dict(data, packages=["npm:demo@1.0.0"])
    assert not build_plan(
        desired(tmp_path, packages=("npm:demo@1.0.0",)),
        ObservedSettings(adopted),
        OwnershipState(),
    ).conflicts
    state = OwnershipState(packages=[PackageOwnership("demo", "npm:demo@1.0.0", False)])
    assert not build_plan(desired(tmp_path), ObservedSettings(adopted), state).conflicts


def test_inactive_migrations_and_safe_numbers_are_allowed(tmp_path: Path) -> None:
    data: dict[str, JSON] = {
        "queueMode": "all",
        "steeringMode": "all",
        "websockets": True,
        "transport": "sse",
        "safe": [9007199254740991, -9007199254740991, 0.25],
    }
    assert not build_plan(
        desired(tmp_path, packages=("npm:demo@1.0.0",)),
        ObservedSettings(data),
        OwnershipState(),
    ).conflicts
