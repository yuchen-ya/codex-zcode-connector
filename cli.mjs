#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { loadConfig } from './lib/config.js'
import { callTool, validateArguments } from './lib/tools.js'
import { installConnector, uninstallConnector } from './lib/install.js'

const HELP = `codex-zcode - operate ZCode through local CDP

Usage: node cli.mjs <command> [options]
  status [--quota]                 Local connection; optional cached quota, no account identity
  runs [--limit 15]               Current workspace's connector task records
  models                          Current selection and available providers/models
  select [--provider NAME] [--model ID] [--effort max]
  ask "PROMPT" [--provider NAME] [--model ID] [--effort max]
  ask --stdin                     Read a long prompt from standard input
  delegate "TASK"                 Start a task and return its ID
  wait TASK_ID [--timeout 60]      Return on question, approval or completion
  reply TASK_ID --request ID --answer '{"optionId":"..."}'
  reply TASK_ID --request ID --stdin  Read an answer JSON object from stdin
  install [--mcp]                 Install the minimal Codex skill; MCP is optional
  uninstall                       Remove this connector's skill and owned MCP entry
  launch                          Start the local ZCode test instance

Provider aliases: start-plan, bigmodel (full IDs from models also work).
Omitted provider/model retain the current selection. Effort defaults to max.
Common options: --json, --workspace ABSOLUTE_PATH, --port 9333, --help
GLM-5.3: stronger, no vision. GLM-5.3-Flash: vision capable, weaker.
The connector currently sends text only. wait timeout does not cancel a task.
Optional MCP server: npm run mcp. Register it with install --mcp.
`

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
      limit: { type: 'string' }, workspace: { type: 'string' }, port: { type: 'string' },
      timeout: { type: 'string' }, request: { type: 'string' }, answer: { type: 'string' },
      mcp: { type: 'boolean' },
      quota: { type: 'boolean' },
      json: { type: 'boolean' }, stdin: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...rest] = positionals
  if (values.help || command === undefined) {
    process.stdout.write(HELP)
  } else if (['install', 'uninstall', 'launch'].includes(command)) {
    const allowed = { install: ['mcp', 'workspace', 'port'], uninstall: [], launch: ['workspace', 'port'] }[command]
    if (rest.length || Object.keys(values).some(key => !allowed.includes(key))) throw new Error(`Unexpected arguments for ${command}`)
    const env = { ...process.env }
    if (values.workspace !== undefined) env.ZCODE_WORKSPACE = values.workspace
    if (values.port !== undefined) env.ZCODE_DEBUG_PORT = values.port
    if (command === 'install') process.stdout.write(installConnector(loadConfig(env), { mcp: values.mcp ?? false }) + '\n')
    if (command === 'uninstall') process.stdout.write(uninstallConnector() + '\n')
    if (command === 'launch') {
      if (values.workspace !== undefined) process.env.ZCODE_WORKSPACE = values.workspace
      if (values.port !== undefined) process.env.ZCODE_DEBUG_PORT = values.port
      await import('./scripts/start-zcode.mjs')
    }
  } else {
    if (values.mcp !== undefined) throw new Error('--mcp is only valid for install')
    const tools = { status: 'zcode_status', runs: 'zcode_runs', models: 'zcode_models', select: 'zcode_select_model', ask: 'zcode_ask', delegate: 'zcode_task', wait: 'zcode_task', reply: 'zcode_task' }
    const name = tools[command]
    if (!name) throw new Error(`Unknown command: ${command}. Use --help.`)
    const args = {}
    for (const key of ['provider', 'model', 'effort']) if (values[key] !== undefined) args[key] = values[key]
    if (values.limit !== undefined) args.limit = Number(values.limit)
    if (values.quota !== undefined) args.quota = values.quota
    if (command === 'ask' || command === 'delegate') {
      if (values.stdin && rest.length > 0) throw new Error('Use either a quoted prompt or --stdin')
      if (!values.stdin && rest.length !== 1) throw new Error(`${command} requires one quoted prompt or --stdin`)
      args.prompt = values.stdin ? readFileSync(0, 'utf8') : rest[0]
      if (command === 'delegate') args.action = 'start'
    } else if (command === 'wait' || command === 'reply') {
      if (rest.length !== 1) throw new Error(`${command} requires a task ID`)
      args.action = command
      args.taskId = rest[0]
      if (command === 'reply') {
        if (values.stdin && values.answer !== undefined) throw new Error('Use --answer or --stdin')
        if (!values.stdin && values.answer === undefined) throw new Error('reply requires --answer JSON or --stdin')
        args.requestId = values.request
        args.answer = JSON.parse(values.stdin ? readFileSync(0, 'utf8') : values.answer)
      } else if (values.stdin) throw new Error('wait does not accept --stdin')
    } else if (rest.length > 0 || values.stdin) {
      throw new Error(`${command} does not accept a prompt or --stdin`)
    }
    if (values.timeout !== undefined) args.timeout = Number(values.timeout)
    if (command !== 'reply' && (values.request !== undefined || values.answer !== undefined)) throw new Error('--request and --answer require reply')
    validateArguments(name, args)
    const env = { ...process.env }
    if (values.workspace !== undefined) env.ZCODE_WORKSPACE = values.workspace
    if (values.port !== undefined) env.ZCODE_DEBUG_PORT = values.port
    const result = await callTool(name, args, loadConfig(env))
    process.stdout.write((values.json ? JSON.stringify(result.structured) : result.text) + '\n')
  }
} catch (error) {
  process.stderr.write(`codex-zcode: ${error.message}\n`)
  process.exitCode = 1
}
