#!/usr/bin/env python3
"""Lightweight HTTP relay: sandbox -> knowledge-intake sprite.

Listens on port 9999, forwards URL extraction requests to the knowledge-intake
sprite via its external API. After extraction, pulls the file back to
~/jibrain/intake/ which Syncthing distributes to all machines.

v3: Switched from sprite exec (unreliable websocket) to external HTTP API.
    Still uses sprite exec as fallback for file pull-back.
"""

import http.server
import json
import subprocess
import base64
import os
import re as regex
from pathlib import Path
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

PORT = 9999
SPRITE_ORG = "joi-ito"
SPRITE_NAME = "knowledge-intake"
SPRITE_BIN = os.path.expanduser("~/.local/bin/sprite")
JIBRAIN_EXTRACTIONS = Path.home() / "jibrain" / "intake"
JIBRAIN_ROOT = Path.home() / "jibrain"
SWITCHBOARD_KNOWLEDGE = Path.home() / "switchboard-knowledge"

# External API for knowledge-intake sprite
INTAKE_API_URL = "https://knowledge-intake-bmal2.sprites.app"
API_KEY_PATH = Path.home() / ".config" / "knowledge-intake" / "api-key"


def _load_api_key() -> str:
    """Load API key from local config file."""
    if API_KEY_PATH.exists():
        return API_KEY_PATH.read_text().strip()
    raise RuntimeError(f"API key not found at {API_KEY_PATH}")


def api_request(endpoint: str, method: str = "GET", data: dict | None = None, timeout: int = 120) -> dict:
    """Make an authenticated request to the knowledge-intake API."""
    api_key = _load_api_key()
    url = f"{INTAKE_API_URL}{endpoint}"
    headers = {
        "X-API-Key": api_key,
        "Content-Type": "application/json",
    }
    body = json.dumps(data).encode() if data else None
    req = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        error_body = e.read().decode() if e.fp else str(e)
        raise RuntimeError(f"API error {e.code}: {error_body}")
    except URLError as e:
        raise RuntimeError(f"API connection error: {e.reason}")


def sprite_exec(cmd: str, timeout: int = 120) -> str:
    """Run a command inside the sprite via sprite exec (fallback for file ops)."""
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
    """Read a file from inside the sprite (fallback)."""
    result = subprocess.run(
        [SPRITE_BIN, "-o", SPRITE_ORG, "-s", SPRITE_NAME, "exec", "bash", "-c",
         f"cat {remote_path}"],
        capture_output=True, text=True, timeout=timeout
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to read {remote_path}: {result.stderr}")
    return result.stdout


def inject_frontmatter_tags(content: str, extra_tags: list[str]) -> str:
    """Inject extra tags into a markdown file YAML frontmatter.

    For ws: tags, also injects workstream/thread/confidential fields
    so jibrain-triage routes them to confidential workstreams.
    """
    if not extra_tags or "---" not in content:
        return content

    parts = content.split("---", 2)
    if len(parts) < 3:
        return content
    fm_text = parts[1]
    body = parts[2]

    for tag in extra_tags:
        if tag not in fm_text:
            if "tags:" in fm_text:
                fm_text = fm_text.replace("tags: [", f"tags: [{tag}, ", 1)
            else:
                fm_text = fm_text.rstrip() + f"\ntags: [{tag}]\n"

        # For ws: tags, inject workstream/thread/confidential fields
        if tag.startswith("ws:"):
            ws_parts = tag[3:].split(":", 1)
            ws_root = ws_parts[0]
            thread = ws_parts[1] if len(ws_parts) > 1 else None
            if "workstream:" not in fm_text:
                fm_text = fm_text.rstrip() + f"\nworkstream: {ws_root}\n"
            if thread and "thread:" not in fm_text:
                fm_text = fm_text.rstrip() + f"\nthread: {thread}\n"
            if "confidential:" not in fm_text:
                fm_text = fm_text.rstrip() + "\nconfidential: true\n"

    return f"---{fm_text}---{body}"


def pull_extraction(file_path: str, extra_tags: list[str] | None = None):
    """Pull extraction file from sprite to local jibrain."""
    filename = Path(file_path).name
    remote_path = f"/home/sprite/vault/{file_path}"
    content = sprite_cat(remote_path)

    # Inject extra tags (e.g., ws:medtech:hbot) into frontmatter
    if extra_tags:
        content = inject_frontmatter_tags(content, extra_tags)
        print(f"[relay] Injected tags {extra_tags} into {filename}", flush=True)

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


def structured_intake(payload: dict) -> dict:
    """Handle structured intake from Ethoswarm Minds or other agents.
    
    Writes markdown directly to jibrain/intake/ (no sprite needed).
    Schema matches the jimindbot bridge spec.
    """
    action = payload.get("action", "create_intake")
    frontmatter = payload.get("frontmatter", {})
    body_content = payload.get("content", "")
    routing = payload.get("routing", "intake")
    mind_context = payload.get("mind_context", {})

    if not body_content:
        return {"error": "missing content field"}

    # Build frontmatter YAML
    fm_lines = ["---"]
    for k, v in frontmatter.items():
        if isinstance(v, list):
            fm_lines.append(f"{k}: [{', '.join(str(i) for i in v)}]")
        elif isinstance(v, str) and (" " in v or ":" in v):
            fm_lines.append(f'{k}: "{v}"')
        else:
            fm_lines.append(f"{k}: {v}")

    # Add mind_context as comments
    if mind_context:
        fm_lines.append(f"# mind_id: {mind_context.get('mindId', 'unknown')}")
        fm_lines.append(f"# confidence: {mind_context.get('confidence', 'unknown')}")

    fm_lines.append("---")

    full_content = "\n".join(fm_lines) + "\n\n" + body_content

    # Determine filename from title (first # heading) or slug
    title_match = regex.search(r"^# (.+)$", body_content, regex.MULTILINE)
    if title_match:
        slug = regex.sub(r"[^a-z0-9]+", "-", title_match.group(1).lower()).strip("-")
    else:
        slug = f"ethoswarm-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

    # Route to correct directory
    if action == "create_observation":
        target_dir = JIBRAIN_EXTRACTIONS / ".observations"
        filename = f"{datetime.now().strftime('%Y-%m-%d')}-{slug}.md"
    elif action == "update_entity":
        # Write to _review for human triage
        target_dir = JIBRAIN_ROOT / "_review"
        filename = f"update-{slug}.md"
    else:
        target_dir = JIBRAIN_EXTRACTIONS
        filename = f"{slug}.md"

    target_dir.mkdir(parents=True, exist_ok=True)
    filepath = target_dir / filename

    # Don't overwrite existing files
    if filepath.exists():
        stem = filepath.stem
        filepath = target_dir / f"{stem}-{datetime.now().strftime('%H%M%S')}.md"

    filepath.write_text(full_content, encoding="utf-8")
    print(f"[relay] Structured intake: {filepath.name} ({action})", flush=True)

    return {
        "status": "created",
        "action": action,
        "file_path": str(filepath.relative_to(Path.home())),
        "filename": filepath.name,
        "synced_via": "syncthing",
    }


def search_vault(query: str, limit: int = 20) -> dict:
    """Search jibrain and switchboard-knowledge for matching content.
    
    Simple text search with frontmatter parsing. Returns matching files
    with snippets for duplicate detection and knowledge retrieval.
    """
    results = []
    search_dirs = [
        (JIBRAIN_ROOT / "atlas", "atlas"),
        (JIBRAIN_ROOT / "intake", "intake"),
        (JIBRAIN_ROOT / "domains", "domains"),
        (SWITCHBOARD_KNOWLEDGE / "concepts", "concepts"),
        (SWITCHBOARD_KNOWLEDGE / "organizations", "organizations"),
        (SWITCHBOARD_KNOWLEDGE / "references", "references"),
    ]

    terms = query.lower().split()

    for search_dir, collection in search_dirs:
        if not search_dir.exists():
            continue
        for md_file in search_dir.rglob("*.md"):
            try:
                text = md_file.read_text(encoding="utf-8")
                text_lower = text.lower()

                # Score: count how many search terms appear
                score = sum(1 for t in terms if t in text_lower)
                if score == 0:
                    continue

                # Extract title
                title_match = regex.search(r"^# (.+)$", text, regex.MULTILINE)
                title = title_match.group(1) if title_match else md_file.stem

                # Extract description from frontmatter
                desc = ""
                fm_match = regex.search(r'description:\s*["\']?(.+?)["\']?\s*$', text, regex.MULTILINE)
                if fm_match:
                    desc = fm_match.group(1)

                # Snippet: first line containing a search term
                snippet = ""
                for line in text.split("\n"):
                    if any(t in line.lower() for t in terms):
                        snippet = line.strip()[:200]
                        break

                results.append({
                    "file": str(md_file.relative_to(Path.home())),
                    "collection": collection,
                    "title": title,
                    "description": desc,
                    "score": score / len(terms),
                    "snippet": snippet,
                })
            except Exception:
                continue

    # Sort by score descending
    results.sort(key=lambda r: r["score"], reverse=True)
    return {
        "query": query,
        "total": len(results),
        "results": results[:limit],
    }


class RelayHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[relay] {args[0]}", flush=True)

    def _respond(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        try:
            if self.path == "/health":
                result = api_request("/health")
                self._respond(200, result)
            elif self.path == "/recent":
                result = api_request("/recent")
                self._respond(200, result)
            elif self.path == "/relay-health":
                self._respond(200, {
                    "status": "ok", "relay": "bookmark-relay", "port": PORT,
                    "version": "3.0",
                    "endpoints": [
                        "POST /intake (URL bookmark extraction via API)",
                        "POST /intake/structured (Ethoswarm/agent structured payloads)",
                        "GET /search?q=... (vault text search)",
                        "GET /intake/schema (endpoint schema docs)",
                        "GET /doc?path=... (read full document)",
                        "GET /tag?t=... (list files by tag)",
                    ],
                    "jibrain_extractions": str(JIBRAIN_EXTRACTIONS),
                    "api_url": INTAKE_API_URL,
                })
            elif self.path.startswith("/search"):
                parsed = urlparse(self.path)
                params = parse_qs(parsed.query)
                query = params.get("q", [""])[0]
                limit_str = params.get("limit", ["20"])[0]
                try:
                    limit = int(limit_str)
                except ValueError:
                    limit = 20
                if not query:
                    self._respond(400, {"error": "missing q parameter"})
                    return
                result = search_vault(query, limit)
                self._respond(200, result)
            elif self.path == "/intake/schema":
                self._respond(200, {
                    "endpoint": "/intake/structured",
                    "method": "POST",
                    "actions": ["create_intake", "create_observation", "update_entity"],
                    "schema": {
                        "action": "string (required): create_intake | create_observation | update_entity",
                        "frontmatter": {
                            "type": "concept | person | organization | reference",
                            "description": "~150 chars (required)",
                            "source": "ethoswarm-mind | web | paper | conversation",
                            "source_url": "https://...",
                            "source_date": "YYYY-MM-DD",
                            "tags": ["list", "of", "tags"],
                            "status": "draft",
                            "agent": "agent-name",
                        },
                        "content": "string - markdown body with # Title heading (required)",
                        "routing": "intake | intake/.observations",
                        "mind_context": {
                            "mindId": "GUID",
                            "confidence": "0.0-1.0",
                            "classification_reasoning": "string",
                        },
                    },
                })
            elif self.path.startswith("/doc"):
                # Read a full document by path (constrained to jibrain + switchboard-knowledge)
                parsed = urlparse(self.path)
                params = parse_qs(parsed.query)
                file_path = params.get("path", [""])[0]
                if not file_path:
                    self._respond(400, {"error": "missing path parameter"})
                    return
                # Security: only allow reading from jibrain and switchboard-knowledge
                allowed_roots = [JIBRAIN_ROOT, SWITCHBOARD_KNOWLEDGE]
                resolved = None
                for root in allowed_roots:
                    candidate = (root / file_path).resolve()
                    if candidate.exists() and str(candidate).startswith(str(root.resolve())):
                        resolved = candidate
                        break
                if resolved is None:
                    # Also try treating path as relative to home (e.g. jibrain/atlas/...)
                    candidate = (Path.home() / file_path).resolve()
                    for root in allowed_roots:
                        if str(candidate).startswith(str(root.resolve())):
                            resolved = candidate
                            break
                if resolved is None or not resolved.exists():
                    self._respond(404, {"error": f"file not found or not accessible: {file_path}"})
                    return
                try:
                    text = resolved.read_text(encoding="utf-8")
                    self._respond(200, {
                        "path": str(resolved.relative_to(Path.home())),
                        "size": len(text),
                        "content": text,
                    })
                except Exception as e:
                    self._respond(500, {"error": f"failed to read: {e}"})
            elif self.path.startswith("/tag"):
                # List all files with a specific tag
                parsed = urlparse(self.path)
                params = parse_qs(parsed.query)
                tag = params.get("t", [""])[0]
                if not tag:
                    self._respond(400, {"error": "missing t parameter"})
                    return
                tagged_files = []
                for search_dir, collection in [
                    (JIBRAIN_ROOT / "atlas", "atlas"),
                    (JIBRAIN_ROOT / "intake", "intake"),
                    (JIBRAIN_ROOT / "domains", "domains"),
                ]:
                    if not search_dir.exists():
                        continue
                    for md_file in search_dir.rglob("*.md"):
                        try:
                            text = md_file.read_text(encoding="utf-8")
                            if tag in text:
                                title_match = regex.search(r"^# (.+)$", text, regex.MULTILINE)
                                title = title_match.group(1) if title_match else md_file.stem
                                desc_match = regex.search(r'description:\s*(.+)', text)
                                desc = desc_match.group(1) if desc_match else ""
                                tagged_files.append({
                                    "file": str(md_file.relative_to(Path.home())),
                                    "collection": collection,
                                    "title": title,
                                    "description": desc,
                                })
                        except Exception:
                            continue
                self._respond(200, {"tag": tag, "total": len(tagged_files), "files": tagged_files})
            else:
                self._respond(404, {"error": "not found"})
        except Exception as e:
            self._respond(502, {"error": str(e)})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode() if length else "{}"
            payload = json.loads(body)

            if self.path == "/intake":
                if "url" not in payload:
                    self._respond(400, {"error": "missing url field"})
                    return

                # Call knowledge-intake external API directly (no sprite exec)
                api_payload = {"url": payload["url"]}
                if "hint" in payload:
                    api_payload["hint"] = payload["hint"]
                if "domain" in payload:
                    api_payload["domain"] = payload["domain"]

                print(f"[relay] Calling knowledge-intake API for: {payload['url']}", flush=True)
                result = api_request("/intake", method="POST", data=api_payload)

                # Pull file back to jibrain (best-effort via sprite exec)
                if result.get("status") == "created" and result.get("file_path"):
                    try:
                        extra_tags = payload.get("tags", [])
                        pull_extraction(result["file_path"], extra_tags=extra_tags)
                        result["synced_to_jibrain"] = True
                    except Exception as e:
                        print(f"[relay] Pull-back failed (file will arrive via Syncthing): {e}", flush=True)
                        result["synced_to_jibrain"] = False
                        result["sync_note"] = "file will arrive via Syncthing to macazbd"

                        # If there were tags but pull-back failed, write a pending-tags sidecar
                        extra_tags = payload.get("tags", [])
                        if extra_tags and result.get("file_path"):
                            try:
                                stem = Path(result["file_path"]).stem
                                tags_dir = JIBRAIN_EXTRACTIONS / ".pending-tags"
                                tags_dir.mkdir(parents=True, exist_ok=True)
                                sidecar = {"tags": extra_tags, "file_stem": stem,
                                           "created": datetime.now().isoformat()}
                                (tags_dir / f"{stem}.json").write_text(
                                    json.dumps(sidecar), encoding="utf-8")
                                print(f"[relay] Wrote pending-tags sidecar for {stem}", flush=True)
                                result["pending_tags"] = extra_tags
                            except Exception as te:
                                print(f"[relay] Failed to write tag sidecar: {te}", flush=True)

                self._respond(200, result)

            elif self.path == "/intake/structured":
                result = structured_intake(payload)
                if "error" in result:
                    self._respond(400, result)
                else:
                    self._respond(201, result)

            else:
                self._respond(404, {"error": "not found"})
        except json.JSONDecodeError:
            self._respond(400, {"error": "invalid JSON"})
        except Exception as e:
            self._respond(502, {"error": str(e)})


if __name__ == "__main__":
    JIBRAIN_EXTRACTIONS.mkdir(parents=True, exist_ok=True)
    server = http.server.HTTPServer(("0.0.0.0", PORT), RelayHandler)
    print(f"[relay] Bookmark relay v3 listening on :{PORT}", flush=True)
    print(f"[relay] API: {INTAKE_API_URL}", flush=True)
    print(f"[relay] Jibrain extractions: {JIBRAIN_EXTRACTIONS}", flush=True)
    print(f"[relay] Endpoints: /intake, /intake/structured, /search, /doc, /tag, /relay-health", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[relay] Shutting down")
        server.server_close()
