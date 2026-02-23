#!/usr/bin/env python3
"""Lightweight HTTP relay: sandbox -> sprite bookmark-extractor.

Listens on port 9999, forwards requests to the bookmark-extractor sprite
via `sprite exec`. After extraction, pulls the file back to ~/jibrain/intake/
which Syncthing distributes to all machines.
"""

import http.server
import json
import subprocess
import base64
import os
from pathlib import Path

PORT = 9999
SPRITE_ORG = "joi-ito"
SPRITE_NAME = "bookmark-extractor"
SPRITE_BIN = os.path.expanduser("~/.local/bin/sprite")
JIBRAIN_EXTRACTIONS = Path.home() / "jibrain" / "intake"


def sprite_exec(cmd: str, timeout: int = 120) -> str:
    result = subprocess.run(
        [SPRITE_BIN, "-o", SPRITE_ORG, "-s", SPRITE_NAME, "exec", "bash", "-c", cmd],
        capture_output=True, text=True, timeout=timeout
    )
    out = result.stdout.strip()
    if out:
        try:
            json.loads(out)
            return out
        except json.JSONDecodeError:
            pass
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or out or "sprite exec failed")
    return out


def sprite_cat(remote_path: str, timeout: int = 30) -> str:
    result = subprocess.run(
        [SPRITE_BIN, "-o", SPRITE_ORG, "-s", SPRITE_NAME, "exec",
         "cat", remote_path],
        capture_output=True, text=True, timeout=timeout
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to read {remote_path}: {result.stderr}")
    return result.stdout


def pull_extraction(file_path: str):
    """Pull extraction file from sprite to local jibrain."""
    # file_path is like "agents/curator/extractions/some-article.md"
    filename = Path(file_path).name
    remote_path = f"/home/sprite/vault/{file_path}"
    content = sprite_cat(remote_path)
    local_path = JIBRAIN_EXTRACTIONS / filename
    local_path.write_text(content, encoding="utf-8")
    print(f"[relay] Pulled {filename} -> {local_path} ({len(content)} bytes)", flush=True)

    # Also pull .meta JSON if it exists
    stem = Path(filename).stem
    meta_remote = f"/home/sprite/vault/agents/curator/extractions/.meta/{stem}.json"
    try:
        meta_content = sprite_cat(meta_remote)
        meta_dir = JIBRAIN_EXTRACTIONS / ".meta"
        meta_dir.mkdir(parents=True, exist_ok=True)
        (meta_dir / f"{stem}.json").write_text(meta_content, encoding="utf-8")
    except Exception:
        pass


class RelayHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[relay] {args[0]}", flush=True)

    def _respond(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            if self.path == "/health":
                out = sprite_exec("curl -s http://localhost:8080/health")
                self._respond(200, json.loads(out))
            elif self.path == "/recent":
                out = sprite_exec("curl -s http://localhost:8080/recent")
                self._respond(200, json.loads(out))
            elif self.path == "/relay-health":
                self._respond(200, {
                    "status": "ok", "relay": "bookmark-relay", "port": PORT,
                    "jibrain_extractions": str(JIBRAIN_EXTRACTIONS),
                })
            else:
                self._respond(404, {"error": "not found"})
        except Exception as e:
            self._respond(502, {"error": str(e)})

    def do_POST(self):
        try:
            if self.path == "/intake":
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode() if length else "{}"
                payload = json.loads(body)
                if "url" not in payload:
                    self._respond(400, {"error": "missing url field"})
                    return
                b64 = base64.b64encode(body.encode()).decode()
                cmd = f"echo {b64} | base64 -d | curl -s -X POST http://localhost:8080/intake -H 'Content-Type: application/json' -d @-"
                out = sprite_exec(cmd)
                result = json.loads(out)

                # Pull file back to jibrain
                if result.get("status") == "created" and result.get("file_path"):
                    try:
                        pull_extraction(result["file_path"])
                        result["synced_to_jibrain"] = True
                    except Exception as e:
                        print(f"[relay] Pull-back failed: {e}", flush=True)
                        result["synced_to_jibrain"] = False
                        result["sync_error"] = str(e)

                self._respond(200, result)
            else:
                self._respond(404, {"error": "not found"})
        except json.JSONDecodeError:
            self._respond(400, {"error": "invalid JSON"})
        except Exception as e:
            self._respond(502, {"error": str(e)})


if __name__ == "__main__":
    JIBRAIN_EXTRACTIONS.mkdir(parents=True, exist_ok=True)
    server = http.server.HTTPServer(("0.0.0.0", PORT), RelayHandler)
    print(f"[relay] Bookmark relay listening on :{PORT}", flush=True)
    print(f"[relay] Jibrain extractions: {JIBRAIN_EXTRACTIONS}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[relay] Shutting down")
        server.server_close()
