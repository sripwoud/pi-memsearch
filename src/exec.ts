import { spawn } from 'node:child_process'

export interface ExecOptions {
  cwd?: string
  signal?: AbortSignal
  timeoutMs: number
}

export interface ExecResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
}

export type ExecFn = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>

export const execProcess: ExecFn = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      killSignal: 'SIGTERM',
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    let settled = false
    child.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.on('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      resolve({ exitCode, signal, stderr, stdout })
    })
  })
