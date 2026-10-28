import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../lib/config.js'

const config = loadConfig()
const server = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))
const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
const pending = new Map()
let nextId = 0

function rejectPending(error) {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
  pending.clear()
}
child.on('error', rejectPending)
child.on('exit', code => rejectPending(new Error(`MCP server exited with code ${code}`)))
createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  clearTimeout(request.timer)
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
})

function request(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 300_000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function call(name, args = {}) {
  const result = await request('tools/call', { name, arguments: args })
  if (result.isError) throw new Error(result.content[0].text)
  return result
}

try {
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-zcode-smoke', version: '0.6.0' } })
  assert.equal(initialized.serverInfo.name, 'codex-zcode-connector')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tools = await request('tools/list')
  assert.deepEqual(tools.tools.map(t => t.name), ['zcode_workspaces', 'zcode_status', 'zcode_runs', 'zcode_models', 'zcode_select_model', 'zcode_ask', 'zcode_task'])
  const status = await call('zcode_status')
  console.log(status.content[0].text)
  const workspaces = await call('zcode_task', { action: 'workspaces' })
  console.log(`Workspaces: ${workspaces.structuredContent.workspaces.length} local projects`)
  const inspection = (await call('zcode_task', { action: 'inspect' })).structuredContent
  assert.ok(inspection.models.providers.length > 0)
  assert.ok(inspection.permission.mode)
  assert.ok(inspection.current.path)
  console.log(`Inspection: ${inspection.models.providers.length} providers; permission=${inspection.permission.mode}; execution=${inspection.connector.taskExecution}`)
  if (config.workspace) {
    const runs = await call('zcode_runs', { workspace: config.workspace, limit: 3 })
    console.log(`Background snapshot: ${runs.structuredContent.agents.length} agent records returned`)
  }
  if (process.argv.includes('--ask')) {
    assert.equal(status.structuredContent.cdp.reachable, true, 'Start the ZCode debug instance first')
    assert.ok(config.workspace, 'Set ZCODE_WORKSPACE to an authorized test directory')
    const name = `.codex-zcode-smoke-${randomUUID()}.txt`
    const path = join(config.workspace, name)
    const expected = `CODEX_ZCODE_${randomUUID()}`
    writeFileSync(path, expected, { flag: 'wx' })
    try {
      const result = await call('zcode_ask', { workspace: config.workspace, prompt: `连接验证：只使用 Read 工具读取当前项目根目录的 ${name}，逐字回复文件内容。禁止其他工具、子智能体、网络、电脑操作和修改文件。` })
      assert.equal(result.structuredContent.reply, expected)
      console.log('PASS: ZCode read the workspace challenge and returned its exact contents through MCP')
    } finally {
      unlinkSync(path)
    }
  }
  console.log('PASS: stdio MCP handshake, tool scope, status and workspace discovery')
} finally {
  child.stdin.end()
  rejectPending(new Error('Smoke test finished'))
}
