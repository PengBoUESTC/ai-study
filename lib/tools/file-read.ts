// 仅服务端运行：依赖 Node.js fs 模块，禁止在浏览器端引入
import { tool } from 'ai'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** 单次返回给模型的最大字符数，超出部分截断以保护上下文窗口 */
const MAX_CONTENT_LENGTH = 100_000

/** 沙箱根目录：所有读取都必须落在该目录内 */
const PROJECT_ROOT = process.cwd()

type ResolvedPath =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; error: string }

/** 把用户传入的相对/绝对路径解析为绝对路径，并校验是否越出项目根目录 */
const resolveInsideRoot = (target: string): ResolvedPath => {
  const absolutePath = path.resolve(PROJECT_ROOT, target)
  const relativePath = path.relative(PROJECT_ROOT, absolutePath)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return {
      ok: false,
      error: `路径越界：只允许访问项目根目录内的文件（根目录为 ${PROJECT_ROOT}）`,
    }
  }

  return { ok: true, absolutePath, relativePath: relativePath || '.' }
}

type FileReadResult =
  | {
      success: true
      path: string
      content: string
      totalLines: number
      truncated: boolean
    }
  | { success: false; error: string }

export const fileReadTool = () => {
  return tool({
    description:
      '读取项目内指定文本文件的内容，可选择只读取某个行区间。返回文件内容、总行数以及是否被截断。读取失败时返回错误信息而不抛异常。',
    inputSchema: z.object({
      path: z.string().describe(
        '要读取的文件路径，可以是相对工作区根目录的路径（如 app/page.tsx），也可以是绝对路径；但必须位于项目根目录之内。'
      ),
      startLine: z.number().int().min(1).optional().describe(
        '读取的起始行号，从 1 开始计数（包含该行）。不填表示从第一行开始。'
      ),
      endLine: z.number().int().min(1).optional().describe(
        '读取的结束行号，从 1 开始计数（包含该行）。不填表示读到文件末尾。'
      ),
      encoding: z
        .enum(['utf-8', 'ascii', 'latin1', 'utf16le', 'base64', 'hex'])
        .optional()
        .describe('文件编码，默认 utf-8。读取普通源码或文本文件时无需指定。'),
    }),
    execute: async ({
      path: targetPath,
      startLine,
      endLine,
      encoding,
    }): Promise<FileReadResult> => {
      console.log(`tools-call : fileReadTool`)
      const resolved = resolveInsideRoot(targetPath)
      if (!resolved.ok) {
        return { success: false, error: resolved.error }
      }

      if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
        return {
          success: false,
          error: `行区间不合法：startLine(${startLine}) 不能大于 endLine(${endLine})`,
        }
      }

      try {
        const raw = await readFile(resolved.absolutePath, {
          encoding: encoding ?? 'utf-8',
        })
        const lines = raw.split(/\r?\n/)
        const totalLines = lines.length

        let content = raw
        if (startLine !== undefined || endLine !== undefined) {
          const from = startLine ?? 1
          const to = Math.min(endLine ?? totalLines, totalLines)
          if (from > totalLines) {
            return {
              success: false,
              error: `起始行 ${from} 超出文件总行数 ${totalLines}`,
            }
          }
          content = lines.slice(from - 1, to).join('\n')
        }

        let truncated = false
        if (content.length > MAX_CONTENT_LENGTH) {
          content = content.slice(0, MAX_CONTENT_LENGTH)
          truncated = true
        }

        return {
          success: true,
          path: resolved.relativePath,
          content,
          totalLines,
          truncated,
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