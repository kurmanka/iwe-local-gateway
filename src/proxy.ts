#!/usr/bin/env node
// see DP.SC.034, DP.IWE.005, WP-150 Ф6
// stdio→socket proxy — что Claude Code запускает через .mcp.json.
// Маршрут: Claude Code ←stdio→ proxy ←socket→ daemon.
//
// Инжектирует IWE_AGENT_ID в MCP initialize (clientInfo.name),
// чтобы daemon идентифицировал агента для lock isolation.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SOCKET_PATH =
  process.env.IWE_GATEWAY_SOCKET ??
  path.join(os.homedir(), ".iwe", "gateway.sock");

// I11 (WP-458): a bare "unknown-agent" literal meant any two misconfigured
// sessions shared one lock identity — each thought it was the sole owner and
// could freely re-acquire the other's lock (acquire() treats same-holder as
// idempotent, not collision). Suffix with a per-process UUID so unconfigured
// sessions stay isolated from each other, same as configured ones.
//
// WP-530 Ф19: same collision when IWE_AGENT_ID IS configured — .mcp.json
// sets it as one static literal, shared by every parallel session of that
// vendor. CLAUDE_CODE_SESSION_ID is inherited into this process (confirmed
// live via `ps eww` on running proxy.js instances) and stays stable across
// a proxy restart within one session — unlike a fresh UUID, it can't
// self-collide with the session's own pre-restart lock (daemon.ts drops
// peer-status on disconnect, not the lock itself). Falls back to UUID if
// the variable is absent, same as the unconfigured case above.
// `||`, not `??`: an empty string must fall back too, not just undefined —
// a blank value would silently collapse back to the pre-fix collision.
const SESSION_SUFFIX = process.env.CLAUDE_CODE_SESSION_ID || randomUUID();
const AGENT_ID = process.env.IWE_AGENT_ID
  ? `${process.env.IWE_AGENT_ID}-${SESSION_SUFFIX}`
  : `unknown-agent-${randomUUID().slice(0, 8)}`;

if (!process.env.IWE_AGENT_ID) {
  process.stderr.write(
    `[iwe-gateway-proxy] WARNING: IWE_AGENT_ID not set — using "${AGENT_ID}". ` +
      `Set IWE_AGENT_ID in .mcp.json env.\n`,
  );
}

const socket = net.createConnection(SOCKET_PATH);

socket.on("connect", () => {
  process.stderr.write(
    `[iwe-gateway-proxy] connected agent_id=${AGENT_ID} socket=${SOCKET_PATH}\n`,
  );
});

socket.on("error", (err) => {
  process.stderr.write(
    `[iwe-gateway-proxy] cannot connect to daemon at ${SOCKET_PATH}: ${err.message}\n` +
      `  Start daemon first: iwe-local-gateway-daemon &\n`,
  );
  process.exit(1);
});

// stdin → socket.
// Intercept initialize to inject IWE_AGENT_ID as clientInfo.name.
let stdinBuf = "";
process.stdin.on("data", (chunk: Buffer) => {
  stdinBuf += chunk.toString("utf8");
  let nl: number;
  while ((nl = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, nl).trim();
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as {
        method?: string;
        params?: { clientInfo?: { name?: string } };
      };
      if (msg.method === "initialize" && msg.params?.clientInfo) {
        msg.params.clientInfo.name = AGENT_ID;
      }
      socket.write(JSON.stringify(msg) + "\n", "utf8");
    } catch {
      socket.write(line + "\n", "utf8");
    }
  }
});
process.stdin.on("end", () => socket.end());

// socket → stdout (passthrough).
socket.on("data", (chunk: Buffer) => process.stdout.write(chunk));
socket.on("close", () => process.exit(0));
socket.on("end", () => process.exit(0));
