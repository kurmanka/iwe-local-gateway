// see DP.SC.034, DP.IWE.005, WP-150 Ф6
// In-memory pessimistic lock manager для координации write-операций
// между peer-агентами в одной VS Code сессии.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export interface Lock {
  file: string;
  holder: string;
  acquiredAt: string; // ISO timestamp
  ttlMs: number;
  expiresAt: number; // epoch ms
  // Monotonic fencing token (WP-530, peer-session 2026-08-30-01): a writer
  // that saved its token at acquire time can detect before the final write
  // that the lock was re-issued to someone else after its TTL expired --
  // without this, a slow holder past its TTL can overwrite the new holder's
  // work with zero signal. Compare against gateway_status: a differing token
  // for the same file means "my lease is stale, re-read and re-acquire".
  fencingToken: number;
}

export interface LockAcquireResult {
  ok: true;
  lock: Lock;
}

export interface LockCollisionResult {
  ok: false;
  reason: "collision";
  holder: Lock;
}

export interface LockReleaseResult {
  ok: boolean;
  released: boolean;
  reason?: "not_held_by_caller" | "no_such_lock";
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes, see DP.IWE.005 §9 Q1

export class LockManager {
  private readonly locks = new Map<string, Lock>();

  // Monotonic across restarts (Codex review, round 3: a bare Date.now() seed
  // breaks on clock rollback, same-ms restarts, and a predecessor that issued
  // tokens past its own seed). Seed = max(clock, persisted_last + 1); every
  // issued token is persisted back. Without a statePath (unit tests) it
  // degrades to the clock seed — process-local monotonicity only.
  private fencingCounter: number;
  private readonly fencingStatePath?: string;

  constructor(fencingStatePath?: string) {
    this.fencingStatePath = fencingStatePath;
    let persisted = 0;
    if (fencingStatePath) {
      try {
        persisted = Number(fs.readFileSync(fencingStatePath, "utf-8").trim()) || 0;
      } catch {
        // First run or unreadable state: fall back to the clock seed below.
      }
    }
    this.fencingCounter = Math.max(Date.now(), persisted + 1);
  }

  private issueFencingToken(): number {
    const token = ++this.fencingCounter;
    if (this.fencingStatePath) {
      try {
        fs.writeFileSync(this.fencingStatePath, String(token));
      } catch (e) {
        // Token stays valid in-process; only restart-monotonicity degrades.
        console.error(`[lock-manager] fencing state write failed: ${e}`);
      }
    }
    return token;
  }

  // Fired when a lock is silently dropped by TTL expiry (not by explicit release).
  // Consumers (e.g. metrics) use this to keep derived counters consistent.
  onExpiry?: (canonicalFile: string) => void;

  // I14 (WP-458, 2026-07-17): fired when acquire() claims a key whose previous
  // lock had JUST expired (this specific acquire pruned it, not a background
  // sweep) and the new holder differs from the old one. Previously this path
  // was indistinguishable from a fresh acquire — a slow holder still mid-write
  // past its TTL could lose the lock to someone else with zero signal anywhere.
  onTtlTakeover?: (
    canonicalFile: string,
    previousHolder: Lock,
    newHolder: string,
  ) => void;

  /**
   * Канонизация пути для устранения /., trailing slash и home expansion.
   * Lock на `~/foo` и `/Users/x/foo` должен быть одним lock'ом.
   */
  private canonicalize(file: string): string {
    let p = file;
    if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
    return path.resolve(p);
  }

  private pruneExpired(now: number = Date.now()): void {
    for (const [key, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(key);
        this.onExpiry?.(key);
      }
    }
  }

  acquire(
    file: string,
    holder: string,
    ttlMs: number = DEFAULT_TTL_MS,
  ): LockAcquireResult | LockCollisionResult {
    const now = Date.now();
    const key = this.canonicalize(file);
    const beforePrune = this.locks.get(key);
    this.pruneExpired(now);
    const existing = this.locks.get(key);
    if (existing && existing.holder !== holder) {
      return { ok: false, reason: "collision", holder: existing };
    }
    if (beforePrune && !existing && beforePrune.holder !== holder) {
      this.onTtlTakeover?.(key, beforePrune, holder);
    }
    // Re-acquire by same holder intentionally refreshes TTL (heartbeat
    // pattern) and KEEPS the token: a heartbeat must not invalidate the
    // token the holder saved at first acquire. A fresh acquire or a TTL
    // takeover issues a new, strictly greater token.
    const fencingToken =
      existing && existing.holder === holder
        ? existing.fencingToken
        : this.issueFencingToken();
    const lock: Lock = {
      file: key,
      holder,
      acquiredAt: new Date(now).toISOString(),
      ttlMs,
      expiresAt: now + ttlMs,
      fencingToken,
    };
    this.locks.set(key, lock);
    return { ok: true, lock };
  }

  release(file: string, holder: string): LockReleaseResult {
    const key = this.canonicalize(file);
    const existing = this.locks.get(key);
    if (!existing) return { ok: true, released: false, reason: "no_such_lock" };
    if (existing.holder !== holder) {
      return { ok: false, released: false, reason: "not_held_by_caller" };
    }
    this.locks.delete(key);
    return { ok: true, released: true };
  }

  status(): { locks: Lock[]; now: string } {
    this.pruneExpired();
    return {
      locks: [...this.locks.values()],
      now: new Date().toISOString(),
    };
  }

  // Test helper — не для прод-кода. Сбрасывает всё состояние.
  clear(): void {
    this.locks.clear();
  }
}
