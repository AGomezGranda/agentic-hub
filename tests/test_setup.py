import importlib.util
import os
import subprocess
import tomllib
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "setup.py"
spec = importlib.util.spec_from_file_location("hub_setup", SCRIPT)
assert spec and spec.loader
hub_setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub_setup)


def test_render_config_sets_repo_and_keeps_template(tmp_path: Path) -> None:
    template = "[server]\nport = 7331\n\n# [roles.implementer]\n"
    text = hub_setup.render_config(template, tmp_path / "hub")
    parsed = tomllib.loads(text)
    assert parsed["paths"] == {"repo": str(tmp_path / "hub")}
    assert parsed["server"] == {"port": 7331}


def test_render_config_accepts_astral_characters(tmp_path: Path) -> None:
    repo = tmp_path / "rocket-\U0001f680"
    text = hub_setup.render_config("", repo)
    assert tomllib.loads(text)["paths"] == {"repo": str(repo)}


def test_write_config_never_overwrites(tmp_path: Path) -> None:
    target = tmp_path / "payo" / "config.toml"
    assert hub_setup.write_config(target, "first") is True
    assert hub_setup.write_config(target, "second") is False
    assert target.read_text() == "first"
    assert target.stat().st_mode & 0o777 == 0o600


def test_write_config_removes_partial_file_on_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "config.toml"

    def broken_fdopen(fd: int, *args: object, **kwargs: object) -> None:
        os.write(fd, b"[server]\npo")  # a real partial prefix reaches the disk
        os.close(fd)
        raise OSError("disk full")

    monkeypatch.setattr(hub_setup.os, "fdopen", broken_fdopen)
    with pytest.raises(OSError):
        hub_setup.write_config(target, "text")
    assert not target.exists()


def test_config_path_honours_absolute_payo_config_file(tmp_path: Path) -> None:
    explicit = str(tmp_path / "custom.toml")
    assert hub_setup.config_path({"PAYO_CONFIG_FILE": explicit}) == Path(explicit)
    assert hub_setup.config_path({}) == Path.home() / ".config/payo/config.toml"


@pytest.mark.parametrize("value", ["rel.toml", "", "  "])
def test_config_path_rejects_non_absolute_values(value: str) -> None:
    with pytest.raises(SystemExit, match="absolute path"):
        hub_setup.config_path({"PAYO_CONFIG_FILE": value})


def test_real_template_renders(tmp_path: Path) -> None:
    text = hub_setup.render_config(hub_setup.TEMPLATE.read_text(), tmp_path)
    assert tomllib.loads(text)["model"]["provider"] == "anthropic"


def test_setup_template_allows_local_web_origins(tmp_path: Path) -> None:
    text = hub_setup.render_config(hub_setup.TEMPLATE.read_text(), tmp_path)
    assert tomllib.loads(text)["server"]["web_origins"] == [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ]


@pytest.mark.parametrize(
    ("env", "expected"),
    [({}, "pi"), ({"PAYO_PI_BIN": " /opt/pi "}, "/opt/pi")],
)
def test_pi_bin_mirrors_payo(env: dict[str, str], expected: str) -> None:
    assert hub_setup.pi_bin(env) == expected


@pytest.mark.parametrize("value", ["", "  "])
def test_pi_bin_rejects_blank(value: str) -> None:
    with pytest.raises(SystemExit, match="must not be blank"):
        hub_setup.pi_bin({"PAYO_PI_BIN": value})


def test_config_repo_reads_kept_file(tmp_path: Path) -> None:
    kept = tmp_path / "config.toml"
    kept.write_text('[paths]\nrepo = "/elsewhere"\n', encoding="utf-8")
    assert hub_setup.config_repo(kept) == Path("/elsewhere")
    kept.write_text("not = [valid", encoding="utf-8")
    assert hub_setup.config_repo(kept) is None


def test_main_rejects_bad_config_path_before_installing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_if_run(*args: object, **kwargs: object) -> None:
        raise AssertionError("installs must not run before the config path check")

    monkeypatch.setattr(hub_setup, "run", fail_if_run)
    monkeypatch.setenv("PAYO_CONFIG_FILE", "rel.toml")
    with pytest.raises(SystemExit, match="absolute path"):
        hub_setup.main()


def test_write_config_reports_dangling_symlink(tmp_path: Path) -> None:
    target = tmp_path / "config.toml"
    target.symlink_to(tmp_path / "missing")
    with pytest.raises(FileExistsError):
        hub_setup.write_config(target, "text")


@pytest.mark.parametrize(
    "text", ["paths = 1\n", 'paths = "x"\n', "paths = []\n", "paths = { repo = 3 }\n"]
)
def test_config_repo_ignores_malformed_paths(tmp_path: Path, text: str) -> None:
    kept = tmp_path / "config.toml"
    kept.write_text(text, encoding="utf-8")
    assert hub_setup.config_repo(kept) is None


def _node_reports(
    monkeypatch: pytest.MonkeyPatch, stdout: str, returncode: int = 0, stderr: str = ""
) -> None:
    monkeypatch.setattr(hub_setup.shutil, "which", lambda name: "/usr/bin/node")
    result = subprocess.CompletedProcess([], returncode, stdout=stdout, stderr=stderr)
    monkeypatch.setattr(hub_setup.subprocess, "run", lambda *a, **k: result)


def test_require_node_accepts_24(monkeypatch: pytest.MonkeyPatch) -> None:
    _node_reports(monkeypatch, "24\n")
    hub_setup.require_node()


def test_require_node_rejects_22(monkeypatch: pytest.MonkeyPatch) -> None:
    _node_reports(monkeypatch, "22\n")
    with pytest.raises(SystemExit, match="Node 24 or newer"):
        hub_setup.require_node()


def test_require_node_reports_subprocess_stderr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _node_reports(monkeypatch, "", returncode=1, stderr="mise ERROR no version set")
    with pytest.raises(SystemExit, match="mise ERROR no version set"):
        hub_setup.require_node()


def test_main_does_not_gate_pi_or_git_before_installs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    class InstallsReached(Exception):
        pass

    def reached(*args: object, **kwargs: object) -> None:
        raise InstallsReached

    monkeypatch.setattr(hub_setup, "require", lambda *args: None)
    monkeypatch.setattr(hub_setup, "require_node", lambda: None)
    monkeypatch.setattr(hub_setup, "run", reached)
    monkeypatch.setenv("PAYO_CONFIG_FILE", str(tmp_path / "config.toml"))
    monkeypatch.setenv("PAYO_PI_BIN", "/nonexistent-pi")
    with pytest.raises(InstallsReached):
        hub_setup.main()
