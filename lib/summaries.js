export function summarizeRuns(runs) {
  const lines = [`tasks: ${runs.counts.running} unfinished / ${runs.counts.tasks} recorded in the current workspace (last observed)`]
  for (const task of runs.tasks) lines.push(`${task.taskId}: ${task.status} / ${task.model} / effort=${task.effort}`)
  for (const agent of runs.agents) lines.push(`  ${agent.agentId}: ${agent.status} / ${agent.role ?? 'subagent'}`)
  return lines.join('\n')
}

export function summarizeStatus(status) {
  const lines = [
    status.cdp.reachable ? `client: ZCode ${status.cdp.appVersion}, connected` : `client: unavailable (${status.cdp.reason})`,
    'workspace: configured; checked against ZCode before task actions',
  ]
  if (status.quota) {
    lines.push(`quota source: ${status.quota.source}; observed: ${status.quota.observedAt ?? 'unavailable'}`)
    for (const balance of status.quota.balances) lines.push(`balance: ${balance.availableUnits ?? balance.remainingUnits ?? '?'} / ${balance.totalUnits ?? '?'} ${balance.unitType ?? ''}`)
  }
  return lines.join('\n')
}
