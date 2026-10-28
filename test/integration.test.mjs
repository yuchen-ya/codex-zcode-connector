import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { validateInteractionAnswer } from '../lib/interactions.js'
import { handleRequest } from '../lib/protocol.js'
import { waitTask } from '../lib/tasks.js'
import { callTool } from '../lib/tools.js'
import { loadConfig } from '../lib/config.js'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))

test('skill install, optional MCP migration and uninstall preserve other Codex settings', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-zcode-install-'))
  const env = { ...process.env, CODEX_HOME: home, ZCODE_WORKSPACE: join(home, 'workspace'), ZCODE_STATE_DIR: join(home, 'state') }
  const run = (...args) => execute(process.execPath, [cli, ...args], { env })
  const config = join(home, 'config.toml')
  const skill = join(home, 'skills', 'codex-zcode-connector')
  const original = 'model = "keep"\n\n[mcp_servers.other]\ncommand = "other"\n'
  try {
    writeFileSync(config, original)
    await run('install')
    assert.equal(readFileSync(config, 'utf8'), original)
    assert.ok(existsSync(join(skill, 'SKILL.md')))
    const runner = await execute(process.execPath, [join(skill, 'scripts', 'zcode.mjs'), '--help'], { env })
    assert.match(runner.stdout, /delegate/)
    await run('install', '--mcp')
    const registered = readFileSync(config, 'utf8')
    assert.match(registered, /enabled_tools = \["zcode_task"\]/)
    await run('install', '--mcp')
    assert.equal(readFileSync(config, 'utf8'), registered)
    await run('install')
    assert.equal(readFileSync(config, 'utf8'), original)
    await run('uninstall')
    await run('uninstall')
    assert.equal(existsSync(skill), false)
    assert.equal(readFileSync(config, 'utf8'), original)
    assert.equal(existsSync(env.ZCODE_WORKSPACE), false, 'installation must not create project directories')
  } finally {
    rmSync(home, { recursive: true })
  }
})

test('installer rejects foreign names; uninstall preserves modified skill files and replaced MCP entries', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-zcode-preserve-'))
  const env = { ...process.env, CODEX_HOME: home, ZCODE_WORKSPACE: join(home, 'workspace'), ZCODE_STATE_DIR: join(home, 'state') }
  const run = (...args) => execute(process.execPath, [cli, ...args], { env })
  const config = join(home, 'config.toml')
  const skill = join(home, 'skills', 'codex-zcode-connector')
  try {
    const foreign = '[mcp_servers.zcode]\ncommand = "someone-else"\n'
    writeFileSync(config, foreign)
    await assert.rejects(run('install', '--mcp'), error => /owned by another/.test(error.stderr))
    assert.equal(existsSync(skill), false)
    await run('install')
    assert.equal(readFileSync(config, 'utf8'), foreign)
    writeFileSync(join(skill, 'SKILL.md'), 'personal edits')
    await assert.rejects(run('install'), error => /modified skill file/.test(error.stderr))
    await run('uninstall')
    assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8'), 'personal edits')
    assert.equal(readFileSync(config, 'utf8'), foreign)
  } finally {
    rmSync(home, { recursive: true })
  }
})

test('interactive answers require actual permission option IDs and complete question answers', () => {
  const permission = { payload: { kind: 'permission', options: [{ optionId: 'allowOnce' }, { optionId: 'deny' }] } }
  validateInteractionAnswer(permission, { optionId: 'allowOnce' })
  validateInteractionAnswer(permission, { optionId: 'deny' })
  assert.throws(() => validateInteractionAnswer(permission, { optionId: 'fullAccess' }), /exact permission/)
  assert.throws(() => validateInteractionAnswer(permission, { optionId: 'allowOnce', freeText: 'x' }), /not allowed/)
  const questions = { payload: { kind: 'userInput', questions: [{ question: 'Which?' }] } }
  validateInteractionAnswer(questions, { action: 'accept', content: { answers: { 'Which?': 'BETA' } } })
  assert.throws(() => validateInteractionAnswer(questions, { action: 'accept', content: { answers: {} } }), /Missing answer/)
  const freeText = { payload: { kind: 'userInput', freeText: true } }
  validateInteractionAnswer(freeText, { freeText: 'answer' })
  assert.throws(() => validateInteractionAnswer(freeText, { optionId: 'imaginary' }), /valid optionId/)
  assert.throws(() => validateInteractionAnswer({ payload: { kind: 'workspaceHookReview' } }, {}), /directly in ZCode/)
})

test('task wait returns durable completion without a live connection and rejects another workspace', async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'codex-zcode-task-'))
  const config = { tasksDir, workspace: tasksDir, debugPort: 1, home: tasksDir }
  try {
    writeFileSync(join(tasksDir, 'session_example.json'), JSON.stringify({
      sessionId: 'session_example', workspace: tasksDir, debugPort: 1, home: tasksDir,
      event: { status: 'completed', reply: 'finished' }, model: 'GLM-5.3', effort: 'max',
    }))
    assert.equal((await waitTask('session_example', config)).reply, 'finished')
    const receipt = await waitTask('session_example', { ...config, workspace: null })
    assert.equal(receipt.workspace, tasksDir, 'wait must retain the recorded workspace without a default')
    const response = await callTool('zcode_task', { action: 'wait', taskId: 'session_example' }, { ...config, workspace: join(tasksDir, 'configured-default') })
    assert.equal(response.structured.workspace, tasksDir, 'configured defaults must not redirect an existing task')
    await assert.rejects(waitTask('session_example', { ...config, workspace: join(tasksDir, 'other') }), /different workspace/)
    await assert.rejects(waitTask('../escape', config), /Invalid task ID/)
  } finally {
    rmSync(tasksDir, { recursive: true })
  }
})

test('MCP validates task actions before execution', async () => {
  for (const args of [{ action: 'start' }, { action: 'inspect', workspace: tmpdir() }, { action: 'wait', taskId: '../bad' }, { action: 'wait', taskId: 'session_example', timeout: 61 }, { action: 'reply', taskId: 'session_example', requestId: 'r' }, { action: 'wait', taskId: 'session_example', prompt: 'wrong action' }]) {
    const result = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zcode_task', arguments: args } }, () => assert.fail('Invalid action executed'))
    assert.equal(result.error.code, -32602)
  }
})

test('new tasks require an explicit workspace; nonexistent targets never become projects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-zcode-workspaces-'))
  const missing = join(directory, 'missing-project')
  const config = loadConfig({ ZCODE_STATE_DIR: join(directory, 'state'), ZCODE_DEBUG_PORT: '1' })
  try {
    await assert.rejects(callTool('zcode_task', { action: 'start', prompt: 'test' }, config), /Workspace required/)
    await assert.rejects(callTool('zcode_task', { action: 'start', prompt: 'test', workspace: missing }, config), error => error.code === 'ENOENT' && error.path === missing)
    assert.equal(existsSync(missing), false)
    const env = { ...process.env, ZCODE_STATE_DIR: config.stateDir }
    delete env.ZCODE_WORKSPACE
    await assert.rejects(execute(process.execPath, [cli, 'launch'], { env }), error => /Specify --workspace/.test(error.stderr))
    assert.equal(existsSync(join(config.stateDir, 'workspace')), false)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('MCP supports workspace discovery and per-call workspace selection', async () => {
  for (const [name, args] of [
    ['zcode_workspaces', {}],
    ['zcode_task', { action: 'inspect' }],
    ['zcode_task', { action: 'workspaces' }],
    ['zcode_task', { action: 'start', prompt: 'test', workspace: tmpdir() }],
  ]) {
    const result = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, async (receivedName, receivedArgs) => {
      assert.equal(receivedName, name)
      assert.deepEqual(receivedArgs, args)
      return { text: 'ok', structured: {} }
    })
    assert.equal(result.result.isError, false)
  }
})

test('inspection discovers live choices without changing the composer or exposing its contents', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-zcode-inspect-'))
  const snapshot = { sessionId: 'session_fixture', control: { canStop: true }, pendingInteractions: [{ payload: 'PRIVATE_QUESTION' }] }
  const projectService = { readProjects: async () => [
    { id: 'local-project', name: 'Project', hostId: 'local', roots: [{ isPrimary: true, rootPath: directory }] },
    { id: 'removed', name: 'Deleted', hostId: 'local', deleted: true },
    { id: 'remote', name: 'Remote', hostId: 'remote' },
  ] }
  const root = { memoizedProps: { workspacePath: directory, value: { projectService }, snapshot }, return: null }
  const editor = { '__reactFiber$fixture': root, innerText: 'PRIVATE_DRAFT' }
  const pane = { dataset: { sessionId: snapshot.sessionId } }
  const marker = { dataset: { provider: 'fixture-provider', model: 'LIVE-MODEL', thought: 'high', thoughtLevels: 'low,high,max' } }
  const modelTrigger = { '__reactFiber$fixture': { memoizedProps: { modelGroups: [
    { key: 'registry-provider:fixture-provider', label: 'Live provider', items: [{ name: 'LIVE-MODEL', value: 'native-model-value', supportsVisionInput: true }] },
  ] }, return: null } }
  const permissionTrigger = { innerText: 'Require approval', '__reactFiber$fixture': { memoizedProps: { draftConfig: { mode: 'ask' } }, return: null } }
  const elements = new Map([
    ['div[role="textbox"][contenteditable="true"]', editor],
    ['[data-testid="v4-session-pane-workspace-main"]', pane],
    ['[data-testid="v4-model-config"][data-source="composer"]', marker],
    ['[data-testid="chat-model-select-trigger"]', modelTrigger],
    ['[data-testid="chat-mode-select-trigger"]', permissionTrigger],
  ])
  const context = { document: { querySelector: selector => elements.get(selector) } }
  const commands = []
  class ReadOnlySocket extends EventTarget {
    readyState = 1
    constructor() {
      super()
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    send(message) {
      const { id, method, params } = JSON.parse(message)
      commands.push(method)
      assert.equal(method, 'Runtime.evaluate', 'inspection must not send UI input or commands')
      void (async () => {
        const value = await runInNewContext(params.expression, context)
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result: { result: { value } } }) }))
      })()
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'http://127.0.0.1:9333/json/list')
    return { ok: true, json: async () => [{ type: 'page', url: 'file:///renderer/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/renderer' }] }
  })
  const originalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = ReadOnlySocket
  try {
    const config = loadConfig({})
    const { structured: result } = await callTool('zcode_task', { action: 'inspect' }, config)
    assert.equal(result.current.path, directory)
    assert.deepEqual(result.workspaces.map(project => project.id), ['local-project'])
    assert.equal(result.models.providers[0].models[0].id, 'LIVE-MODEL')
    assert.equal(result.models.providers[0].models[0].vision, true)
    assert.deepEqual(result.permission, { mode: 'ask', label: 'Require approval' })
    assert.equal(result.conversation.busy, true)
    assert.equal(result.conversation.pendingInputCount, 1)
    assert.equal(result.conversation.hasDraft, true)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|native-model-value/)
    assert.equal(result.connector.taskExecution, 'serial')
    pane.dataset.sessionId = 'draft'
    editor.innerText = ''
    root.memoizedProps.composerDraft = { attachments: ['PRIVATE_ATTACHMENT'] }
    permissionTrigger.__reactFiber$fixture.memoizedProps.draftConfig.mode = 'yolo'
    permissionTrigger.innerText = 'Full access'
    const draft = (await callTool('zcode_task', { action: 'inspect' }, config)).structured
    assert.deepEqual(draft.permission, { mode: 'yolo', label: 'Full access' }, 'draft inspection must report actual permission')
    assert.equal(draft.conversation.busy, false)
    assert.equal(draft.conversation.hasDraft, true, 'attachment-only drafts must be reported')
    assert.equal(editor.innerText, '')
    assert.deepEqual(root.memoizedProps.composerDraft.attachments, ['PRIVATE_ATTACHMENT'])
    assert.ok(commands.length > 0)
  } finally {
    globalThis.WebSocket = originalWebSocket
    rmSync(directory, { recursive: true })
  }
})
