import { describe, it, expect, beforeEach } from "vitest";
import { LockManager } from "../src/lock-manager.js";

describe("LockManager", () => {
  let lm: LockManager;
  beforeEach(() => {
    lm = new LockManager();
  });

  it("acquire returns lock on free file", () => {
    const r = lm.acquire("/tmp/foo.py", "claude");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lock.holder).toBe("claude");
      expect(r.lock.file).toBe("/tmp/foo.py");
    }
  });

  it("second acquire by different holder → collision", () => {
    lm.acquire("/tmp/foo.py", "claude");
    const r = lm.acquire("/tmp/foo.py", "kimikode");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.holder.holder).toBe("claude");
  });

  it("re-acquire by same holder is idempotent (success)", () => {
    lm.acquire("/tmp/foo.py", "claude");
    const r = lm.acquire("/tmp/foo.py", "claude");
    expect(r.ok).toBe(true);
  });

  it("release by holder works", () => {
    lm.acquire("/tmp/foo.py", "claude");
    const r = lm.release("/tmp/foo.py", "claude");
    expect(r.ok).toBe(true);
    expect(r.released).toBe(true);
  });

  it("release by non-holder → not_held_by_caller", () => {
    lm.acquire("/tmp/foo.py", "claude");
    const r = lm.release("/tmp/foo.py", "kimikode");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_held_by_caller");
  });

  it("after release, other holder can acquire", () => {
    lm.acquire("/tmp/foo.py", "claude");
    lm.release("/tmp/foo.py", "claude");
    const r = lm.acquire("/tmp/foo.py", "kimikode");
    expect(r.ok).toBe(true);
  });

  it("status returns active locks", () => {
    lm.acquire("/tmp/foo.py", "claude");
    lm.acquire("/tmp/bar.py", "kimikode");
    const s = lm.status();
    expect(s.locks).toHaveLength(2);
  });

  it("path canonicalization: same file via ~ and absolute", () => {
    const home = process.env.HOME ?? "/tmp";
    const r1 = lm.acquire(`${home}/x.py`, "claude");
    expect(r1.ok).toBe(true);
    const r2 = lm.acquire("~/x.py", "kimikode");
    expect(r2.ok).toBe(false);
  });

  it("expired lock auto-pruned on next acquire", async () => {
    lm.acquire("/tmp/foo.py", "claude", 10); // 10ms TTL
    await new Promise((r) => setTimeout(r, 20));
    const r = lm.acquire("/tmp/foo.py", "kimikode");
    expect(r.ok).toBe(true);
  });

  it("status() prunes expired locks without acquire", async () => {
    lm.acquire("/tmp/foo.py", "claude", 10); // 10ms TTL
    await new Promise((r) => setTimeout(r, 20));
    const s = lm.status();
    expect(s.locks).toHaveLength(0);
  });

  it("release of non-existent lock returns ok:true released:false", () => {
    const r = lm.release("/tmp/never-locked.py", "claude");
    expect(r.ok).toBe(true);
    expect(r.released).toBe(false);
    expect(r.reason).toBe("no_such_lock");
  });

  it("I14: TTL-takeover by a different holder fires onTtlTakeover with both identities", async () => {
    const takeovers: Array<{ file: string; from: string; to: string }> = [];
    lm.onTtlTakeover = (file, previousHolder, newHolder) =>
      takeovers.push({ file, from: previousHolder.holder, to: newHolder });

    lm.acquire("/tmp/foo.py", "claude", 10); // 10ms TTL
    await new Promise((r) => setTimeout(r, 20));
    lm.acquire("/tmp/foo.py", "kimikode");

    expect(takeovers).toHaveLength(1);
    expect(takeovers[0].from).toBe("claude");
    expect(takeovers[0].to).toBe("kimikode");
  });

  it("I14: same-holder heartbeat re-acquire is NOT a takeover", () => {
    const takeovers: unknown[] = [];
    lm.onTtlTakeover = (...args) => takeovers.push(args);

    lm.acquire("/tmp/foo.py", "claude");
    lm.acquire("/tmp/foo.py", "claude"); // heartbeat refresh, same holder

    expect(takeovers).toHaveLength(0);
  });

  it("I14: fresh acquire on a never-locked file is NOT a takeover", () => {
    const takeovers: unknown[] = [];
    lm.onTtlTakeover = (...args) => takeovers.push(args);

    lm.acquire("/tmp/never-locked.py", "claude");

    expect(takeovers).toHaveLength(0);
  });

  it("fencing: fresh acquires get strictly increasing tokens", () => {
    const a = lm.acquire("/tmp/a.py", "claude");
    const b = lm.acquire("/tmp/b.py", "claude");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.lock.fencingToken).toBeGreaterThan(0);
      expect(b.lock.fencingToken).toBeGreaterThan(a.lock.fencingToken);
    }
  });

  it("fencing: same-holder heartbeat keeps the original token", () => {
    const first = lm.acquire("/tmp/foo.py", "claude");
    const heartbeat = lm.acquire("/tmp/foo.py", "claude");
    expect(first.ok && heartbeat.ok).toBe(true);
    if (first.ok && heartbeat.ok) {
      expect(heartbeat.lock.fencingToken).toBe(first.lock.fencingToken);
    }
  });

  it("fencing: token survives restart monotonically even if the clock went backwards", async () => {
    const os = await import("node:os");
    const fsm = await import("node:fs");
    const pathm = await import("node:path");
    const state = pathm.join(os.tmpdir(), `fencing-test-${process.pid}-${Date.now()}.seq`);
    try {
      const first = new LockManager(state);
      const a = first.acquire("/tmp/a.py", "claude");
      expect(a.ok).toBe(true);
      const tokenA = a.ok ? a.lock.fencingToken : 0;
      // Simulate a clock rollback: persist a state value far in the future,
      // as if the previous process issued tokens past the current clock.
      fsm.writeFileSync(state, String(tokenA + 10_000_000));
      const second = new LockManager(state);
      const b = second.acquire("/tmp/a.py", "claude");
      expect(b.ok).toBe(true);
      if (b.ok) expect(b.lock.fencingToken).toBeGreaterThan(tokenA + 10_000_000);
    } finally {
      fsm.rmSync(state, { force: true });
    }
  });

  it("fencing: TTL takeover issues a strictly greater token than the stale lease", async () => {
    const stale = lm.acquire("/tmp/foo.py", "claude", 10);
    await new Promise((r) => setTimeout(r, 20));
    const fresh = lm.acquire("/tmp/foo.py", "kimikode");
    expect(stale.ok && fresh.ok).toBe(true);
    if (stale.ok && fresh.ok) {
      expect(fresh.lock.fencingToken).toBeGreaterThan(stale.lock.fencingToken);
    }
  });
});
