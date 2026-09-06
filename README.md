# iwe-local-gateway

Local MCP Gateway для multi-agent IWE сессии в VS Code.

**Pack:** [DP.SC.034](../../PACK-digital-platform/pack/digital-platform/08-service-clauses/DP.SC.034-local-mcp-gateway.md) · [DP.IWE.005](../../PACK-digital-platform/pack/digital-platform/02-domain-entities/DP.IWE.005-local-gateway.md)

**Не путать с [gateway-mcp](../gateway-mcp/)** (Aisystant MCP cloud, `mcp.aisystant.com`, multi-tenant HTTPS) — это **локальный** in-process слой для координации peer-агентов в одной VS Code сессии. См. различение в `~/IWE/.claude/rules/distinctions.md`.

## Что делает

Координирует write-операции между peer-агентами (Claude Code, Kimi Code и др.), работающими над одним workspace:

- `gateway_status` — список активных file-locks с держателями
- `acquire_file_lock` — pessimistic-lock на файл (TTL 5 мин по умолчанию)
- `release_file_lock` — освобождение lock'а после commit

## Статус реализации

- ✅ **Unix socket daemon** — единственный процесс, shared lock state (реальный multi-agent)
- ✅ **stdio proxy** — мост stdio↔socket для подключения Claude Code / Kimi Code
- ✅ **stdio server** — режим MVP для тестов и single-agent
- ✅ In-memory lock manager с TTL auto-expiry
- ✅ Path canonicalization (`~/foo` ≡ `/Users/x/foo`)
- ✅ Agent identity через env `IWE_AGENT_ID` (daemon capture + proxy inject)
- ⏳ Tool-allowlist per agent — следующая итерация
- ⏳ Upstream-proxy к Aisystant MCP — следующая итерация

## Установка

```bash
cd ~/IWE/DS-MCP/local-gateway
npm install
npm run build
npm test
```

## Подключение к Claude Code (daemon-режим)

**Шаг 1.** Запустить daemon один раз за VS Code сессию:

```bash
node /Users/tserentserenov/IWE/DS-MCP/local-gateway/dist/daemon.js &
# или npm run daemon  (из директории local-gateway)
```

**Шаг 2.** В `.mcp.json` рабочего workspace для каждого агента — proxy:

```json
{
  "mcpServers": {
    "iwe-local-gateway": {
      "command": "node",
      "args": ["/Users/tserentserenov/IWE/DS-MCP/local-gateway/dist/proxy.js"],
      "env": {
        "IWE_AGENT_ID": "claude-code"
      }
    }
  }
}
```

Для Kimikode — отдельный `.mcp.json` с `"IWE_AGENT_ID": "kimikode"`.  
Оба подключаются к одному daemon → один LockManager → shared lock state.

> **Stdio-режим (MVP, legacy):** `dist/server.js` — каждый агент в отдельном процессе без разделения state. Полезен для тестов и одиночного агента.

## Пример использования

```
Claude → acquire_file_lock({file: "src/auth.py"})  → ok
Claude → write src/auth.py                          → ok
Claude → release_file_lock({file: "src/auth.py"})  → ok

Kimi Code → acquire_file_lock({file: "src/auth.py"}) → ok (теперь свободен)
```

При collision (попытка acquire когда другой держит):

```
Kimi Code → acquire_file_lock({file: "src/auth.py"})
  → error: lock_collision, holder: claude, acquired_at: 2026-05-11T16:42:00Z
  → решение: backoff polling ИЛИ переключение на другой файл (см. DP.SC.035 / DP.ROLE.039)
```

## Тесты

```bash
npm test                      # unit tests (vitest): lock-manager + socket-transport
node tests/smoke.mjs          # MCP smoke (stdio, 10 checks)
node tests/daemon-smoke.mjs   # daemon smoke (socket, shared state между 2 агентами)
```

Покрытие unit: lock-manager (11 тестов) + socket-transport (3 теста). Daemon smoke — ключевой интеграционный тест (acquire→collision→release→cross-agent status).

## Связанные документы

- [DP.SC.034](../../PACK-digital-platform/pack/digital-platform/08-service-clauses/DP.SC.034-local-mcp-gateway.md) — обещание Local Gateway
- [DP.SC.035](../../PACK-digital-platform/pack/digital-platform/08-service-clauses/DP.SC.035-peer-agent-choreography.md) — peer-agent choreography поверх Gateway
- [DP.IWE.005](../../PACK-digital-platform/pack/digital-platform/02-domain-entities/DP.IWE.005-local-gateway.md) — Pack-сущность
- [DP.ROLE.039](../../PACK-digital-platform/pack/digital-platform/02-domain-entities/DP.ROLE.039-peer-agent.md) — Peer Agent роль
