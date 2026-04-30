"""Tests for scripts/send-message.py cmd_send_file command."""

import importlib.util
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path

import pytest


def load_module():
    """Load send-message.py as a module (hyphen in name requires importlib)."""
    spec = importlib.util.spec_from_file_location(
        "send_message",
        Path(__file__).parent.parent / "scripts" / "send-message.py",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Isolated IPC + registry environment for each test."""
    ipc_base = tmp_path / "ipc"
    ipc_base.mkdir()
    registry_path = tmp_path / "recipients.json"

    recipients = {
        "recipients": {
            "bhutan-tea-wa": {
                "jid": "111222333444-1234567890@g.us",
                "aliases": ["bhutan-tea"],
                "channel": "whatsapp",
                "type": "group",
                "ipc_group": "bhutan-tea-wa",
                "description": "Bhutan Tea WhatsApp group",
            }
        }
    }
    registry_path.write_text(json.dumps(recipients))
    (ipc_base / "bhutan-tea-wa").mkdir()

    mod = load_module()
    monkeypatch.setattr(mod, "REGISTRY_PATH", registry_path)
    monkeypatch.setattr(mod, "IPC_BASE", ipc_base)
    # Point DB_PATH at a nonexistent path so the DB fallback never fires.
    monkeypatch.setattr(mod, "DB_PATH", tmp_path / "nonexistent.db")
    return mod, ipc_base, tmp_path


def call_send_file(mod, args):
    """Run cmd_send_file; return (exit_code, stdout_text)."""
    out = io.StringIO()
    with redirect_stdout(out):
        with pytest.raises(SystemExit) as exc_info:
            mod.cmd_send_file(args)
    return exc_info.value.code, out.getvalue()


# ---------------------------------------------------------------------------
# a) Happy path
# ---------------------------------------------------------------------------


def test_send_file_happy_path_writes_correct_ipc_json(env):
    """Happy path: resolves recipient, file exists, writes correct IPC JSON."""
    mod, ipc_base, tmp = env

    test_file = tmp / "onboarding.pdf"
    test_file.write_bytes(b"%PDF-1.4 fake content")

    code, stdout = call_send_file(
        mod,
        ["bhutan-tea-wa", str(test_file), "Bhutan Tea onboarding PDF"],
    )

    assert code == 0, f"Expected exit 0, got {code}. stdout={stdout}"
    result = json.loads(stdout)
    assert result["status"] == "sent"
    assert result["filename"] == "onboarding.pdf"
    assert result["mimetype"] == "application/pdf"
    assert result["caption_preview"] == "Bhutan Tea onboarding PDF"

    messages_dir = ipc_base / "bhutan-tea-wa" / "messages"
    ipc_files = list(messages_dir.glob("*.json"))
    assert len(ipc_files) == 1

    payload = json.loads(ipc_files[0].read_text())
    assert payload["type"] == "file"
    assert payload["chatJid"] == "111222333444-1234567890@g.us"
    assert payload["filePath"] == str(test_file.resolve())
    assert payload["filename"] == "onboarding.pdf"
    assert payload["mimetype"] == "application/pdf"
    assert payload["caption"] == "Bhutan Tea onboarding PDF"


def test_send_file_no_caption_omits_field(env):
    """Caption field is omitted from IPC JSON when no caption given."""
    mod, ipc_base, tmp = env

    test_file = tmp / "report.pdf"
    test_file.write_bytes(b"%PDF-1.4")

    code, stdout = call_send_file(mod, ["bhutan-tea-wa", str(test_file)])

    assert code == 0
    messages_dir = ipc_base / "bhutan-tea-wa" / "messages"
    payload = json.loads(next(messages_dir.glob("*.json")).read_text())
    assert "caption" not in payload


def test_send_file_as_flag_overrides_display_name(env):
    """--as <name> overrides the display filename."""
    mod, ipc_base, tmp = env

    test_file = tmp / "2026-03-01-raw-export.pdf"
    test_file.write_bytes(b"%PDF-1.4")

    code, stdout = call_send_file(
        mod,
        ["bhutan-tea-wa", str(test_file), "--as", "clean-report.pdf"],
    )

    assert code == 0
    messages_dir = ipc_base / "bhutan-tea-wa" / "messages"
    payload = json.loads(next(messages_dir.glob("*.json")).read_text())
    assert payload["filename"] == "clean-report.pdf"
    # mimetype inferred from --as name
    assert payload["mimetype"] == "application/pdf"


# ---------------------------------------------------------------------------
# b) Validation failures
# ---------------------------------------------------------------------------


def test_send_file_missing_file_exits_1(env):
    """Missing file path → exit 1."""
    mod, _ipc_base, tmp = env
    code, _out = call_send_file(
        mod, ["bhutan-tea-wa", str(tmp / "nonexistent.pdf")]
    )
    assert code == 1


def test_send_file_unreadable_file_exits_1(env):
    """Unreadable file → exit 1."""
    mod, _ipc_base, tmp = env

    test_file = tmp / "secret.pdf"
    test_file.write_bytes(b"secret")
    test_file.chmod(0o000)

    try:
        code, _out = call_send_file(mod, ["bhutan-tea-wa", str(test_file)])
        assert code == 1
    finally:
        test_file.chmod(0o644)


def test_send_file_unresolved_recipient_exits_1(env):
    """Unresolvable recipient → exit 1."""
    mod, _ipc_base, tmp = env

    test_file = tmp / "test.pdf"
    test_file.write_bytes(b"test")

    code, _out = call_send_file(mod, ["no-such-recipient", str(test_file)])
    assert code == 1


def test_send_file_too_few_args_exits_1(env):
    """Fewer than 2 positional args → exit 1."""
    mod, _ipc_base, _tmp = env
    code, _out = call_send_file(mod, ["bhutan-tea-wa"])
    assert code == 1
