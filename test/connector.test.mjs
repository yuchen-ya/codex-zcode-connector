import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { codexEntry, updateZCodeConfig } from '../lib/config-file.js'
import { loadConfig } from '../lib/config.js'
import { withComposerLock } from '../lib/control-lock.js'
import { handleRequest } from '../lib/protocol.js'
import { readMainTurnAnswer } from '../lib/zcode.js'
import { resolveModelSelection } from '../lib/model-options.js'

const execFileAsync = promisify(execFile)
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params })

test('MCP exposes the shared CLI capabilities and rejects removed installation tools', async () => {
  const list = await handleRequest(rpc('tools/list'), () => assert.fail('Discovery must not execute a tool'))
  assert.deepEqual(list.result.tools.map(t => t.name), ['zcode_status', 'zcode_runs', 'zcode_models', 'zcode_select_model', 'zcode_ask', 'zcode_task'])
  const removed = await handleRequest(rpc('tools/call', { name: 'zcode_install_skill' }), () => assert.fail('Removed tool executed'))
  assert.equal(removed.error.code, -32602)
})

test('all four provider/model combinations resolve explicitly, defaulting to highest effort', () => {
  const providers = ['account:bigmodel-start-plan', 'account:bigmodel-individual-coding-plan'].map(id => ({
    id, key: `registry-provider:${id}`, label: id,
    models: ['GLM-5.3', 'GLM-5.3-Flash'].map(model => ({ id: model, value: `custom:${encodeURIComponent(id)}:${model}` })),
  }))
  const current = { provider: providers[1].id, model: 'GLM-5.3', effort: 'low' }
  for (const alias of ['start-plan', 'bigmodel']) {
    for (const model of ['GLM-5.3', 'GLM-5.3-Flash']) {
      const selection = resolveModelSelection(providers, current, { provider: alias, model })
      assert.equal(selection.provider, alias === 'start-plan' ? providers[0].id : providers[1].id)
      assert.equal(selection.model, model)
      assert.equal(selection.effort, 'max')
    }
  }
  const unchanged = resolveModelSelection(providers, current, {})
  assert.equal(unchanged.provider, current.provider)
  assert.equal(unchanged.model, current.model)
  assert.equal(unchanged.effort, 'max')
  assert.throws(() => resolveModelSelection(providers, current, { provider: 'missing' }), /provider is unavailable/)
  assert.throws(() => resolveModelSelection(providers, current, { model: 'missing' }), /model is unavailable/)
})

test('model options pass through MCP and invalid options never execute', async () => {
  const args = { prompt: 'test', provider: 'bigmodel', model: 'GLM-5.3', effort: 'max' }
  const result = await handleRequest(rpc('tools/call', { name: 'zcode_ask', arguments: args }), async (name, received) => {
    assert.equal(name, 'zcode_ask')
    assert.deepEqual(received, args)
    return { text: 'ok', structured: { reply: 'ok' } }
  })
  assert.equal(result.result.isError, false)
  for (const options of [{ provider: '' }, { model: 4 }, { effort: 'ultra' }]) {
    const invalid = await handleRequest(rpc('tools/call', { name: 'zcode_select_model', arguments: options }), () => assert.fail('Invalid selection executed'))
    assert.equal(invalid.error.code, -32602)
  }
})

test('CLI shows help without a server and rejects bad commands/options', async () => {
  const cli = new URL('../cli.mjs', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  const help = await execFileAsync(process.execPath, [fileURLToPath(cli), '--help'])
  assert.match(help.stdout, /start-plan, bigmodel/)
  assert.match(help.stdout, /Effort defaults to max/)
  await assert.rejects(execFileAsync(process.execPath, [fileURLToPath(cli), 'unknown']), error => /Unknown command/.test(error.stderr))
  await assert.rejects(execFileAsync(process.execPath, [fileURLToPath(cli), 'select', '--effort', 'ultra']), error => /effort must be/.test(error.stderr))
})

test('invalid arguments are request errors; task failures are tool errors', async () => {
  for (const args of [{ prompt: ' ' }, { prompt: 4 }, { prompt: 'ok', workspace: 'other' }]) {
    const response = await handleRequest(rpc('tools/call', { name: 'zcode_ask', arguments: args }), () => assert.fail('Invalid input executed'))
    assert.equal(response.error.code, -32602)
  }
  const limit = await handleRequest(rpc('tools/call', { name: 'zcode_runs', arguments: { limit: 1.5 } }), () => assert.fail())
  assert.equal(limit.error.code, -32602)
  const failed = await handleRequest(rpc('tools/call', { name: 'zcode_ask', arguments: { prompt: 'ok' } }), async () => { throw new Error('Workspace mismatch') })
  assert.equal(failed.result.isError, true)
  assert.equal(failed.result.content[0].text, 'Workspace mismatch')
})

test('MCP negotiation names this project and notifications never invoke tools', async () => {
  const init = await handleRequest(rpc('initialize', { protocolVersion: '2025-06-18' }), () => assert.fail())
  assert.equal(init.result.serverInfo.name, 'codex-zcode-connector')
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'zcode_ask' } }, () => assert.fail()), null)
  assert.equal((await handleRequest(null, () => assert.fail())).error.code, -32600)
})

test('session_ replies are read only from their own transcript, not a newer unrelated task', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-zcode-transcript-'))
  try {
    const rollout = join(home, 'cli', 'rollout')
    mkdirSync(rollout, { recursive: true })
    const path = join(rollout, 'model-io-session_current.jsonl')
    const record = (querySource, text) => JSON.stringify({ querySource, response: { text } }) + '\n'
    writeFileSync(path, record('main_turn', '登录说明 [1113] 是文本，不应被误判成连接错误') + record('session_title', 'not the answer'))
    writeFileSync(join(rollout, 'model-io-session_other.jsonl'), record('main_turn', 'WRONG SESSION'))
    const expected = '登录说明 [1113] 是文本，不应被误判成连接错误'
    assert.equal(readMainTurnAnswer(new Map(), 'session_current', home), expected)
    assert.equal(readMainTurnAnswer(new Map(), 'session_missing', home), null)
    assert.equal(readMainTurnAnswer(new Map([['model-io-session_current.jsonl', statSync(path).size]]), 'session_current', home), null)
    assert.throws(() => readMainTurnAnswer(new Map(), '../credentials', home), /Invalid ZCode session/)
  } finally {
    rmSync(home, { recursive: true })
  }
})

test('composer lock excludes a second Node process and releases after errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-zcode-lock-'))
  const path = join(directory, 'composer.lock')
  const moduleUrl = new URL('../lib/control-lock.js', import.meta.url).href
  const code = `import { withComposerLock } from ${JSON.stringify(moduleUrl)}; await withComposerLock(process.argv[1], async () => console.log('acquired'))`
  try {
    await withComposerLock(path, async () => {
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid)
      await assert.rejects(execFileAsync(process.execPath, ['--input-type=module', '-e', code, path]), error => /locked by another connector/.test(error.stderr))
    })
    assert.equal(existsSync(path), false)
    assert.equal((await execFileAsync(process.execPath, ['--input-type=module', '-e', code, path])).stdout.trim(), 'acquired')
    await assert.rejects(withComposerLock(path, async () => { throw new Error('task failed') }), /task failed/)
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('configuration keeps runtime outside source and replaces only the zcode tables', () => {
  const config = loadConfig({})
  assert.equal(config.workspace, join(config.stateDir, 'workspace'))
  assert.equal(config.tasksDir, join(config.stateDir, 'tasks'))
  assert.throws(() => loadConfig({ ZCODE_STATE_DIR: 'relative' }), /absolute/)
  assert.throws(() => loadConfig({ ZCODE_DEBUG_PORT: 'not-a-port' }), /ZCODE_DEBUG_PORT/)
  assert.throws(() => loadConfig({ ZCODE_WORKSPACE: 'relative' }), /absolute/)
  const before = 'model = "keep"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.zcode]\ncommand = "old"\n[mcp_servers.zcode.env]\nZCODE_BRIDGE_PORT = "9444"\n\n[features]\nexample = true\n'
  const entry = codexEntry({ nodePath: process.execPath, serverPath: 'E:/path with spaces/mcp/server.mjs', workspace: config.workspace, home: config.home, debugPort: 9333 })
  const after = updateZCodeConfig(before, entry)
  assert.ok(after.includes('[mcp_servers.other]\ncommand = "other"'))
  assert.ok(after.includes('[features]\nexample = true'))
  assert.equal((after.match(/\[mcp_servers\.zcode\]/g) ?? []).length, 1)
  assert.equal(after.includes('ZCODE_BRIDGE_PORT'), false)
  assert.equal(updateZCodeConfig(after, entry), after)
})
