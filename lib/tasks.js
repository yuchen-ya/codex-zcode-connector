import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { startZCodeTask, waitZCodeTask, replyZCodeTask } from './zcode.js'

const TERMINAL = new Set(['completed', 'failed', 'interrupted'])
const TASK_FILE = /^(?:session|sess)_[A-Za-z0-9_-]+\.json$/

function taskPath(config, id) {
  if (!/^(?:session|sess)_[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid task ID')
  return join(config.tasksDir, `${id}.json`)
}

function loadTask(config, id) {
  const task = JSON.parse(readFileSync(taskPath(config, id), 'utf8'))
  if (task.sessionId !== id) throw new Error('Task record ID does not match its filename')
  if (!isAbsolute(task.workspace) || (config.workspace && task.workspace !== config.workspace) || task.debugPort !== config.debugPort || task.home !== config.home) throw new Error('Task belongs to a different workspace, debug port or ZCode home')
  return task
}

function saveTask(config, task) {
  mkdirSync(config.tasksDir, { recursive: true })
  const path = taskPath(config, task.sessionId)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const event = task.event.status === 'needs_input' ? { status: 'needs_input' } : task.event
    writeFileSync(temporary, JSON.stringify({ ...task, event, updatedAt: Date.now() }), { mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function listRecordedTasks(config) {
  let names
  try {
    names = readdirSync(config.tasksDir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const tasks = []
  for (const name of names.filter(name => TASK_FILE.test(name))) {
    const path = join(config.tasksDir, name)
    const task = JSON.parse(readFileSync(path, 'utf8'))
    if (`${task.sessionId}.json` !== name) throw new Error('Task record ID does not match its filename')
    if (task.workspace !== config.workspace || task.debugPort !== config.debugPort || task.home !== config.home) continue
    tasks.push({ ...task, updatedAt: task.updatedAt ?? statSync(path).mtimeMs })
  }
  return tasks.sort((a, b) => b.updatedAt - a.updatedAt)
}

function publicTask(task) {
  return { taskId: task.sessionId, workspace: task.workspace, provider: task.provider, model: task.model, effort: task.effort,
    permission: task.permission, ...task.event }
}

export async function delegateTask(prompt, config, options = {}) {
  mkdirSync(config.tasksDir, { recursive: true })
  const handle = await startZCodeTask(prompt, config, options)
  const task = { ...handle, workspace: config.workspace, debugPort: config.debugPort, home: config.home, event: { status: 'running' } }
  saveTask(config, task)
  return publicTask(task)
}

export async function waitTask(id, config, timeoutMs = 60_000) {
  const task = loadTask(config, id)
  if (!TERMINAL.has(task.event.status)) {
    task.event = await waitZCodeTask(task, { ...config, workspace: task.workspace }, timeoutMs)
    saveTask(config, task)
  }
  return publicTask(task)
}

export async function replyTask(id, requestId, answer, config) {
  const task = loadTask(config, id)
  if (TERMINAL.has(task.event.status)) throw new Error('Task has already ended')
  // Native pending state is authoritative, including if the user answered in ZCode.
  const event = await replyZCodeTask(task, { ...config, workspace: task.workspace }, requestId, answer)
  return { ...publicTask(task), ...event, requests: undefined }
}

export async function askTask(prompt, config, options = {}) {
  const task = await delegateTask(prompt, config, options)
  const deadline = Date.now() + config.replyTimeoutMs
  while (true) {
    const event = await waitTask(task.taskId, config, Math.min(60_000, Math.max(0, deadline - Date.now())))
    if (event.status !== 'running' || Date.now() >= deadline) return event
  }
}

export function summarizeTask(event) {
  if (event.status === 'completed') return event.reply
  return JSON.stringify(event)
}
