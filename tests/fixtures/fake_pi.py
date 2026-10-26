"""Network-free Pi process double; executed using the test interpreter."""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def delayed_child(mode: str) -> None:
    code = "import os,signal,time; from pathlib import Path; "
    if mode == "stubborn":
        code += "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    code += "time.sleep(1.5); Path(os.environ['HUB_DELAYED_WRITE']).write_text('unsafe late write'); time.sleep(10)"
    subprocess.Popen([sys.executable, "-c", code])
    Path(os.environ["HUB_CHILD_READY"]).write_text("ready")
    if mode != "pipes":
        time.sleep(20)


def main() -> None:
    if sys.argv[1:] == ["--version"]:
        print(os.environ.get("HUB_FAKE_VERSION", "1.4.0"))
        return
    command, source, flag = sys.argv[1:]
    assert command in ("install", "remove") and flag == "--no-approve"
    root = Path(os.environ["PI_CODING_AGENT_DIR"])
    log = os.environ.get("HUB_FAKE_LOG")
    if log:
        with Path(log).open("a") as stream:
            stream.write(
                json.dumps(
                    {"argv": sys.argv[1:], "cwd": os.getcwd(), "root": str(root)}
                )
                + "\n"
            )
    mode = os.environ.get("HUB_FAKE_MODE", "normal")
    if os.environ.get("HUB_FAIL_SOURCE", "not-a-source") in source:
        mode = "fail"
    if mode == "fail":
        print("secret-child-output", file=sys.stderr)
        sys.exit(7)
    if mode in ("child", "pipes", "stubborn"):
        delayed_child(mode)
        if mode == "pipes":
            return
    if mode == "hang":
        time.sleep(20)
    if mode == "no-write":
        return
    mutate_settings(root, command, source, mode)


def mutate_settings(root: Path, command: str, source: str, mode: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    target = root / "settings.json"
    data: dict[str, object] = json.loads(target.read_text()) if target.exists() else {}
    entries = data.get("packages", [])
    assert isinstance(entries, list)
    name = source.rsplit("@", 1)[0]
    matches = [
        i
        for i, e in enumerate(entries)
        if isinstance(e, str) and e.rsplit("@", 1)[0] == name
    ]
    if command == "remove":
        entries = [e for i, e in enumerate(entries) if i not in matches]
    elif matches:
        entries[matches[0]] = source
    else:
        entries.append(source)
    data["packages"] = entries
    if mode == "unrelated":
        data["private"] = "unexpected sensitive change"
    target.write_text(json.dumps(data))
    if mode == "corrupt":
        target.write_text('{"private": truncated')
    if mode == "after-write-fail":
        sys.exit(9)


if __name__ == "__main__":
    main()
