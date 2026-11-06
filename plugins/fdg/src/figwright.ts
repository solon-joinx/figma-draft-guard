import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import type { Env } from './lib.ts'

const CALL_TIMEOUT_MS = 60 * 1000

export class FigwrightError extends Error {}

function command(env: Env): string[] {
  const override = env.NODE_ENV === 'test' ? env.FDG_FIGWRIGHT_ARGV : undefined
  return override ? (JSON.parse(override) as string[]) : ['npx', '-y', '@figwright/mcp']
}

// The token is ours alone, so it is not passed on to the child process
function childEnv(env: Env): Env {
  const { FDG_TOKEN, CLAUDE_PLUGIN_OPTION_FIGMA_TOKEN, ...rest } = env
  return rest
}

interface RpcResponse {
  id?: number
  error?: { message: string }
  result?: { isError?: boolean; content?: { text?: string }[]; [key: string]: unknown }
}

// Talks to Figwright directly: each call takes milliseconds here, against a full model turn otherwise
export class Figwright {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<number, (message: RpcResponse) => void>()
  private nextId = 0

  constructor(env: Env = process.env) {
    const [program = 'npx', ...args] = command(env)
    this.child = spawn(program, args, {
      env: childEnv(env),
      shell: process.platform === 'win32',
    })
    this.child.stderr.resume()
    this.child.on('error', () => this.failAll())
    this.child.on('close', () => this.failAll())
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line))
  }

  private failAll(): void {
    for (const resolve of this.pending.values()) resolve({ error: { message: 'Figwright stopped' } })
    this.pending.clear()
  }

  private receive(line: string): void {
    try {
      const message = JSON.parse(line) as RpcResponse
      if (message.id === undefined) return
      this.pending.get(message.id)?.(message)
      this.pending.delete(message.id)
    } catch {
      // Not a protocol message
    }
  }

  private request(method: string, params: unknown): Promise<RpcResponse> {
    const id = ++this.nextId
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ error: { message: `Figwright timed out on ${method}` } })
      }, CALL_TIMEOUT_MS)

      this.pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async connect(): Promise<void> {
    const { error } = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fdg', version: '0.1.0' },
    })
    if (error) throw new FigwrightError(error.message)
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  }

  async call<T>(name: string, args: object = {}): Promise<T> {
    const { error, result } = await this.request('tools/call', { name, arguments: args })
    const text = result?.content?.[0]?.text ?? ''
    if (error) throw new FigwrightError(error.message)
    if (result?.isError) throw new FigwrightError(text)
    return JSON.parse(text) as T
  }

  close(): void {
    this.child.kill()
  }
}
