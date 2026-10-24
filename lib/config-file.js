export function codexEntry({ nodePath, serverPath, workspace, home, debugPort, stateDir }) {
  return `[mcp_servers.zcode]
command = ${JSON.stringify(nodePath)}
args = [${JSON.stringify(serverPath)}]
enabled_tools = ["zcode_task"]
startup_timeout_sec = 10
tool_timeout_sec = 300

[mcp_servers.zcode.env]
${workspace ? `ZCODE_WORKSPACE = ${JSON.stringify(workspace)}\n` : ''}ZCODE_HOME = ${JSON.stringify(home)}
ZCODE_DEBUG_PORT = "${debugPort}"
${stateDir ? `ZCODE_STATE_DIR = ${JSON.stringify(stateDir)}\n` : ''}
`
}

export function zcodeConfigSection(text) {
  const original = text.split(/\r?\n/)
  const section = []
  let inZCode = false
  for (const line of original) {
    if (/^\s*\[/.test(line)) inZCode = /^\s*\[mcp_servers\.zcode(?:\.[^\]]+)?\]\s*(?:#.*)?$/.test(line)
    if (inZCode) section.push(line)
  }
  return section.length ? section.join('\n').trim() + '\n' : ''
}

// Replace this connector's tables, preserving other Codex settings verbatim.
export function updateZCodeConfig(text, entry) {
  const kept = []
  let inZCode = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inZCode = /^\s*\[mcp_servers\.zcode(?:\.[^\]]+)?\]\s*(?:#.*)?$/.test(line)
    if (!inZCode) kept.push(line)
  }
  const remainder = kept.join('\n').trimEnd()
  return entry ? (remainder ? remainder + '\n\n' : '') + entry : (remainder ? remainder + '\n' : '')
}
