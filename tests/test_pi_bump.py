import os
from pathlib import Path

import pytest

from agentic_hub.pi_handler import bump

MANIFEST = """{
  "version": 1,
  "packages": ["npm:demo@1.0.0", "npm:@scope/tools@0.1.0-beta.1+b.2"],
  "settings": { "list": ["npm:demo@1.0.0 stays"] },
  "required_env": []
}
"""


@pytest.fixture
def manifest(tmp_path: Path) -> Path:
    path = tmp_path / "manifest.json"
    path.write_text(MANIFEST.replace('"npm:demo@1.0.0 stays"', '"unrelated"'))
    return path


def latest(versions: dict[str, str]):
    def lookup(name: str) -> str:
        if name not in versions:
            raise ValueError(f"cannot resolve latest version of {name}")
        return versions[name]

    return lookup


def test_rewrites_only_changed_pins_preserving_formatting(
    manifest: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = manifest.read_text()
    monkeypatch.setattr(
        bump, "latest_version", latest({"demo": "1.1.0", "@scope/tools": "0.2.0"})
    )
    assert bump.bump_manifest(manifest, dry_run=False) == [
        bump.Bump("demo", "1.0.0", "1.1.0"),
        bump.Bump("@scope/tools", "0.1.0-beta.1+b.2", "0.2.0"),
    ]
    assert manifest.read_text() == before.replace("demo@1.0.0", "demo@1.1.0").replace(
        "0.1.0-beta.1+b.2", "0.2.0"
    )
    assert sorted(os.listdir(manifest.parent)) == ["manifest.json"]


def test_already_latest_is_noop(
    manifest: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = manifest.read_bytes()
    monkeypatch.setattr(
        bump,
        "latest_version",
        latest({"demo": "1.0.0", "@scope/tools": "0.1.0-beta.1+b.2"}),
    )
    assert bump.bump_manifest(manifest, dry_run=False) == []
    assert manifest.read_bytes() == before


def test_dry_run_reports_without_writing(
    manifest: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = manifest.read_bytes()
    monkeypatch.setattr(
        bump, "latest_version", latest({"demo": "2.0.0", "@scope/tools": "9.9.9"})
    )
    assert len(bump.bump_manifest(manifest, dry_run=True)) == 2
    assert manifest.read_bytes() == before
    assert os.listdir(manifest.parent) == ["manifest.json"]


def test_lookup_failure_aborts_everything(
    manifest: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = manifest.read_bytes()
    monkeypatch.setattr(bump, "latest_version", latest({"demo": "2.0.0"}))
    with pytest.raises(ValueError, match="@scope/tools"):
        bump.bump_manifest(manifest, dry_run=False)
    assert manifest.read_bytes() == before


def test_pin_text_not_found_exactly_once_aborts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "manifest.json"
    path.write_text(MANIFEST.replace('"npm:demo@1.0.0 stays"', '"npm:demo@1.0.0"'))
    before = path.read_bytes()
    monkeypatch.setattr(
        bump,
        "latest_version",
        latest({"demo": "2.0.0", "@scope/tools": "0.1.0-beta.1+b.2"}),
    )
    with pytest.raises(ValueError, match="cannot locate demo"):
        bump.bump_manifest(path, dry_run=False)
    assert path.read_bytes() == before


def fake_npm(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, body: str) -> Path:
    directory = tmp_path / "bin"
    directory.mkdir()
    npm = directory / "npm"
    npm.write_text(f'#!/bin/sh\necho "$PWD|$*" > {tmp_path}/args\n{body}\n')
    npm.chmod(0o700)
    monkeypatch.setenv("PATH", f"{directory}:/bin:/usr/bin")
    return tmp_path / "args"


def test_latest_version_runs_npm_view_in_neutral_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = fake_npm(tmp_path, monkeypatch, "echo ' 1.4.2 '")
    monkeypatch.chdir(tmp_path)
    assert bump.latest_version("@scope/tools") == "1.4.2"
    cwd, argv = args.read_text().strip().split("|")
    assert argv == "view @scope/tools version"
    assert Path(cwd).resolve() != tmp_path.resolve()


@pytest.mark.parametrize(
    "body", ["echo secret-garbage", "echo secret-out; exit 1", "echo '^1.2.3'"]
)
def test_latest_version_rejects_bad_npm_output_without_echoing_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, body: str
) -> None:
    fake_npm(tmp_path, monkeypatch, body)
    with pytest.raises(ValueError, match="cannot resolve") as exc:
        bump.latest_version("demo")
    assert "secret" not in str(exc.value)


def test_latest_version_without_npm(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", "")
    with pytest.raises(ValueError, match="npm not found"):
        bump.latest_version("demo")
