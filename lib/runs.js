import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listRecordedTasks } from './tasks.js'

const TERMINAL = new Set(['completed', 'complete', 'failed', 'error', 'aborted', 'cancelled', 'canceled', 'stopped', 'timeout', 'expired'])

function childAgents(home, sessionId) {
  const directory = join(home, 'cli', 'agents', sessionId)
  if (!existsSync(directory)) return []
  const agents = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^agent_[A-Za-z0-9_-]+$/.test(entry.name)) continue
    const path = join(directory, entry.name, 'metadata.json')
    if (!existsSync(path)) continue
    let metadata
    try {
      metadata = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      if (error instanceof SyntaxError || error.code === 'ENOENT') continue // Native metadata may be mid-write.
      throw error
    }
    if (metadata.parentSessionId !== undefined && metadata.parentSessionId !== sessionId) continue
    const status = String(metadata.status ?? 'unknown').toLowerCase()
    const profile = metadata.profileSnapshot
    agents.push({
      agentId: entry.name, sessionId,
      role: [typeof profile === 'string' ? profile : profile?.name, metadata.profileId].find(value => typeof value === 'string')?.slice(0, 80) ?? null,
      status, running: !TERMINAL.has(status) && !metadata.completedAt,
      updatedAt: metadata.updatedAt ?? metadata.completedAt ?? metadata.startedAt ?? statSync(path).mtimeMs,
    })
  }
  return agents
}

// Only connector-created sessions from this exact workspace/port/home are eligible.
// Never open the global task index, unrelated transcripts or global activity logs.
export function describeRuns(config, { limit = 15 } = {}) {
  const recorded = listRecordedTasks(config)
  const tasks = recorded.map(task => ({
    taskId: task.sessionId, status: task.event.status,
    provider: task.provider, model: task.model, effort: task.effort,
    updatedAt: task.updatedAt,
  }))
  const open = new Set(['running', 'needs_input'])
  const running = tasks.filter(task => open.has(task.status))
  const selected = [...running, ...tasks.filter(task => !open.has(task.status)).slice(0, Math.max(0, limit - running.length))]
  return {
    scope: 'connector-tasks-in-current-workspace', source: 'last-observed-state',
    tasks: selected,
    agents: selected.flatMap(task => childAgents(config.home, task.taskId)),
    counts: { tasks: tasks.length, running: running.length },
  }
}
