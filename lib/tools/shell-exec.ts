// 仅服务端运行：依赖 Node.js child_process，禁止在浏览器端引入。
// ⚠️ 安全提示：该工具会在服务器上真实执行 shell 命令，具有较高风险，
// 仅应在本地开发环境中启用；生产环境请不要注册该工具，或改为白名单命令模式。
import { tool } from 'ai'
import { z } from 'zod'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execAsync = promisify(exec)

/** 沙箱根目录：命令的工作目录必须落在该目录内 */
const PROJECT_ROOT = process.cwd()

/** 默认超时时间（毫秒） */
const DEFAULT_TIMEOUT = 30_000
/** 允许的最大超时时间（毫秒） */
const MAX_TIMEOUT = 120_000
/** 子进程输出缓冲上限（字节） */
const MAX_BUFFER = 1024 * 1024

/** 危险命令黑名单：命中任意一条即拦截 */
const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+\/(\s|$)/, // rm -rf /
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/, // rm -rf 任意路径
  /\bmkfs(\.\w+)?\b/, // 格式化磁盘
  /\bdd\s+if=/, // 裸设备写入
  /\b(shutdown|reboot|halt|poweroff)\b/, // 关机重启
  /\bsudo\b|\bsu\s+-/, // 提权
  /:\s*\(\s*\)\s*\{.*\}\s*;?\s*:/, // fork bomb :(){ :|:& };:
  /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\//, // 放开根目录权限
  /\bchown\s+(-[a-zA-Z]+\s+)*\S+\s+\/(\s|$)/, // 修改根目录属主
  /\b(curl|wget)\b[^|;]*\|\s*(ba|z|)sh\b/, // 下载后直接执行
  /\bgit\s+push\s+(-f|--force)/, // 强推远端
  /\b(kill|pkill|killall)\s+(-9\s+)?-1\b/, // 杀掉所有进程
  />\s*\/dev\/(sd|disk|nvme)/, // 直写磁盘设备
  /\bhistory\s+-c\b/, // 清空历史
  /\bnpm\s+(publish|unpublish)\b/, // 误发布包
]

type ShellExecResult =
  | {
      success: boolean
      command: string
      stdout: string
      stderr: string
      exitCode: number
      timedOut: boolean
    }
  | { success: false; error: string }

/** promisify(exec) 失败时抛出的对象结构（带 stdout/stderr 附加字段） */
type ExecRejection = {
  message: string
  code?: number
  killed?: boolean
  signal?: NodeJS.Signals | null
  stdout?: string
  stderr?: string
}

const isExecRejection = (error: unknown): error is ExecRejection =>
  typeof error === 'object' && error !== null && 'message' in error

const resolveCwdInsideRoot = (
  target: string | undefined
): { ok: true; absolutePath: string } | { ok: false; error: string } => {
  const absolutePath = path.resolve(PROJECT_ROOT, target ?? '.')
  const relativePath = path.relative(PROJECT_ROOT, absolutePath)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return {
      ok: false,
      error: `工作目录越界：只允许在项目根目录内执行命令（根目录为 ${PROJECT_ROOT}）`,
    }
  }

  return { ok: true, absolutePath }
}

export const shellExecTool = () => {
  return tool({
    description:
      '在项目根目录内执行一条 shell 命令（例如 ls、git status、npm run lint），并返回标准输出、标准错误和退出码。命令超时或执行失败都会以结构化结果返回，不会抛异常。危险命令会被安全策略拦截。',
    inputSchema: z.object({
      command: z.string().min(1).describe(
        '要执行的完整命令行，例如：ls -la、git status、npx tsc --noEmit。请使用非交互式命令，不要执行需要用户输入的命令。'
      ),
      cwd: z
        .string()
        .optional()
        .describe('命令执行的工作目录，相对项目根目录（如 ai-work-assistant），默认即项目根目录。'),
      timeout: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('命令超时时间，单位毫秒，默认 30000，最大 120000；超时后子进程会被终止。'),
    }),
    execute: async ({ command, cwd, timeout }): Promise<ShellExecResult> => {
      console.log(`tools-call : shellExecTool`)

      const isDangerous = DANGEROUS_COMMAND_PATTERNS.some((pattern) =>
        pattern.test(command)
      )
      if (isDangerous) {
        return { success: false, error: '命令被安全策略拦截' }
      }

      const resolvedCwd = resolveCwdInsideRoot(cwd)
      if (!resolvedCwd.ok) {
        return { success: false, error: resolvedCwd.error }
      }

      const effectiveTimeout = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: resolvedCwd.absolutePath,
          timeout: effectiveTimeout,
          maxBuffer: MAX_BUFFER,
          encoding: 'utf-8',
        })

        return {
          success: true,
          command,
          stdout,
          stderr,
          exitCode: 0,
          timedOut: false,
        }
      } catch (error) {
        if (isExecRejection(error)) {
          const timedOut = error.killed === true || error.signal === 'SIGTERM'

          return {
            success: false,
            command,
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? error.message,
            exitCode: typeof error.code === 'number' ? error.code : -1,
            timedOut,
          }
        }

        return {
          success: false,
          command,
          stdout: '',
          stderr: String(error),
          exitCode: -1,
          timedOut: false,
        }
      }
    },
  })
}