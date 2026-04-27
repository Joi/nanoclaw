#!/usr/bin/env python3
"""
QMD Domain Fleet Manager — no external deps.
Reads ~/.config/qmd/fleet.yaml and manages one supergateway QMD process per domain.
Each domain = separate SQLite database. Hard isolation: a process only has what it was
initialized with.
"""
import os, signal, subprocess, sys, time, urllib.request
from pathlib import Path

FLEET_CONFIG    = Path.home() / ".config/qmd/fleet.yaml"
SUPERGATEWAY    = "/opt/homebrew/bin/supergateway"
QMD             = "/opt/homebrew/bin/qmd"
HEALTH_INTERVAL = 30
RESTART_DELAY   = 5

def load_fleet():
    """Hand-rolled parser for fleet.yaml. No external deps."""
    domains = {}
    current = None
    with open(FLEET_CONFIG) as f:
        for raw in f:
            line = raw.rstrip()
            if not line or line.lstrip().startswith("#"):
                continue
            indent = len(line) - len(line.lstrip())
            text   = line.strip()
            if indent == 2 and text.endswith(":") and " " not in text:
                current = text[:-1]
                domains[current] = {}
            elif indent == 4 and current and ":" in text:
                k, _, v = text.partition(":")
                k, v = k.strip(), v.strip().strip('"\'')
                domains[current][k] = int(v) if k == "port" else v
    return {"domains": domains}

def start_domain(name, port):
    cmd = [SUPERGATEWAY, "--stdio", f"{QMD} --index {name} mcp",
           "--outputTransport", "streamableHttp",
           "--port", str(port), "--cors",
           "--healthEndpoint", "/healthz", "--logLevel", "info"]
    out = open(f"/tmp/qmd-{name}.log", "a")
    err = open(f"/tmp/qmd-{name}.err", "a")
    proc = subprocess.Popen(cmd, stdout=out, stderr=err)
    print(f"[fleet] started {name} port={port} pid={proc.pid}", flush=True)
    return proc

def health_ok(port):
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/healthz", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False

def run():
    procs = {}

    def shutdown(sig, frame):
        print("[fleet] shutting down", flush=True)
        for name, (proc, _) in procs.items():
            proc.terminate()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    fleet = load_fleet()
    for name, cfg in fleet.get("domains", {}).items():
        procs[name] = (start_domain(name, cfg["port"]), cfg["port"])

    time.sleep(4)

    while True:
        try:
            fleet = load_fleet()
            domains = fleet.get("domains", {})

            for name, cfg in domains.items():
                if name not in procs:
                    procs[name] = (start_domain(name, cfg["port"]), cfg["port"])

            for name in list(procs):
                if name not in domains:
                    procs[name][0].terminate()
                    del procs[name]
                    print(f"[fleet] stopped removed domain {name}", flush=True)

            for name, (proc, port) in list(procs.items()):
                if proc.poll() is not None:
                    print(f"[fleet] {name} crashed (exit {proc.returncode}), restarting", flush=True)
                    time.sleep(RESTART_DELAY)
                    procs[name] = (start_domain(name, port), port)
                elif not health_ok(port):
                    print(f"[fleet] {name} unhealthy port={port}, restarting", flush=True)
                    proc.terminate()
                    time.sleep(RESTART_DELAY)
                    procs[name] = (start_domain(name, port), port)
        except Exception as e:
            print(f"[fleet] error: {e}", flush=True)
        time.sleep(HEALTH_INTERVAL)

if __name__ == "__main__":
    run()
