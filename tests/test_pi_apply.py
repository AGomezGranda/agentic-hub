import json
import os
import stat
from collections.abc import Callable
from pathlib import Path

import pytest

from agentic_hub.pi_handler import runtime, service, state
from agentic_hub.pi_handler.config import PiPaths, resolve_paths

pytestmark = pytest.mark.usefixtures("isolated_pi_home")


def manifest_file(
    tmp_path: Path,
    settings: dict[str, object] | None = None,
    packages: list[str] | None = None,
) -> Path:
    path = tmp_path / "manifest.json"
    path.write_text(
        json.dumps(
            dict(
                version=1,
                packages=packages or [],
                settings=settings or {},
                required_env=[],
            )
        )
    )
    return path


def test_apply_empty_setup_has_no_side_effects(tmp_path: Path) -> None:
    manifest = manifest_file(tmp_path)
    before = sorted(tmp_path.rglob("*"))
    result = service.apply_setup(manifest)
    assert result.ok
    assert not result.changes
    assert sorted(tmp_path.rglob("*")) == before


def test_apply_is_idempotent_and_preserves_unmanaged_values(
    tmp_path: Path, isolated_pi_home: Path
) -> None:
    root = isolated_pi_home / ".pi/agent"
    root.mkdir(parents=True)
    settings = root / "settings.json"
    settings.write_text(
        json.dumps({"ui": {"private": [1, None]}, "credential": "must-not-enter-state"})
    )
    manifest = manifest_file(tmp_path, {"ui": {"theme": "synthetic"}})
    result = service.apply_setup(manifest)
    assert result.ok, result.diagnostics
    assert json.loads(settings.read_text()) == {
        "ui": {"private": [1, None], "theme": "synthetic"},
        "credential": "must-not-enter-state",
    }
    state = root / "agentic-hub/pi-state.json"
    assert "must-not-enter-state" not in state.read_text()
    before = (settings.stat().st_mtime_ns, state.read_bytes(), state.stat().st_mtime_ns)
    assert service.apply_setup(manifest).ok
    assert (
        settings.stat().st_mtime_ns,
        state.read_bytes(),
        state.stat().st_mtime_ns,
    ) == before
    assert service.inspect_setup(manifest).status == "in-sync"


def test_adopt_and_release_restore_original_presence(tmp_path: Path) -> None:
    manifest = manifest_file(
        tmp_path, {"ui": {"adopted": "original"}, "created": {"x": 1}}
    )
    paths = resolve_paths(manifest)
    paths.agent_dir.mkdir(parents=True)
    paths.settings.write_text('{"ui":{"adopted":"original"},"preexisting":{}}')
    assert service.apply_setup(manifest).ok
    manifest_file(tmp_path, {"ui": {"adopted": "updated"}, "created": {"x": 1}})
    assert service.apply_setup(manifest).ok
    manifest_file(tmp_path)
    result = service.apply_setup(manifest)
    assert result.ok, result.diagnostics
    assert json.loads(paths.settings.read_text()) == {
        "ui": {"adopted": "original"},
        "preexisting": {},
    }
    assert state.read_state(paths).manifest is None
    assert service.inspect_setup(manifest).status == "in-sync"


def test_conflict_preflight_prevents_all_mutations(tmp_path: Path) -> None:
    manifest = manifest_file(tmp_path, {"a": 1, "z": "desired"})
    paths = resolve_paths(manifest)
    paths.agent_dir.mkdir(parents=True)
    paths.settings.write_text('{"z":"private"}')
    before = paths.settings.read_bytes()
    assert not service.apply_setup(manifest).ok
    assert paths.settings.read_bytes() == before
    assert not paths.state.parent.exists()


@pytest.mark.parametrize("release", [False, True])
def test_managed_local_edits_require_manual_resolution(
    tmp_path: Path, release: bool
) -> None:
    manifest = manifest_file(tmp_path, {"x": 1})
    assert service.apply_setup(manifest).ok
    paths = resolve_paths(manifest)
    paths.settings.write_text('{"x":2}')
    if release:
        manifest_file(tmp_path)
    result = service.apply_setup(manifest)
    assert not result.ok
    assert json.loads(paths.settings.read_text()) == {"x": 2}


def test_existing_permissions_are_preserved_and_state_is_private(
    tmp_path: Path,
) -> None:
    manifest = manifest_file(tmp_path, {"x": 1})
    paths = resolve_paths(manifest)
    paths.agent_dir.mkdir(parents=True)
    paths.settings.write_text("{}")
    paths.settings.chmod(0o640)
    assert service.apply_setup(manifest).ok
    assert stat.S_IMODE(paths.settings.stat().st_mode) == 0o640
    assert stat.S_IMODE(paths.state.stat().st_mode) == 0o600


@pytest.mark.parametrize(
    "layout", ["symlink", "hardlink", "directory", "utf8", "root", "state-symlink"]
)
def test_unsafe_file_layout_is_rejected(tmp_path: Path, layout: str) -> None:
    manifest = manifest_file(tmp_path, {"x": 1})
    paths = resolve_paths(manifest)
    paths.agent_dir.parent.mkdir(parents=True)
    if layout == "root":
        paths.agent_dir.write_text("private")
    else:
        paths.agent_dir.mkdir()
        original = tmp_path / "original"
        original.write_text("{}")
        if layout == "symlink":
            paths.settings.symlink_to(original)
        elif layout == "hardlink":
            os.link(original, paths.settings)
        elif layout == "directory":
            paths.settings.mkdir()
        elif layout == "utf8":
            paths.settings.write_bytes(b"\xff")
        else:
            paths.state.parent.mkdir()
            paths.state.symlink_to(original)
    assert not service.apply_setup(manifest).ok
    assert not paths.lock.exists()


def test_missing_owned_setting_is_recreated_but_cleanup_refuses_drift(
    tmp_path: Path,
) -> None:
    manifest = manifest_file(tmp_path, {"x": 1})
    assert service.apply_setup(manifest).ok
    paths = resolve_paths(manifest)
    paths.settings.unlink()
    assert service.apply_setup(manifest).ok
    paths.settings.unlink()
    manifest_file(tmp_path)
    result = service.apply_setup(manifest)
    assert not result.ok
    assert not paths.settings.exists()
    assert state.read_state(paths).settings


def test_missing_owned_package_cleanup_requires_resolution(
    tmp_path: Path, fake_pi: Path
) -> None:
    manifest = manifest_file(tmp_path, packages=["npm:demo@1.0.0"])
    assert service.apply_setup(manifest).ok
    paths = resolve_paths(manifest)
    paths.settings.write_text("{}")
    before = (tmp_path / "pi-commands.jsonl").read_bytes()
    manifest_file(tmp_path)
    assert not service.apply_setup(manifest).ok
    assert (tmp_path / "pi-commands.jsonl").read_bytes() == before
    assert state.read_state(paths).packages


def test_dangling_agent_root_ancestor_is_not_an_empty_setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    link = tmp_path / "dangling"
    link.symlink_to(tmp_path / "nonexistent", target_is_directory=True)
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(link / "agent"))
    manifest = manifest_file(tmp_path)
    assert service.inspect_setup(manifest).status == "error"
    assert not service.apply_setup(manifest).ok
    assert not (tmp_path / "nonexistent").exists()


def test_concurrent_apply_is_rejected(tmp_path: Path) -> None:
    manifest = manifest_file(tmp_path, {"x": 1})
    paths = resolve_paths(manifest)
    lock = state.acquire_lock(paths)
    try:
        assert not service.apply_setup(manifest).ok
        assert paths.lock.exists()
        assert not paths.settings.exists()
    finally:
        lock.release()


def test_changed_snapshot_is_not_overwritten(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text("{}")
    snapshot = state.read_snapshot(path)
    path.write_text('{"private":"concurrent"}')
    with pytest.raises(ValueError, match="changed"):
        state.atomic_json(snapshot, {"x": 1})
    assert path.read_text() == '{"private":"concurrent"}'


def test_atomic_write_failure_preserves_original(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "settings.json"
    path.write_text("{}")

    def fail(*args: object) -> None:
        raise OSError("sensitive low-level message")

    monkeypatch.setattr(os, "replace", fail)
    with pytest.raises(OSError):
        state.atomic_json(state.read_snapshot(path), {"x": 1})
    assert path.read_text() == "{}"
    assert not list(tmp_path.glob(".pi-hub-*"))


def failing_replace(paths: PiPaths, stage: str = "pre") -> Callable[[Path, Path], None]:
    original = os.replace

    def interrupt(source: Path, destination: Path) -> None:
        blocked = (
            destination == paths.settings
            if stage == "pre"
            else destination == paths.state and paths.settings.exists()
        )
        if blocked:
            raise OSError("simulated interrupted persistence")
        original(source, destination)

    return interrupt


@pytest.mark.parametrize("stage", ["pre", "post"])
def test_pending_settings_write_recovers_from_pre_or_post_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str
) -> None:
    manifest = manifest_file(tmp_path, {"x": 1})
    paths = resolve_paths(manifest)
    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", failing_replace(paths, stage))
        assert not service.apply_setup(manifest).ok
    assert state.read_state(paths).pending is not None
    assert service.inspect_setup(manifest).status == "error"
    assert service.apply_setup(manifest).ok
    assert json.loads(paths.settings.read_text()) == {"x": 1}
    assert state.read_state(paths).pending is None


def test_invalid_pending_checkpoint_blocks_before_settings_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest = manifest_file(tmp_path, {"x": 1})
    paths = resolve_paths(manifest)
    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", failing_replace(paths))
        assert not service.apply_setup(manifest).ok
    data = json.loads(paths.state.read_text())
    data["pending"]["next_state"]["version"] = 2
    paths.state.write_text(json.dumps(data))
    assert not service.apply_setup(manifest).ok
    assert not paths.settings.exists()


def test_ambiguous_pending_state_blocks_recovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest = manifest_file(tmp_path, {"x": 1})
    paths = resolve_paths(manifest)
    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", failing_replace(paths))
        assert not service.apply_setup(manifest).ok
    paths.settings.write_text('{"x": 9}')
    assert not service.apply_setup(manifest).ok
    assert state.read_state(paths).pending is not None


def test_version_change_preserves_unmanaged_package_entries(
    tmp_path: Path, fake_pi: Path
) -> None:
    manifest = manifest_file(tmp_path, {"managed": True}, ["npm:demo@1.0.0"])
    paths = resolve_paths(manifest)
    paths.agent_dir.mkdir(parents=True)
    unrelated = [{"source": "git:example.com/other", "skills": []}, "./local"]
    paths.settings.write_text(
        json.dumps({"packages": unrelated, "private": {"array": [1, None]}})
    )
    result = service.apply_setup(manifest)
    assert result.ok, result.diagnostics
    manifest_file(tmp_path, {"managed": True}, ["npm:demo@2.0.0"])
    assert service.apply_setup(manifest).ok
    assert json.loads(paths.settings.read_text())["packages"] == unrelated + [
        "npm:demo@2.0.0"
    ]
    manifest_file(tmp_path)
    assert service.apply_setup(manifest).ok
    assert json.loads(paths.settings.read_text()) == {
        "packages": unrelated,
        "private": {"array": [1, None]},
    }
    commands = [
        json.loads(line)["argv"]
        for line in (tmp_path / "pi-commands.jsonl").read_text().splitlines()
    ]
    assert commands[-1] == ["remove", "npm:demo@2.0.0", "--no-approve"]


def test_package_failure_stops_after_checkpointed_success(
    tmp_path: Path, fake_pi: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest = manifest_file(
        tmp_path, {"settingAfterPackages": True}, ["npm:a@1.0.0", "npm:b@1.0.0"]
    )
    monkeypatch.setenv("HUB_FAIL_SOURCE", "npm:b")
    result = service.apply_setup(manifest)
    assert not result.ok
    assert [c.name for c in result.changes] == ["a"]
    paths = resolve_paths(manifest)
    assert json.loads(paths.settings.read_text()) == {"packages": ["npm:a@1.0.0"]}
    ownership = state.read_state(paths)
    assert [p.name for p in ownership.packages] == ["a"]
    assert ownership.pending is not None
    assert not paths.lock.exists()
    monkeypatch.delenv("HUB_FAIL_SOURCE")
    assert service.apply_setup(manifest).ok


@pytest.mark.parametrize("mode", ["no-write", "after-write-fail"])
def test_pending_package_install_is_retried_before_completion(
    tmp_path: Path, fake_pi: Path, monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    manifest = manifest_file(tmp_path, packages=["npm:demo@1.0.0"])
    monkeypatch.setenv("HUB_FAKE_MODE", mode)
    result = service.apply_setup(manifest)
    assert not result.ok
    paths = resolve_paths(manifest)
    assert state.read_state(paths).pending is not None
    monkeypatch.delenv("HUB_FAKE_MODE")
    assert service.apply_setup(manifest).ok
    assert len((tmp_path / "pi-commands.jsonl").read_text().splitlines()) == 2
    assert state.read_state(paths).pending is None


def test_completed_pending_removal_releases_without_a_subprocess(
    tmp_path: Path, fake_pi: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest = manifest_file(tmp_path, packages=["npm:demo@1.0.0"])
    assert service.apply_setup(manifest).ok
    manifest_file(tmp_path)
    monkeypatch.setenv("HUB_FAKE_MODE", "after-write-fail")
    assert not service.apply_setup(manifest).ok
    before = (tmp_path / "pi-commands.jsonl").read_bytes()
    monkeypatch.setenv("HUB_FAKE_VERSION", "1.5.0")
    assert service.apply_setup(manifest).ok
    assert (tmp_path / "pi-commands.jsonl").read_bytes() == before


@pytest.mark.parametrize(
    "reason", ["version", "platform", "migration", "number", "npm"]
)
def test_package_preflight_blocks_entire_apply_before_metadata(
    tmp_path: Path, fake_pi: Path, monkeypatch: pytest.MonkeyPatch, reason: str
) -> None:
    manifest = manifest_file(tmp_path, {"new": 1}, ["npm:demo@1.0.0"])
    paths = resolve_paths(manifest)
    if reason == "version":
        monkeypatch.setenv("HUB_FAKE_VERSION", "1.5.0")
    elif reason == "platform":
        monkeypatch.setattr(runtime, "process_control_supported", lambda: False)
    elif reason == "npm":
        (fake_pi.parent / "npm").unlink()
    else:
        paths.agent_dir.mkdir(parents=True)
        paths.settings.write_text(
            json.dumps(
                {"queueMode": "all"}
                if reason == "migration"
                else {"counter": 9007199254740993}
            )
        )
    before = paths.settings.read_bytes() if paths.settings.exists() else None
    assert not service.apply_setup(manifest).ok
    assert not paths.state.parent.exists()
    assert not (tmp_path / "pi-commands.jsonl").exists()
    assert (paths.settings.read_bytes() if paths.settings.exists() else None) == before


@pytest.mark.parametrize("mode", ["unrelated", "corrupt"])
def test_unexpected_upstream_write_requires_persistent_manual_repair(
    tmp_path: Path, fake_pi: Path, monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    manifest = manifest_file(tmp_path, packages=["npm:demo@1.0.0"])
    monkeypatch.setenv("HUB_FAKE_MODE", mode)
    assert not service.apply_setup(manifest).ok
    paths = resolve_paths(manifest)
    ownership = state.read_state(paths)
    assert ownership.pending is not None and ownership.repair
    assert "unexpected sensitive change" not in paths.state.read_text()
    if mode == "corrupt":
        paths.settings.write_text('{"packages":["npm:demo@1.0.0"]}')
    monkeypatch.delenv("HUB_FAKE_MODE")
    before = (tmp_path / "pi-commands.jsonl").read_bytes()
    assert not service.apply_setup(manifest).ok
    assert (tmp_path / "pi-commands.jsonl").read_bytes() == before


def test_adopted_package_release_and_setting_only_apply_need_no_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest = manifest_file(tmp_path, {"managed": 1}, ["npm:demo@1.0.0"])
    paths = resolve_paths(manifest)
    paths.agent_dir.mkdir(parents=True)
    paths.settings.write_text(
        '{"packages":["npm:demo@1.0.0"],"queueMode":"all","big":9007199254740993}'
    )

    def forbidden() -> Path:
        pytest.fail("no package mutation should resolve Pi")

    monkeypatch.setattr(runtime, "resolve_launcher", forbidden)
    assert service.apply_setup(manifest).ok
    manifest_file(tmp_path)
    assert service.apply_setup(manifest).ok
    assert json.loads(paths.settings.read_text()) == {
        "packages": ["npm:demo@1.0.0"],
        "queueMode": "all",
        "big": 9007199254740993,
    }


def test_release_relinquishes_container_tracking_with_unmanaged_siblings(
    tmp_path: Path,
) -> None:
    manifest = manifest_file(tmp_path, {"ui": {"managed": 1}})
    assert service.apply_setup(manifest).ok
    paths = resolve_paths(manifest)
    paths.settings.write_text('{"ui":{"managed":1,"local":true}}')
    manifest_file(tmp_path)
    assert service.apply_setup(manifest).ok
    assert json.loads(paths.settings.read_text()) == {"ui": {"local": True}}
    assert state.read_state(paths).containers == []


def test_invalid_package_ownership_never_authorizes_mutation(tmp_path: Path) -> None:
    manifest = manifest_file(tmp_path)
    paths = resolve_paths(manifest)
    paths.state.parent.mkdir(parents=True)
    data = state.encode_state(state.OwnershipState(manifest.resolve()))
    data["packages"] = [{"name": None, "source": "npm:demo@latest", "introduced": True}]
    paths.state.write_text(json.dumps(data))
    assert service.inspect_setup(manifest).status == "error"
    assert not service.apply_setup(manifest).ok


def test_missing_state_never_authorizes_removal(tmp_path: Path) -> None:
    manifest = manifest_file(tmp_path, {"x": 1})
    paths = resolve_paths(manifest)
    assert service.apply_setup(manifest).ok
    paths.state.unlink()
    manifest_file(tmp_path)
    assert service.apply_setup(manifest).ok
    assert json.loads(paths.settings.read_text()) == {"x": 1}
