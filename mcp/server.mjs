#!/usr/bin/env node
import { loadConfig } from '../lib/config.js'
import { handleRequest } from '../lib/protocol.js'
import { callTool } from '../lib/tools.js'

const config = loadConfig()
const MAX_LINE_BYTES = 1024 * 1024
const send = message => { if (message !== null) process.stdout.write(JSON.stringify(message) + '\n') }
let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      process.stderr.write('MCP request exceeds 1 MiB\n')
      process.exit(1)
    }
    let request
    try {
      request = JSON.parse(line)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }
    void handleRequest(request, (name, args) => callTool(name, args, config)).then(send)
  }
  if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
    process.stderr.write('MCP request exceeds 1 MiB\n')
    process.exit(1)
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
