import { isAbsolute, resolve } from 'node:path'
import { collectStatus } from './status.js'
import { describeRuns } from './runs.js'
import { summarizeRuns, summarizeStatus } from './summaries.js'
import { listZCodeModels, selectZCodeModel, listZCodeWorkspaces, inspectZCode } from './zcode.js'
import { PROVIDER_ALIASES, MODEL_GUIDANCE } from './model-options.js'
import { askTask, delegateTask, waitTask, replyTask, summarizeTask } from './tasks.js'

const WORKSPACE = { type: 'string', minLength: 1, description: 'Explicit absolute path to a registered local ZCode project. Required for new tasks unless ZCODE_WORKSPACE is set.' }

const MODEL_PROPERTIES = {
  provider: { type: 'string', minLength: 1, description: 'start-plan or bigmodel; omitted=current.' },
  model: { type: 'string', minLength: 1, description: 'GLM-5.3: stronger, text only. GLM-5.3-Flash: weaker, vision capable. Omitted=current.' },
  effort: { type: 'string', enum: ['low', 'high', 'max'], default: 'max' },
}

export const TOOLS = [
  {
    name: 'zcode_workspaces', description: 'List registered local ZCode projects, current workspace and directory availability. Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zcode_status',
    description: 'Read local connection status. Optional cached quota; no login credentials or account identity are read.',
    inputSchema: { type: 'object', properties: { quota: { type: 'boolean', default: false } }, additionalProperties: false },
  },
  {
    name: 'zcode_runs',
    description: 'Read connector-created tasks and their subagents in the current workspace only. Last observed state; use wait for live status.',
    inputSchema: {
      type: 'object',
      properties: { workspace: WORKSPACE, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Recent subagent runs to return; default 15. All running runs are always included.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'zcode_models',
    description: 'Read available models, capabilities and current selection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zcode_select_model',
    description: 'Select provider/model and verify. Default effort=max. No model call.',
    inputSchema: { type: 'object', properties: { workspace: WORKSPACE, ...MODEL_PROPERTIES }, additionalProperties: false },
  },
  {
    name: 'zcode_ask',
    description: 'Run a new task; return its reply or pending input with taskId. May edit files. No automatic approvals/retries. For interactive delegation use zcode_task.',
    inputSchema: {
      type: 'object',
      properties: { workspace: WORKSPACE, prompt: { type: 'string', minLength: 1, description: 'Full task and context. Each call starts a new task.' }, ...MODEL_PROPERTIES },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'zcode_task',
    description: 'Delegate to ZCode. inspect reads current models, permission, workspaces and connector limits before user choices. start requires a workspace path; wait/reply retain the task workspace. May edit files. Permissions require user authorization.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['inspect', 'workspaces', 'start', 'wait', 'reply'] }, workspace: WORKSPACE,
        prompt: { type: 'string', minLength: 1 }, ...MODEL_PROPERTIES,
        taskId: { type: 'string' }, requestId: { type: 'string' },
        answer: { type: 'object', description: 'Native answer: permission {optionId}; questions {action:"accept",content:{answers:{question:text}}}; simple input {freeText}.' },
        timeout: { type: 'integer', minimum: 0, maximum: 60, default: 60 },
      },
    },
  },
]

export function validateArguments(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object')
  const allowed = Object.keys(TOOLS.find(tool => tool.name === name).inputSchema.properties)
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`Unexpected argument: ${key}`)
  }
  if (name === 'zcode_task') {
    if (!['inspect', 'workspaces', 'start', 'wait', 'reply'].includes(args.action)) throw new Error('action must be inspect, workspaces, start, wait or reply')
    const actionKeys = { inspect: [], workspaces: [], start: ['workspace', 'prompt', 'provider', 'model', 'effort'], wait: ['workspace', 'taskId', 'timeout'], reply: ['workspace', 'taskId', 'requestId', 'answer'] }[args.action]
    if (Object.keys(args).some(key => key !== 'action' && !actionKeys.includes(key))) throw new Error(`Unexpected argument for ${args.action}`)
    if (args.action === 'start' && (typeof args.prompt !== 'string' || !args.prompt.trim())) throw new Error('start requires a non-empty prompt')
    if (['wait', 'reply'].includes(args.action) && (typeof args.taskId !== 'string' || !/^(?:session|sess)_[A-Za-z0-9_-]+$/.test(args.taskId))) throw new Error('Invalid task ID')
    if (args.timeout !== undefined && (!Number.isInteger(args.timeout) || args.timeout < 0 || args.timeout > 60)) throw new Error('timeout must be an integer from 0 to 60 seconds')
    if (args.action === 'reply' && (typeof args.requestId !== 'string' || !args.requestId || !args.answer || typeof args.answer !== 'object' || Array.isArray(args.answer))) throw new Error('reply requires requestId and an answer object')
  }
  if (args.workspace !== undefined && (typeof args.workspace !== 'string' || !isAbsolute(args.workspace))) throw new Error('workspace must be an absolute path')
  if (name === 'zcode_ask' && (typeof args.prompt !== 'string' || !args.prompt.trim())) {
    throw new Error('zcode_ask requires a non-empty prompt string')
  }
  if (args.quota !== undefined && typeof args.quota !== 'boolean') throw new Error('quota must be a boolean')
  if (name === 'zcode_runs' && args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
    throw new Error('limit must be an integer from 1 to 100')
  }
  for (const key of ['provider', 'model']) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) throw new Error(`${key} must be a non-empty string`)
  }
  if (args.effort !== undefined && !['low', 'high', 'max'].includes(args.effort)) throw new Error('effort must be low, high or max')
}

export async function callTool(name, args, config) {
  if (args.workspace !== undefined) config = { ...config, workspace: resolve(args.workspace) }
  if (name === 'zcode_task' && args.action === 'inspect') {
    const result = await inspectZCode(config)
    result.models.guidance = MODEL_GUIDANCE
    return { text: JSON.stringify(result), structured: result }
  }
  if (name === 'zcode_workspaces' || (name === 'zcode_task' && args.action === 'workspaces')) {
    const result = await listZCodeWorkspaces(config)
    const text = [`current: ${result.current.path}${result.current.remote ? ' (remote, unsupported)' : ''}`,
      ...result.workspaces.map(w => `${w.current ? '*' : '-'} ${w.name}: ${w.path}${w.available ? '' : ' [missing]'}`)].join('\n')
    return { text, structured: result }
  }
  if (name === 'zcode_status') {
    const status = await collectStatus(config, args)
    return { text: summarizeStatus(status), structured: status }
  }
  if (name === 'zcode_runs') {
    if (!config.workspace) throw new Error('Workspace required: use --workspace ABSOLUTE_PATH')
    const runs = describeRuns(config, { limit: args.limit ?? 15 })
    return { text: summarizeRuns(runs), structured: runs }
  }
  if (name === 'zcode_models') {
    const catalog = await listZCodeModels(config)
    catalog.guidance = MODEL_GUIDANCE
    const lines = [`current: ${catalog.current.provider} / ${catalog.current.model} / effort=${catalog.current.effort}`]
    for (const provider of catalog.providers) {
      const alias = Object.keys(PROVIDER_ALIASES).find(key => PROVIDER_ALIASES[key] === provider.id)
      lines.push(`${provider.label} ${provider.badge ?? ''} [${alias ?? provider.id}]: ${provider.models.map(model => model.id).join(', ')}`)
    }
    lines.push('GLM-5.3: text only; stronger reasoning/coding. GLM-5.3-Flash: vision capable; weaker overall. Connector input is text only.')
    return { text: lines.join('\n'), structured: catalog }
  }
  if (name === 'zcode_select_model') {
    const result = await selectZCodeModel(args, config)
    return { text: `selected: ${result.provider} / ${result.model} / effort=${result.effort}`, structured: result }
  }
  let result
  if (name === 'zcode_task') {
    if (args.action === 'start') result = await delegateTask(args.prompt, config, args)
    const taskConfig = { ...config, workspace: args.workspace === undefined ? null : config.workspace }
    if (args.action === 'wait') result = await waitTask(args.taskId, taskConfig, (args.timeout ?? 60) * 1000)
    if (args.action === 'reply') result = await replyTask(args.taskId, args.requestId, args.answer, taskConfig)
  } else {
    result = await askTask(args.prompt, config, args)
  }
  return { text: summarizeTask(result), structured: result }
}
