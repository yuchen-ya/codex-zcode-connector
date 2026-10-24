import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { describeRuns } from '../lib/runs.js'
import { collectStatus } from '../lib/status.js'
import { summarizeStatus } from '../lib/summaries.js'
import { listRecordedTasks } from '../lib/tasks.js'

test('runs exposes only current connector tasks and their subagents, never global project records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-zcode-privacy-'))
  const config = { workspace: join(directory, 'projectA'), home: join(directory, 'zcode'), tasksDir: join(directory, 'state', 'tasks'), debugPort: 9333 }
  try {
    mkdirSync(config.tasksDir, { recursive: true })
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(config.tasksDir, `session_a${index}.json`), JSON.stringify({
        sessionId: `session_a${index}`, ...config, event: { status: index === 0 ? 'running' : 'completed', reply: 'PRIVATE_RESULT' }, updatedAt: 100 - index,
      }))
    }
    writeFileSync(join(config.tasksDir, 'session_other.json'), JSON.stringify({ sessionId: 'session_other', ...config, workspace: join(directory, 'projectB'), event: { status: 'running', reply: 'OTHER_PROJECT_SECRET' } }))
    for (const sessionId of ['session_a0', 'session_other', 'session_unrecorded']) {
      const path = join(config.home, 'cli', 'agents', sessionId, 'agent_worker')
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'metadata.json'), JSON.stringify({ parentSessionId: sessionId, status: 'running', profileId: sessionId === 'session_a0' ? 'reviewer' : 'OTHER_PROJECT_SECRET' }))
    }
    mkdirSync(join(config.home, 'v2'), { recursive: true })
    writeFileSync(join(config.home, 'v2', 'tasks-index.sqlite'), 'GLOBAL_INDEX_MUST_NOT_BE_READ')
    const result = describeRuns(config, { limit: 3 })
    assert.equal(result.tasks.length, 3)
    assert.equal(result.counts.tasks, 5)
    assert.equal(result.agents.length, 1)
    assert.equal(result.agents[0].role, 'reviewer')
    assert.doesNotMatch(JSON.stringify(result), /OTHER_PROJECT_SECRET|PRIVATE_RESULT|GLOBAL_INDEX|projectB/)
    assert.equal(listRecordedTasks({ ...config, debugPort: 9334 }).length, 0)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('status never reads credentials or exposes account/path data; cached quota is opt-in', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-zcode-status-'))
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async url => {
    requests.push(url)
    return { ok: true, json: async () => ({ 'User-Agent': 'ZCode/3.16.3' }) }
  }
  try {
    mkdirSync(join(directory, 'v2', 'logs'), { recursive: true })
    writeFileSync(join(directory, 'v2', 'credentials.json'), 'INVALID_PRIVATE_CREDENTIALS_MUST_NOT_BE_READ')
    const day = new Date()
    const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    writeFileSync(join(directory, 'v2', 'logs', `${stamp}.log`), `[2026-10-24 12:00:00] billing/balance ${JSON.stringify({ payload: { account: 'PRIVATE_ACCOUNT', data: { balances: [{ available_units: 8, total_units: 10, used_units: 2, unit_type: 'token', plan_id: 'PRIVATE_PLAN', show_name: 'PRIVATE_NAME{test}' }] } } })}\n`)
    const config = { home: directory, workspace: 'PRIVATE_WORKSPACE', debugPort: 9333 }
    const status = await collectStatus(config)
    assert.equal(status.cdp.reachable, true)
    assert.equal(status.quota, undefined)
    const quota = await collectStatus(config, { quota: true })
    assert.equal(quota.quota.balances[0].availableUnits, 8)
    assert.doesNotMatch(JSON.stringify(quota) + summarizeStatus(quota), /PRIVATE_|credentials|accountToken/)
    assert.ok(requests.every(url => url === 'http://127.0.0.1:9333/json/version'))
  } finally {
    globalThis.fetch = originalFetch
    rmSync(directory, { recursive: true })
  }
})

test('MCP backup contains only the connector tables, not other Codex secrets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-zcode-backup-'))
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))
  const execute = promisify(execFile)
  const env = { ...process.env, CODEX_HOME: directory, ZCODE_STATE_DIR: join(directory, 'state') }
  try {
    const original = 'model = "keep"\n\n[mcp_servers.other]\ncommand = "other"\n[mcp_servers.other.env]\nPRIVATE_SERVICE_PASSWORD = "DO_NOT_COPY_THIS_VALUE"\n'
    writeFileSync(join(directory, 'config.toml'), original)
    await execute(process.execPath, [cli, 'install', '--mcp'], { env })
    await execute(process.execPath, [cli, 'uninstall'], { env })
    const backups = join(directory, 'backups', 'codex-zcode-connector')
    const names = readdirSync(backups)
    assert.equal(names.length, 1)
    const backup = readFileSync(join(backups, names[0]), 'utf8')
    assert.match(backup, /\[mcp_servers\.zcode\]/)
    assert.doesNotMatch(backup, /DO_NOT_COPY|PRIVATE_SERVICE|mcp_servers\.other/)
    assert.equal(readFileSync(join(directory, 'config.toml'), 'utf8'), original)
  } finally {
    rmSync(directory, { recursive: true })
  }
})
