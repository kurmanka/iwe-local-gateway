// see DP.SC.034, DP.SC.035, DP.IWE.005, WP-150 Ф6+Ф7
// Shared tool definitions + registration — используется и daemon.ts (socket), и server.ts (stdio).

import { z } from "zod";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { LockManager } from "./lock-manager.js";
import type { PeerStatusManager } from "./peer-status-manager.js";
import type { metrics as MetricsAPI } from "./metrics-manager.js";

// Держать в синхроне с package.json version при релизе — позволяет пилоту
// и агенту увидеть через gateway_status, что демон отстал от установленного
// пина после апдейта setup-local-gateway.sh (Fable 5 review, Д1, WP-499 Ф16).
export const GATEWAY_VERSION = "0.2.0";

const acquireSchema = z.object({
  file: z.string().min(1, "file required"),
  ttl_seconds: z.number().int().positive().max(3600).optional(),
});

const releaseSchema = z.object({
  file: z.string().min(1, "file required"),
});

const updateStatusSchema = z.object({
  focus: z.string().min(1, "focus required"),
  intent: z.string().min(1, "intent required"),
  awaiting_decision: z.boolean().optional(),
});

export const TOOL_LIST = [
  {
    name: "gateway_status",
    description:
      "Возвращает текущее состояние Local MCP Gateway: список активных file-locks с держателями и временем acquire. Используется peer-агентом для проверки 'кто над чем работает' перед началом редактирования.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "acquire_file_lock",
    description:
      "Pessimistic-lock на запись файла. Возвращает success (с монотонным fencing_token в lock.fencingToken — сохрани и сверь с gateway_status перед финальной записью: другой токен на том же файле = твоя аренда протухла и перевыдана, перечитай файл и возьми lock заново) или collision с info о текущем держателе. TTL по умолчанию 300s (5 минут). Обязателен ПЕРЕД write_file в multi-agent сессии.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Абсолютный путь к файлу" },
        ttl_seconds: {
          type: "number",
          description: "TTL lock'а в секундах (default 300, max 3600)",
        },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "release_file_lock",
    description:
      "Освобождение lock'а после write_file + commit. Можно вызвать только держателю; иначе not_held_by_caller.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Абсолютный путь к файлу" },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "update_peer_status",
    description:
      "Объявить статус агента: что делаю (focus), почему (intent), заблокирован ли. Другие peer-агенты видят эту информацию через list_peer_statuses — координация без lock. Вызывать при начале задачи и по завершении.",
    inputSchema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "Что делает агент (файл или задача)" },
        intent: { type: "string", description: "Контекст: зачем, для какой цели" },
        awaiting_decision: {
          type: "boolean",
          description: "true если агент заблокирован и ждёт решения пилота",
        },
      },
      required: ["focus", "intent"],
      additionalProperties: false,
    },
  },
  {
    name: "list_peer_statuses",
    description:
      "Список статусов всех peer-агентов: кто над чем работает, кто заблокирован. Вызывать перед началом работы для проверки намерений других агентов (coordination без lock).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

function text(obj: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function err(obj: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
  };
}

export function registerTools(
  server: Server,
  lockManager: LockManager,
  getAgentId: () => string,
  peerStatus?: PeerStatusManager,
  gatewayMetrics?: typeof MetricsAPI,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_LIST,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const agentId = getAgentId();

    if (name === "gateway_status") {
      return text({ agent_id: agentId, gateway_version: GATEWAY_VERSION, ...lockManager.status() });
    }

    if (name === "acquire_file_lock") {
      const parsed = acquireSchema.safeParse(args);
      if (!parsed.success) return err(`invalid_arguments: ${parsed.error.message}`);
      const result = lockManager.acquire(
        parsed.data.file,
        agentId,
        (parsed.data.ttl_seconds ?? 300) * 1000,
      );
      if (result.ok) {
        gatewayMetrics?.recordAcquire(result.lock.file);
        return text(result);
      }
      // Collision is a normal business response (file is busy), not a protocol error.
      gatewayMetrics?.recordCollision();
      return text({
        ok: false,
        status: "lock_collision",
        holder: result.holder.holder,
        expires_at: new Date(result.holder.expiresAt).toISOString(),
      });
    }

    if (name === "release_file_lock") {
      const parsed = releaseSchema.safeParse(args);
      if (!parsed.success) return err(`invalid_arguments: ${parsed.error.message}`);
      const result = lockManager.release(parsed.data.file, agentId);
      if (!result.ok) return { isError: true, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      if (result.released) gatewayMetrics?.recordRelease(parsed.data.file);
      return text(result);
    }

    if (name === "update_peer_status") {
      if (!peerStatus) return err("peer_status_not_available: run in daemon mode");
      const parsed = updateStatusSchema.safeParse(args);
      if (!parsed.success) return err(`invalid_arguments: ${parsed.error.message}`);
      const status = peerStatus.update(
        agentId,
        parsed.data.focus,
        parsed.data.intent,
        parsed.data.awaiting_decision ?? false,
      );
      return text({ ok: true, status });
    }

    if (name === "list_peer_statuses") {
      if (!peerStatus) return err("peer_status_not_available: run in daemon mode");
      return text({ statuses: peerStatus.list() });
    }

    return err(`tool_not_available: ${name}`);
  });
}
