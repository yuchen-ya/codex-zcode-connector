import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { loadConfig, PROJECT_ROOT } from '../lib/config.js'

if (process.platform !== 'win32') throw new Error('Source ZIP export currently requires Windows PowerShell')
const options = process.argv.slice(2)
if (options.length !== 0 && (options.length !== 2 || options[0] !== '--output')) throw new Error('Usage: npm run release -- [--output ABSOLUTE_DIRECTORY]')
const config = loadConfig()
const output = options[1] ?? join(config.stateDir, 'releases')
if (!isAbsolute(output)) throw new Error('Release output must be an absolute directory')
const packageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))
const files = [...new Set(['package.json', '.gitignore', '.gitattributes', ...packageJson.files])]
for (const file of files) {
  const path = resolve(PROJECT_ROOT, file)
  if (!path.startsWith(resolve(PROJECT_ROOT) + '\\') || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`Release manifest requires a regular source file: ${file}`)
}
mkdirSync(output, { recursive: true })
const staging = mkdtempSync(join(output, '.codex-zcode-release-'))
const source = join(staging, packageJson.name)
const zip = join(output, `${packageJson.name}-${packageJson.version}-source.zip`)
try {
  for (const file of files) {
    const target = join(source, file)
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(join(PROJECT_ROOT, file), target)
  }
  const script = "$ProgressPreference = 'SilentlyContinue'; Compress-Archive -LiteralPath $env:ZCODE_RELEASE_SOURCE -DestinationPath $env:ZCODE_RELEASE_ZIP -Force -ErrorAction Stop"
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: 'inherit', env: { ...process.env, ZCODE_RELEASE_SOURCE: source, ZCODE_RELEASE_ZIP: zip },
  })
  const packed = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', output, '--json'], { cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true }))
  const expected = new Set(packageJson.files.concat('package.json'))
  if (packed[0].files.some(file => !expected.has(file.path))) throw new Error('npm package contains a file outside the release manifest')
  console.log(`Source: ${zip}`)
  console.log(`Package: ${join(output, packed[0].filename)}`)
  console.log(`${files.length} source files; no Git metadata, runtime data or local installation settings`)
} finally {
  // This exact directory was created above under the requested release output.
  if (existsSync(staging) && resolve(staging).startsWith(resolve(output) + '\\')) rmSync(staging, { recursive: true })
}
