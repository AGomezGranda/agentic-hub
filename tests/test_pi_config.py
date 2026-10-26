import json
from pathlib import Path

import pytest

from agentic_hub.pi_handler import config
from agentic_hub.pi_handler.config import flatten_settings, load_manifest, resolve_paths


def test_empty_manifest_is_valid(tmp_path: Path) -> None:
    path = tmp_path / "manifest.json"
    path.write_text(
        json.dumps({"version": 1, "packages": [], "settings": {}, "required_env": []})
    )
    manifest = load_manifest(path)
    assert manifest.path == path.resolve()
    assert manifest.packages == ()
    assert manifest.settings == {}
    assert manifest.required_env == ()


def manifest_file(tmp_path: Path, **fields: object) -> Path:
    path = tmp_path / "manifest.json"
    path.write_text(
        json.dumps(dict(version=1, packages=[], settings={}, required_env=[]) | fields)
    )
    return path


def test_default_manifest_is_independent_of_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert load_manifest().path == config.DEFAULT_MANIFEST


def test_explicit_manifest_resolves_from_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = manifest_file(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert load_manifest(Path("manifest.json")).path == path


@pytest.mark.parametrize("override", [None, "", "relative", "~/elsewhere"])
def test_agent_root_override_resolution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, override: str | None
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("PI_CODING_AGENT_DIR", raising=False)
    if override is not None:
        monkeypatch.setenv("PI_CODING_AGENT_DIR", override)
    expected = tmp_path / (
        "elsewhere" if override == "~/elsewhere" else override or ".pi/agent"
    )
    paths = resolve_paths(tmp_path / "manifest.json")
    assert paths.agent_dir == expected
    assert paths.settings == expected / "settings.json"
    assert paths.state == expected / "agentic-hub/pi-state.json"
    assert paths.lock == expected / "agentic-hub/apply.lock"
    assert not expected.exists() if override else not (tmp_path / ".pi").exists()


def test_missing_manifest_is_not_empty_setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config, "DEFAULT_MANIFEST", tmp_path / "missing")
    with pytest.raises(ValueError, match="editable checkout"):
        load_manifest()


@pytest.mark.parametrize(
    "fields",
    [
        {"version": 2},
        {"version": True},
        {"unknown": 1},
        {"packages": {}},
        {"settings": []},
        {"required_env": "TOKEN"},
        {"required_env": ["A", "A"]},
        {"required_env": ["NOT-ENV"]},
        {"required_env": [3]},
        {"settings": {"x": {}}},
        {"settings": {"packages": []}},
        {"settings": {"$schema": "secret"}},
        {"settings": {"x": float("nan")}},
        {"settings": {"x": float("inf")}},
    ],
)
def test_manifest_rejects_invalid_structure(
    tmp_path: Path, fields: dict[str, object]
) -> None:
    with pytest.raises(ValueError):
        load_manifest(manifest_file(tmp_path, **fields))


@pytest.mark.parametrize(
    "text",
    [
        '{"version":1,"version":1,"packages":[],"settings":{},"required_env":[]}',
        "{}",
        "[]",
        "{",
        '{"version":1,"packages":[],"settings":{"a":1,"a":2},"required_env":[]}',
    ],
)
def test_manifest_rejects_invalid_json(tmp_path: Path, text: str) -> None:
    path = tmp_path / "manifest.json"
    path.write_text(text)
    with pytest.raises(ValueError):
        load_manifest(path)


@pytest.mark.parametrize(
    "packages",
    [
        ["npm:demo"],
        ["npm:demo@latest"],
        ["npm:demo@^1.2.3"],
        ["npm:demo@1.2"],
        ["npm:demo@01.2.3"],
        ["npm:demo@1.2.3-01"],
        ["npm:Demo@1.2.3"],
        ["npm:@scope/pkg/other@1.2.3"],
        ["npm:.demo@1.2.3"],
        ["git:github.com/demo/repo@v1"],
        ["./local"],
        [{"source": "npm:demo@1.2.3"}],
        ["npm:demo@1.2.3", "npm:demo@2.0.0"],
    ],
)
def test_packages_require_unique_exact_npm_versions(
    tmp_path: Path, packages: list[object]
) -> None:
    with pytest.raises(ValueError):
        load_manifest(manifest_file(tmp_path, packages=packages))


def test_exact_scoped_and_unscoped_packages(tmp_path: Path) -> None:
    packages = ["npm:demo@1.2.3", "npm:@scope/tools@0.0.1-alpha.1+build.01"]
    assert load_manifest(manifest_file(tmp_path, packages=packages)).packages == tuple(
        packages
    )


def test_settings_flattening_preserves_arrays_and_null() -> None:
    assert flatten_settings(
        {"ui": {"array": [1, {"x": 2}], "null": None}, "scalar": True}
    ) == {
        ("ui", "array"): [1, {"x": 2}],
        ("ui", "null"): None,
        ("scalar",): True,
    }
