#!/usr/bin/env node
// see DP.SC.034, DP.IWE.005, WP-150 Ф6
// Daemon: единственный процесс с одним LockManager, слушает на Unix socket.
// Все peer-агенты подключаются к этому процессу → lock state разделяется.
//
// Start: iwe-local-gateway-daemon &
// Stop:  kill $(cat <dirname(SOCKET_PATH)>/gateway.pid)   or   SIGTERM / Ctrl-C
// Socket: ~/.iwe/gateway.sock by default, overridden via IWE_GATEWAY_SOCKET
//         (the pid file always lives next to the socket, see daemon-paths.ts)

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { LockManager } from "./lock-manager.js";
import { PeerStatusManager } from "./peer-status-manager.js";
import { metrics } from "./metrics-manager.js";
import { registerTools } from "./tools.js";
import { SocketTransport } from "./socket-transport.js";
import { resolveDaemonPaths } from "./daemon-paths.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

// Lifecycle events used to go to stderr with no timestamp, so the launchd
// stderr file grew into a megabyte of "connected/disconnected" lines that
// looked like a fault stream and could not answer "when" (WP-499, 2026-08-03).
// Info goes to stdout, only real faults to stderr, both timestamped.
function logInfo(message: string): void {
  process.stdout.write(`${new Date().toISOString()} [iwe-local-gateway] ${message}\n`);
}
function logError(message: string): void {
  process.stderr.write(`${new Date().toISOString()} [iwe-local-gateway] ${message}\n`);
}

const { socketPath: SOCKET_PATH, pidPath: PID_PATH } = resolveDaemonPaths(
  process.env.IWE_GATEWAY_SOCKET,
  os.homedir(),
);

// Shared state across all connected agents. The fencing state file keeps
// tokens monotonic across daemon restarts (same dir as socket/pid).
const sharedLocks = new LockManager(path.join(path.dirname(SOCKET_PATH), "gateway-fencing.seq"));
const sharedPeerStatus = new PeerStatusManager();

// Keep metrics.active_locks in sync when TTL silently drops a lock.
sharedLocks.onExpiry = (file) => metrics.recordRelease(file);

// I14 (WP-458): make TTL-takeover visible instead of indistinguishable from a fresh acquire.
sharedLocks.onTtlTakeover = (file, previousHolder, newHolder) =>
  metrics.recordTtlTakeover(file, previousHolder.holder, newHolder);

fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });

// A live process on the other end of an existing socket file means a second
// daemon is racing to start on the same path — unlinking it would split-brain
// two independent LockManagers (issues/1). A stale file from a previous run
// has no listener, so the connect attempt fails and we fall through to unlink.
await new Promise<void>((resolve) => {
  const probe = net.connect(SOCKET_PATH);
  const fail = () => { probe.destroy(); resolve(); };
  probe.setTimeout(300, fail);
  probe.once("error", fail);
  probe.once("connect", () => {
    probe.destroy();
    logError(`refusing to start: a live daemon already listens on ${SOCKET_PATH}`);
    process.exit(1);
  });
});

try { fs.unlinkSync(SOCKET_PATH); } catch { /* not present — fine */ }

let activeConnections = 0;

const netServer = net.createServer(async (socket) => {
  // Per-connection agent identity captured from MCP initialize clientInfo.name
  // (proxy.ts injects IWE_AGENT_ID there before forwarding to daemon).
  // I11 (WP-458): unique fallback — a bare "unknown-agent" let two connections
  // that both failed to send clientInfo.name silently share one lock identity.
  let agentId = `unknown-agent-${randomUUID().slice(0, 8)}`;

  const mcpServer = new Server(
    { name: "iwe-local-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  registerTools(mcpServer, sharedLocks, () => agentId, sharedPeerStatus, metrics);

  const transport = new SocketTransport(socket);

  // Install intercept BEFORE connect() — no race window.
  // When SDK calls `transport.onmessage = handler` inside connect(), our setter
  // wraps the handler to peek at initialize and capture clientInfo.name as agentId.
  let _onmessage: typeof transport.onmessage;
  Object.defineProperty(transport, "onmessage", {
    get() { return _onmessage; },
    set(fn: typeof transport.onmessage) {
      _onmessage = fn
        ? <T extends JSONRPCMessage>(msg: T) => {
            const m = msg as { method?: string; params?: { clientInfo?: { name?: string } } };
            if (m.method === "initialize" && m.params?.clientInfo?.name) {
              agentId = m.params.clientInfo.name;
              logInfo(`agent connected: ${agentId}`);
            }
            fn(msg);
          }
        : fn;
    },
    configurable: true,
  });

  await mcpServer.connect(transport);

  activeConnections++;
  metrics.setActiveAgents(activeConnections);

  transport.onclose = () => {
    activeConnections = Math.max(0, activeConnections - 1);
    sharedPeerStatus.remove(agentId);
    metrics.setActiveAgents(activeConnections);
    logInfo(`agent disconnected: ${agentId}`);
  };
});

netServer.listen(SOCKET_PATH, () => {
  // I8 (WP-458): Node's default listen() leaves the socket at umask-derived
  // perms (0755 on this machine — verified live) — group/other could connect,
  // not just this OS user. "Изоляция на ФС" only holds if the FS perms are
  // actually owner-only; they weren't. Same-user process impersonation
  // (ВЫ-9, spoofable clientInfo.name) is a separate, unresolved design
  // question — this only closes the cross-OS-user vector.
  fs.chmodSync(SOCKET_PATH, 0o600);
  logInfo(`daemon started pid=${process.pid} socket=${SOCKET_PATH}`);
});

fs.writeFileSync(PID_PATH, String(process.pid), "utf8");
// I10 (WP-458): PID file is security-relevant — keep it owner-only.
try { fs.chmodSync(PID_PATH, 0o600); } catch { /* ignore */ }

function shutdown() {
  netServer.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  try { fs.unlinkSync(PID_PATH); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
