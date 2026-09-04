import { spawn } from 'node:child_process'
import { pythonChildEnv } from './contract.ts'

export interface SidecarSpawnOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
}

export interface SidecarProcess {
  end(): void
  kill(): void
  onExit(handler: () => void): void
  onLine(handler: (line: string) => void): void
  send(line: string): void
}

export type SpawnSidecarFn = (command: string, args: string[], options: SidecarSpawnOptions) => SidecarProcess

export const spawnSidecarProcess: SpawnSidecarFn = (command, args, options) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...pythonChildEnv(), ...options.env },
    killSignal: 'SIGTERM',
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const lineHandlers: ((line: string) => void)[] = []
  const exitHandlers: (() => void)[] = []
  let buffer = ''
  let exited = false

  function notifyExit(): void {
    if (exited) return
    exited = true
    for (const handler of exitHandlers) handler()
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    while (true) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      for (const handler of lineHandlers) handler(line)
    }
  })
  child.stdin.on('error', () => {})
  child.on('error', notifyExit)
  child.on('close', notifyExit)

  return {
    end() {
      child.stdin.end()
    },
    kill() {
      child.kill('SIGTERM')
    },
    onExit(handler) {
      exitHandlers.push(handler)
    },
    onLine(handler) {
      lineHandlers.push(handler)
    },
    send(line) {
      if (!exited) child.stdin.write(`${line}\n`)
    },
  }
}
