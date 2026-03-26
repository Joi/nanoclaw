import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addAllowlistEntry,
  isSenderAllowed,
  isTriggerAllowed,
  listAllowlistEntries,
  loadSenderAllowlist,
  removeAllowlistEntry,
  saveSenderAllowlist,
  SenderAllowlistConfig,
  shouldDropMessage,
} from "./sender-allowlist.js";

let tmpDir: string;

function cfgPath(name = "sender-allowlist.json"): string {
  return path.join(tmpDir, name);
}

function writeConfig(config: unknown, name?: string): string {
  const p = cfgPath(name);
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "allowlist-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadSenderAllowlist", () => {
  it("returns allow-all defaults when file is missing", () => {
    const cfg = loadSenderAllowlist(cfgPath());
    expect(cfg.default.allow).toBe("*");
    expect(cfg.default.mode).toBe("trigger");
    expect(cfg.logDenied).toBe(true);
  });

  it("loads allow=* config", () => {
    const p = writeConfig({
      default: { allow: "*", mode: "trigger" },
      chats: {},
      logDenied: false,
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe("*");
    expect(cfg.logDenied).toBe(false);
  });

  it("loads allow=[] (deny all)", () => {
    const p = writeConfig({
      default: { allow: [], mode: "trigger" },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual([]);
  });

  it("loads allow=[list]", () => {
    const p = writeConfig({
      default: { allow: ["alice", "bob"], mode: "drop" },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual(["alice", "bob"]);
    expect(cfg.default.mode).toBe("drop");
  });

  it("per-chat override beats default", () => {
    const p = writeConfig({
      default: { allow: "*", mode: "trigger" },
      chats: { "group-a": { allow: ["alice"], mode: "drop" } },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats["group-a"].allow).toEqual(["alice"]);
    expect(cfg.chats["group-a"].mode).toBe("drop");
  });

  it("returns allow-all on invalid JSON", () => {
    const p = cfgPath();
    fs.writeFileSync(p, "{ not valid json }}}");
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe("*");
  });

  it("returns allow-all on invalid schema", () => {
    const p = writeConfig({ default: { oops: true } });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe("*");
  });

  it("rejects non-string allow array items", () => {
    const p = writeConfig({
      default: { allow: [123, null, true], mode: "trigger" },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe("*"); // falls back to default
  });

  it("skips invalid per-chat entries", () => {
    const p = writeConfig({
      default: { allow: "*", mode: "trigger" },
      chats: {
        good: { allow: ["alice"], mode: "trigger" },
        bad: { allow: 123 },
      },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats["good"]).toBeDefined();
    expect(cfg.chats["bad"]).toBeUndefined();
  });
});

describe("isSenderAllowed", () => {
  it("allow=* allows any sender", () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "trigger" },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed("g1", "anyone", cfg)).toBe(true);
  });

  it("allow=[] denies any sender", () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: [], mode: "trigger" },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed("g1", "anyone", cfg)).toBe(false);
  });

  it("allow=[list] allows exact match only", () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ["alice", "bob"], mode: "trigger" },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed("g1", "alice", cfg)).toBe(true);
    expect(isSenderAllowed("g1", "eve", cfg)).toBe(false);
  });

  it("uses per-chat entry over default", () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "trigger" },
      chats: { g1: { allow: ["alice"], mode: "trigger" } },
      logDenied: true,
    };
    expect(isSenderAllowed("g1", "bob", cfg)).toBe(false);
    expect(isSenderAllowed("g2", "bob", cfg)).toBe(true);
  });
});

describe("shouldDropMessage", () => {
  it("returns false for trigger mode", () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "trigger" },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage("g1", cfg)).toBe(false);
  });

  it("returns true for drop mode", () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "drop" },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage("g1", cfg)).toBe(true);
  });

  it("per-chat mode override", () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "trigger" },
      chats: { g1: { allow: "*", mode: "drop" } },
      logDenied: true,
    };
    expect(shouldDropMessage("g1", cfg)).toBe(true);
    expect(shouldDropMessage("g2", cfg)).toBe(false);
  });
});

describe("isTriggerAllowed", () => {
  it("allows trigger for allowed sender", () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ["alice"], mode: "trigger" },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed("g1", "alice", cfg)).toBe(true);
  });

  it("denies trigger for disallowed sender", () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ["alice"], mode: "trigger" },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed("g1", "eve", cfg)).toBe(false);
  });

  it("logs when logDenied is true", () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ["alice"], mode: "trigger" },
      chats: {},
      logDenied: true,
    };
    isTriggerAllowed("g1", "eve", cfg);
    // Logger.debug is called — we just verify no crash; logger is a real pino instance
  });
});

describe("saveSenderAllowlist", () => {
  it("writes config back to file", () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ["alice"], mode: "trigger" },
      chats: { g1: { allow: "*", mode: "drop" } },
      logDenied: false,
    };
    const p = cfgPath("saved.json");
    saveSenderAllowlist(cfg, p);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.default.allow).toEqual(["alice"]);
    expect(loaded.chats["g1"].allow).toBe("*");
    expect(loaded.logDenied).toBe(false);
  });

  it("overwrites existing file", () => {
    const p = writeConfig(
      { default: { allow: "*", mode: "trigger" }, chats: {}, logDenied: true },
      "overwrite.json",
    );
    const newCfg: SenderAllowlistConfig = {
      default: { allow: ["bob"], mode: "drop" },
      chats: {},
      logDenied: false,
    };
    saveSenderAllowlist(newCfg, p);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.default.allow).toEqual(["bob"]);
    expect(loaded.default.mode).toBe("drop");
    expect(loaded.logDenied).toBe(false);
  });

  it("creates file if it does not exist", () => {
    const p = cfgPath("new-file.json");
    expect(fs.existsSync(p)).toBe(false);
    const cfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "trigger" },
      chats: {},
      logDenied: true,
    };
    saveSenderAllowlist(cfg, p);
    expect(fs.existsSync(p)).toBe(true);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.default.allow).toBe("*");
  });
});

describe("addAllowlistEntry", () => {
  it("adds a new chat entry and persists to disk", () => {
    const p = cfgPath("add-test.json");
    const initialCfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "trigger" },
      chats: {},
      logDenied: true,
    };
    saveSenderAllowlist(initialCfg, p);

    addAllowlistEntry("slack:gidc:U999", { allow: ["U999"], mode: "trigger" }, p);

    const loaded = loadSenderAllowlist(p);
    expect(loaded.chats["slack:gidc:U999"]).toBeDefined();
    expect(loaded.chats["slack:gidc:U999"].allow).toEqual(["U999"]);
    expect(loaded.chats["slack:gidc:U999"].mode).toBe("trigger");
  });

  it("overwrites existing entry for same JID", () => {
    const p = cfgPath("overwrite-add-test.json");
    const initialCfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "trigger" },
      chats: { "slack:gidc:U999": { allow: ["U999"], mode: "trigger" } },
      logDenied: true,
    };
    saveSenderAllowlist(initialCfg, p);

    addAllowlistEntry("slack:gidc:U999", { allow: "*", mode: "drop" }, p);

    const loaded = loadSenderAllowlist(p);
    expect(loaded.chats["slack:gidc:U999"].allow).toBe("*");
    expect(loaded.chats["slack:gidc:U999"].mode).toBe("drop");
  });

  it("preserves other entries", () => {
    const p = cfgPath("preserve-add-test.json");
    const initialCfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "trigger" },
      chats: { "existing:jid": { allow: ["alice"], mode: "trigger" } },
      logDenied: true,
    };
    saveSenderAllowlist(initialCfg, p);

    addAllowlistEntry("new:jid", { allow: "*", mode: "trigger" }, p);

    const loaded = loadSenderAllowlist(p);
    expect(loaded.chats["existing:jid"]).toBeDefined();
    expect(loaded.chats["existing:jid"].allow).toEqual(["alice"]);
  });
});

describe("removeAllowlistEntry", () => {
  it("removes an existing entry and persists", () => {
    const p = cfgPath("remove-test.json");
    const initialCfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "trigger" },
      chats: { "slack:gidc:U999": { allow: ["U999"], mode: "trigger" } },
      logDenied: true,
    };
    saveSenderAllowlist(initialCfg, p);

    const result = removeAllowlistEntry("slack:gidc:U999", p);

    expect(result).toBe(true);
    const loaded = loadSenderAllowlist(p);
    expect(loaded.chats["slack:gidc:U999"]).toBeUndefined();
  });

  it("returns false if entry does not exist", () => {
    const p = cfgPath("noexist-test.json");
    const initialCfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "trigger" },
      chats: {},
      logDenied: true,
    };
    saveSenderAllowlist(initialCfg, p);

    const result = removeAllowlistEntry("nonexistent:jid", p);

    expect(result).toBe(false);
  });

  it("preserves other entries", () => {
    const p = cfgPath("remove-preserve-test.json");
    const initialCfg: SenderAllowlistConfig = {
      default: { allow: "*", mode: "trigger" },
      chats: {
        "jid-to-remove": { allow: ["alice"], mode: "trigger" },
        "jid-to-keep": { allow: ["bob"], mode: "trigger" },
      },
      logDenied: true,
    };
    saveSenderAllowlist(initialCfg, p);

    removeAllowlistEntry("jid-to-remove", p);

    const loaded = loadSenderAllowlist(p);
    expect(loaded.chats["jid-to-remove"]).toBeUndefined();
    expect(loaded.chats["jid-to-keep"]).toBeDefined();
    expect(loaded.chats["jid-to-keep"].allow).toEqual(["bob"]);
  });
});

describe("listAllowlistEntries", () => {
  it("returns all chat entries", () => {
    const p = writeConfig(
      {
        default: { allow: "*", mode: "trigger" },
        chats: {
          "jid-one": { allow: ["alice"], mode: "trigger" },
          "jid-two": { allow: "*", mode: "drop" },
        },
        logDenied: true,
      },
      "list-test.json",
    );

    const entries = listAllowlistEntries(p);

    expect(Object.keys(entries)).toHaveLength(2);
    expect(entries["jid-one"]).toBeDefined();
    expect(entries["jid-one"].allow).toEqual(["alice"]);
    expect(entries["jid-two"]).toBeDefined();
    expect(entries["jid-two"].mode).toBe("drop");
  });

  it("returns empty object when no entries", () => {
    const p = writeConfig(
      {
        default: { allow: "*", mode: "trigger" },
        chats: {},
        logDenied: true,
      },
      "empty-list-test.json",
    );

    const entries = listAllowlistEntries(p);

    expect(entries).toEqual({});
  });

  it("returned object is independent from internal state (shallow copy)", () => {
    const p = writeConfig(
      {
        default: { allow: "*", mode: "trigger" },
        chats: {
          "jid-one": { allow: ["alice"], mode: "trigger" },
        },
        logDenied: true,
      },
      "shallow-copy-test.json",
    );

    const entries = listAllowlistEntries(p);
    // Mutate the returned object
    entries["injected-key"] = { allow: "*", mode: "drop" };

    // Re-read: mutation of returned value should not affect subsequent calls
    const reread = listAllowlistEntries(p);
    expect(reread["injected-key"]).toBeUndefined();
    expect(Object.keys(reread)).toHaveLength(1);
  });
});
