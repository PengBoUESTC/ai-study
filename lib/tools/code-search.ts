// 仅服务端运行：依赖 Node.js child_process / fs 模块，禁止在浏览器端引入
import { tool } from 'ai'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/** 沙箱根目录：所有检索都必须落在该目录内 */
const PROJECT_ROOT = process.cwd()

/** 默认返回的最大命中条数 */
const DEFAULT_MAX_RESULTS = 50
/** 允许的最大命中条数，防止撑爆上下文窗口 */
const MAX_RESULTS_LIMIT = 200
/** 单行内容最大字符数，超出截断 */
const MAX_LINE_LENGTH = 500
/** ripgrep 子进程输出缓冲上限（字节） */
const MAX_BUFFER = 8 * 1024 * 1024
/** ripgrep 执行超时（毫秒） */
const SEARCH_TIMEOUT = 20_000
/** Node 兜底实现：单文件最大读取字节数 */
const MAX_FILE_SIZE = 2 * 1024 * 1024

/** Node 兜底实现：始终跳过的目录 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.cache',
])

type ResolvedPath =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; error: string }

/** 把用户传入的相对/绝对路径解析为绝对路径，并校验是否越出项目根目录 */
const resolveInsideRoot = (target: string | undefined): ResolvedPath => {
  const absolutePath = path.resolve(PROJECT_ROOT, target ?? '.')
  const relativePath = path.relative(PROJECT_ROOT, absolutePath)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return {
      ok: false,
      error: `路径越界：只允许检索项目根目录内的文件（根目录为 ${PROJECT_ROOT}）`,
    }
  }

  return { ok: true, absolutePath, relativePath: relativePath || '.' }
}

type CodeSearchMatch = {
  /** 相对项目根目录的文件路径 */
  path: string
  /** 命中行号，从 1 开始 */
  line: number
  /** 命中行的文本内容（已去除首尾空白并按需截断） */
  content: string
}

type CodeSearchResult =
  | {
      success: true
      pattern: string
      searchPath: string
      engine: 'ripgrep' | 'node'
      matchCount: number
      truncated: boolean
      matches: CodeSearchMatch[]
    }
  | { success: false; error: string }

/** 把单行文本规范化：去除首尾空白并限制长度 */
const normalizeLine = (raw: string): string => {
  const trimmed = raw.replace(/\r?\n$/, '').trim()
  return trimmed.length > MAX_LINE_LENGTH
    ? `${trimmed.slice(0, MAX_LINE_LENGTH)}…`
    : trimmed
}

/** ripgrep --json 的 match 事件结构（只取用到的字段） */
type RipgrepMatchEvent = {
  type: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
  }
}

/** execFile 失败时抛出的对象结构 */
type ExecRejection = {
  message: string
  code?: number | string
  stdout?: string
  stderr?: string
}

const isExecRejection = (error: unknown): error is ExecRejection =>
  typeof error === 'object' && error !== null && 'message' in error

/** 解析 ripgrep 的 --json 输出，最多收集 maxResults 条 */
const parseRipgrepJson = (
  stdout: string,
  maxResults: number
): { matches: CodeSearchMatch[]; truncated: boolean } => {
  const matches: CodeSearchMatch[] = []
  let truncated = false

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue

    let event: RipgrepMatchEvent
    try {
      event = JSON.parse(line) as RipgrepMatchEvent
    } catch {
      continue
    }

    if (event.type !== 'match') continue

    const filePath = event.data?.path?.text
    const lineNumber = event.data?.line_number
    const text = event.data?.lines?.text
    if (!filePath || typeof lineNumber !== 'number' || typeof text !== 'string') {
      continue
    }

    if (matches.length >= maxResults) {
      truncated = true
      break
    }

    matches.push({
      path: path.relative(PROJECT_ROOT, path.resolve(PROJECT_ROOT, filePath)),
      line: lineNumber,
      content: normalizeLine(text),
    })
  }

  return { matches, truncated }
}

/** 使用 ripgrep 检索；若本机没有 rg 可执行文件则返回 null 以便回退 */
const searchWithRipgrep = async (
  pattern: string,
  searchRoot: string,
  glob: string | undefined,
  ignoreCase: boolean,
  maxResults: number
): Promise<{ matches: CodeSearchMatch[]; truncated: boolean } | null> => {
  const args = ['--json', '--line-number', '--no-messages']
  if (ignoreCase) args.push('--ignore-case')
  if (glob) args.push('--glob', glob)
  // 多取一条用于判断是否被截断
  args.push('--max-count', String(maxResults + 1))
  args.push('-e', pattern, '--', searchRoot)

  try {
    const { stdout } = await execFileAsync('rg', args, {
      cwd: PROJECT_ROOT,
      timeout: SEARCH_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf-8',
    })
    return parseRipgrepJson(stdout, maxResults)
  } catch (error) {
    if (isExecRejection(error)) {
      // exitCode 1 = 没有命中，属于正常结果
      if (error.code === 1) {
        return { matches: [], truncated: false }
      }
      // 本机没有安装 ripgrep，交给 Node 兜底实现
      if (error.code === 'ENOENT') {
        return null
      }
      // 其他情况仍可能有部分输出（例如 maxBuffer 截断）
      if (error.stdout) {
        return parseRipgrepJson(error.stdout, maxResults)
      }
    }
    return null
  }
}

/** 把简易 glob（支持 * ** ?）转换为正则 */
const globToRegExp = (glob: string): RegExp => {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*'
        i += 1
        if (glob[i + 1] === '/') i += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`(^|/)${source}$`)
}

/** Node 兜底实现：递归遍历目录并逐行匹配 */
const searchWithNode = async (
  regex: RegExp,
  searchRoot: string,
  glob: string | undefined,
  maxResults: number
): Promise<{ matches: CodeSearchMatch[]; truncated: boolean }> => {
  const globRegex = glob ? globToRegExp(glob) : undefined
  const matches: CodeSearchMatch[] = []
  let truncated = false

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return

    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (truncated) return

      const absolutePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue

      const relativePath = path.relative(PROJECT_ROOT, absolutePath)
      if (globRegex && !globRegex.test(relativePath)) continue

      let raw: string
      try {
        raw = await readFile(absolutePath, { encoding: 'utf-8' })
      } catch {
        continue
      }
      if (raw.length > MAX_FILE_SIZE || raw.includes('\u0000')) continue

      const lines = raw.split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        regex.lastIndex = 0
        if (!regex.test(lines[i])) continue

        if (matches.length >= maxResults) {
          truncated = true
          return
        }
        matches.push({
          path: relativePath,
          line: i + 1,
          content: normalizeLine(lines[i]),
        })
      }
    }
  }

  await walk(searchRoot)
  return { matches, truncated }
}

export const codeSearchTool = () => {
  return tool({
    description:
      '在项目根目录内按正则表达式或字符串检索代码，返回命中的文件路径、行号和该行内容。优先使用 ripgrep，未安装时自动回退到 Node 实现。支持按子目录和文件名 glob 过滤，结果数量超限时会截断。检索失败时返回错误信息而不抛异常。',
    inputSchema: z.object({
      pattern: z.string().min(1).describe(
        '检索模式，按正则表达式解释（普通字符串同样可用，特殊字符需转义），例如：fileReadTool、streamText\\(、export const \\w+Tool。'
      ),
      path: z
        .string()
        .optional()
        .describe(
          '限定检索的子目录或单个文件，相对项目根目录（如 lib/tools），不填表示检索整个项目根目录。'
        ),
      glob: z
        .string()
        .optional()
        .describe('文件名过滤 glob，例如 *.ts、**/*.tsx；不填表示不过滤文件类型。'),
      ignoreCase: z
        .boolean()
        .optional()
        .describe('是否忽略大小写，默认 false（区分大小写）。'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('最多返回的命中条数，默认 50，最大 200；超出部分会被截断。'),
    }),
    execute: async ({
      pattern,
      path: targetPath,
      glob,
      ignoreCase,
      maxResults,
    }): Promise<CodeSearchResult> => {
      console.log(`tools-call : codeSearchTool`)

      const resolved = resolveInsideRoot(targetPath)
      if (!resolved.ok) {
        return { success: false, error: resolved.error }
      }

      const effectiveIgnoreCase = ignoreCase ?? false
      const effectiveMaxResults = Math.min(
        maxResults ?? DEFAULT_MAX_RESULTS,
        MAX_RESULTS_LIMIT
      )

      let regex: RegExp
      try {
        regex = new RegExp(pattern, effectiveIgnoreCase ? 'i' : '')
      } catch (error) {
        return {
          success: false,
          error: `正则表达式不合法：${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }

      try {
        const ripgrepResult = await searchWithRipgrep(
          pattern,
          resolved.absolutePath,
          glob,
          effectiveIgnoreCase,
          effectiveMaxResults
        )

        const { matches, truncated } =
          ripgrepResult ??
          (await searchWithNode(
            regex,
            resolved.absolutePath,
            glob,
            effectiveMaxResults
          ))

        return {
          success: true,
          pattern,
          searchPath: resolved.relativePath,
          engine: ripgrepResult ? 'ripgrep' : 'node',
          matchCount: matches.length,
          truncated,
          matches,
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}