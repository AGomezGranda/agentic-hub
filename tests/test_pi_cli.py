import json
import subprocess
from pathlib import Path

import pytest

from agentic_hub import cli
from agentic_hub.pi_handler import bump, runtime, service

pytestmark = pytest.mark.usefixtures("isolated_pi_home")


def manifest_file(
    tmp_path: Path,
    settings: dict[str, object] | None = None,
    required_env: list[str] | None = None,
) -> Path:
    path = tmp_path / "manifest.json"
    path.write_text(
        json.dumps(
            dict(
                version=1,
                packages=[],
                settings=settings or {},
                required_env=required_env or [],
            )
        )
    )
    return path


def snapshot(root: Path) -> dict[Path, bytes | None]:
    return {p: p.read_bytes() if p.is_file() else None for p in root.rglob("*")}


def test_pi_help_documents_subcommands_and_manifest_override(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc:
        cli.main(["pi", "--help"])
    assert exc.value.code == 0
    output = capsys.readouterr().out
    for command in ("status", "doctor", "apply", "bump"):
        assert command in output
        with pytest.raises(SystemExit) as exc:
            cli.main(["pi", command, "--help"])
        assert exc.value.code == 0
        assert "--manifest" in capsys.readouterr().out


def test_isolated_apply_status_release_round_trip(
    tmp_path: Path, fake_pi: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    manifest = manifest_file(tmp_path, {"synthetic": True})
    document = json.loads(manifest.read_text())
    document["packages"] = ["npm:demo@1.0.0"]
    manifest.write_text(json.dumps(document))
    cli.main(["pi", "apply", "--manifest", str(manifest)])
    cli.main(["pi", "status", "--manifest", str(manifest)])
    assert "in-sync" in capsys.readouterr().out
    manifest_file(tmp_path)
    cli.main(["pi", "apply", "--manifest", str(manifest)])
    cli.main(["pi", "status", "--manifest", str(manifest)])
    assert "in-sync" in capsys.readouterr().out


def test_status_and_dry_run_are_read_only(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    manifest = manifest_file(tmp_path, {"example": {"leaf": "never-print-this"}})
    before = snapshot(tmp_path)
    for args in (["status"], ["apply", "--dry-run"]):
        cli.main(["pi", *args, "--manifest", str(manifest)])
        output = capsys.readouterr()
        assert "pending" in output.out and "create setting example.leaf" in output.out
        assert "settings.json" in output.out
        assert "never-print-this" not in output.out + output.err
        assert snapshot(tmp_path) == before


def test_preview_does_not_resolve_or_run_pi(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest = manifest_file(tmp_path)

    def forbidden(*args: object, **kwargs: object) -> None:
        pytest.fail("preview resolved or ran Pi")

    monkeypatch.setattr(runtime, "resolve_launcher", forbidden)
    monkeypatch.setattr(subprocess, "run", forbidden)
    cli.main(["pi", "status", "--manifest", str(manifest)])
    cli.main(["pi", "apply", "--dry-run", "--manifest", str(manifest)])


def test_status_reports_declared_not_runtime_state(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cli.main(["pi", "status", "--manifest", str(manifest_file(tmp_path))])
    assert "declarations" in capsys.readouterr().out


@pytest.mark.parametrize(
    "args, code",
    [
        (["status", "--bad"], 2),
        ([], 2),
        (["status", "--manifest", "/missing"], 1),
        (["apply", "--manifest", "/missing"], 1),
    ],
)
def test_pi_commands_use_documented_exit_codes(args: list[str], code: int) -> None:
    with pytest.raises(SystemExit) as exc:
        cli.main(["pi", *args])
    assert exc.value.code == code


def test_diagnostics_never_print_settings_values(
    tmp_path: Path, isolated_pi_home: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    manifest = manifest_file(tmp_path, {"theme": "desired-secret"})
    root = isolated_pi_home / ".pi/agent"
    root.mkdir(parents=True)
    (root / "settings.json").write_text('{"theme":"local-secret"}')
    with pytest.raises(SystemExit) as exc:
        cli.main(["pi", "status", "--manifest", str(manifest)])
    assert exc.value.code == 1
    output = capsys.readouterr()
    assert "conflict" in output.out and "theme" in output.err
    assert "secret" not in output.out + output.err


@pytest.mark.parametrize(
    "version, ok, detail",
    [
        ("1.3.9", False, "older"),
        ("1.4.0", True, "1.4.0"),
        ("1.5.0", True, "unverified"),
        ("nonsense", False, "version"),
    ],
)
def test_doctor_versions_and_only_version_probe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    version: str,
    ok: bool,
    detail: str,
) -> None:
    launcher = Path.home() / ".pi/agent/bin/pi"
    launcher.parent.mkdir(parents=True)
    launcher.write_text("fake")
    launcher.chmod(0o700)
    calls = []

    def probe(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, version, "")

    monkeypatch.setattr(subprocess, "run", probe)
    manifest = manifest_file(tmp_path)
    before = snapshot(tmp_path)
    checks = service.doctor(manifest)
    version_check = next(c for c in checks if c.name == "Pi version")
    assert version_check.ok == ok
    assert detail in version_check.detail
    assert calls[0][0] == [str(launcher), "--version"]
    assert len(calls) == 1
    assert snapshot(tmp_path) == before


def test_doctor_missing_launcher_and_env_names_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HUB_PRESENT", "sensitive-value")
    monkeypatch.setenv("HUB_EMPTY", "")
    monkeypatch.delenv("HUB_MISSING", raising=False)
    checks = service.doctor(
        manifest_file(
            tmp_path, required_env=["HUB_PRESENT", "HUB_EMPTY", "HUB_MISSING"]
        )
    )
    assert not next(c for c in checks if c.name == "Pi version").ok
    for name in ("HUB_EMPTY", "HUB_MISSING"):
        assert not next(c for c in checks if c.name == name).ok
    assert "sensitive-value" not in repr(checks)


@pytest.mark.parametrize("file", ["settings.json", "agentic-hub/pi-state.json"])
def test_malformed_settings_and_state_are_errors(
    tmp_path: Path, isolated_pi_home: Path, file: str
) -> None:
    target = isolated_pi_home / ".pi/agent" / file
    target.parent.mkdir(parents=True)
    target.write_text('{"secret": broken-private-value}')
    manifest = manifest_file(tmp_path)
    assert service.inspect_setup(manifest).status == "error"
    assert not all(c.ok for c in service.doctor(manifest))
    assert "broken-private-value" not in repr(service.doctor(manifest))


def bump_manifest_file(tmp_path: Path) -> Path:
    path = manifest_file(tmp_path)
    document = json.loads(path.read_text())
    document["packages"] = ["npm:demo@1.0.0"]
    path.write_text(json.dumps(document))
    return path


def test_bump_dry_run_previews_and_real_run_rewrites(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = bump_manifest_file(tmp_path)
    monkeypatch.setattr(bump, "latest_version", lambda name: "1.1.0")
    before = manifest.read_bytes()
    cli.main(["pi", "bump", "--dry-run", "--manifest", str(manifest)])
    assert "would bump demo 1.0.0 -> 1.1.0" in capsys.readouterr().out
    assert manifest.read_bytes() == before
    cli.main(["pi", "bump", "--manifest", str(manifest)])
    assert "bumped demo 1.0.0 -> 1.1.0" in capsys.readouterr().out
    assert service.inspect_setup(manifest).changes[0].identity == "demo"
    assert "npm:demo@1.1.0" in manifest.read_text()
    cli.main(["pi", "bump", "--manifest", str(manifest)])
    assert "already at latest" in capsys.readouterr().out


def test_bump_failure_exits_1_and_touches_nothing(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = bump_manifest_file(tmp_path)

    def fail(name: str) -> str:
        raise ValueError("cannot resolve latest version of demo")

    monkeypatch.setattr(bump, "latest_version", fail)
    before = snapshot(tmp_path)
    with pytest.raises(SystemExit) as exc:
        cli.main(["pi", "bump", "--manifest", str(manifest)])
    assert exc.value.code == 1
    assert "Pi bump: error" in capsys.readouterr().err
    assert snapshot(tmp_path) == before
