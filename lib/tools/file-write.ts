// 仅服务端运行：依赖 Node.js fs 模块，禁止在浏览器端引入
import { tool } from 'ai'
import { z } from 'zod'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 沙箱根目录：所有写入都必须落在该目录内 */
const PROJECT_ROOT = process.cwd()

type ResolvedPath =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; error: string }

/** 把用户传入的相对/绝对路径解析为绝对路径，并校验是否越出项目根目录 */
const resolveInsideRoot = (target: string): ResolvedPath => {
  const absolutePath = path.resolve(PROJECT_ROOT, target)
  const relativePath = path.relative(PROJECT_ROOT, absolutePath)

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return {
      ok: false,
      error: `路径越界：只允许写入项目根目录内的文件（根目录为 ${PROJECT_ROOT}）`,
    }
  }

  return { ok: true, absolutePath, relativePath }
}

type WriteMode = 'overwrite' | 'append'

type FileWriteResult =
  | {
      success: true
      path: string
      bytesWritten: number
      mode: WriteMode
    }
  | { success: false; error: string }

export const fileWriteTool = () => {
  return tool({
    description:
      '向项目内的文件写入文本内容，支持覆盖写入和追加写入两种模式，并可自动创建缺失的父目录。写入失败时返回错误信息而不抛异常。',
    inputSchema: z.object({
      path: z.string().describe(
        '要写入的文件路径，可以是相对工作区根目录的路径（如 lib/utils/demo.ts），也可以是绝对路径；但必须位于项目根目录之内。'
      ),
      content: z.string().describe('要写入文件的完整文本内容。'),
      mode: z
        .enum(['overwrite', 'append'])
        .optional()
        .describe('写入模式：overwrite 表示覆盖整个文件（默认），append 表示在文件末尾追加。'),
      createDirs: z
        .boolean()
        .optional()
        .describe('当父目录不存在时是否自动递归创建，默认 true。'),
    }),
    execute: async ({
      path: targetPath,
      content,
      mode,
      createDirs,
    }): Promise<FileWriteResult> => {
      console.log(`tools-call : fileWriteTool`)

      const resolved = resolveInsideRoot(targetPath)
      if (!resolved.ok) {
        return { success: false, error: resolved.error }
      }

      const writeMode: WriteMode = mode ?? 'overwrite'
      const shouldCreateDirs = createDirs ?? true

      try {
        if (shouldCreateDirs) {
          await mkdir(path.dirname(resolved.absolutePath), { recursive: true })
        }

        if (writeMode === 'append') {
          await appendFile(resolved.absolutePath, content, { encoding: 'utf-8' })
        } else {
          await writeFile(resolved.absolutePath, content, { encoding: 'utf-8' })
        }

        return {
          success: true,
          path: resolved.relativePath,
          bytesWritten: Buffer.byteLength(content, 'utf-8'),
          mode: writeMode,
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