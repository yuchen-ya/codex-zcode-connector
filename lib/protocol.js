import { TOOLS, validateArguments } from './tools.js'

export const SERVER_INFO = { name: 'codex-zcode-connector', version: '0.5.0' }
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2024-11-05']

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export async function handleRequest(request, executeTool) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return error(null, -32600, 'Invalid Request')
  }
  const { id, method, params } = request
  if (id === undefined) return null
  if (id !== null && typeof id !== 'string' && typeof id !== 'number') return error(null, -32600, 'Invalid request ID')
  const result = value => ({ jsonrpc: '2.0', id, result: value })
  if (method === 'initialize') {
    const requested = params?.protocolVersion
    return result({
      protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
  }
  if (method === 'ping') return result({})
  if (method === 'tools/list') return result({ tools: TOOLS })
  if (method !== 'tools/call') return error(id, -32601, `Method not found: ${method}`)

  const name = params?.name
  if (!TOOLS.some(tool => tool.name === name)) return error(id, -32602, `Unknown tool: ${String(name)}`)
  const args = params.arguments ?? {}
  try {
    validateArguments(name, args)
  } catch (failure) {
    return error(id, -32602, failure.message)
  }
  try {
    const outcome = await executeTool(name, args)
    return result({ content: [{ type: 'text', text: outcome.text }], structuredContent: outcome.structured, isError: false })
  } catch (failure) {
    return result({ content: [{ type: 'text', text: failure.message }], isError: true })
  }
}
