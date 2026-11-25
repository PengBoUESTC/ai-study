// 仅服务端运行：依赖 Node.js fs 模块，禁止在浏览器端引入
import { tool } from 'ai'
import { z } from 'zod'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 沙箱根目录：清单文件必须落在该目录内 */
const PROJECT_ROOT = process.cwd()

/** 任务清单持久化目录（相对项目根目录） */
const STORE_DIR = path.resolve(PROJECT_ROOT, '.ai-assistant')
/** 任务清单持久化文件 */
const STORE_FILE = path.resolve(STORE_DIR, 'todos.json')

/** 单份清单允许的最大任务数 */
const MAX_TODO_ITEMS = 100
/** 单条任务描述的最大字符数 */
const MAX_DESCRIPTION_LENGTH = 200

const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

type TodoStatus = z.infer<typeof TodoStatusSchema>

type TodoItem = {
  id: string
  description: string
  status: TodoStatus
}

const TodoItemSchema = z.object({
  id: z.string().min(1).describe('任务唯一标识，建议使用简短稳定的字符串，如 1、2、setup-db。'),
  description: z
    .string()
    .min(1)
    .max(MAX_DESCRIPTION_LENGTH)
    .describe('任务描述，一句话说明要做什么。'),
  status: TodoStatusSchema.describe(
    '任务状态：pending（待办）、in_progress（进行中）、completed（已完成）。'
  ),
})

/** 持久化文件的内容结构 */
const TodoStoreSchema = z.object({
  updatedAt: z.string(),
  items: z.array(TodoItemSchema),
})

type TodoStore = z.infer<typeof TodoStoreSchema>

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[-]',
  completed: '[x]',
}

type TodoListResult =
  | {
      success: true
      action: 'create' | 'update' | 'list'
      storePath: string
      total: number
      pending: number
      inProgress: number
      completed: number
      items: TodoItem[]
      /** 面向人类阅读的清单视图 */
      view: string
    }
  | { success: false; error: string }

/** 读取持久化的任务清单；文件不存在或损坏时返回空清单 */
const readStore = async (): Promise<TodoStore> => {
  try {
    const raw = await readFile(STORE_FILE, { encoding: 'utf-8' })
    const parsed = TodoStoreSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      return { updatedAt: new Date().toISOString(), items: [] }
    }
    return parsed.data
  } catch {
    return { updatedAt: new Date().toISOString(), items: [] }
  }
}

/** 写入任务清单（自动创建目录） */
const writeStore = async (items: TodoItem[]): Promise<TodoStore> => {
  const store: TodoStore = {
    updatedAt: new Date().toISOString(),
    items,
  }
  await mkdir(STORE_DIR, { recursive: true })
  await writeFile(STORE_FILE, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf-8',
  })
  return store
}

/** 渲染成便于模型和用户阅读的清单文本 */
const renderView = (items: TodoItem[]): string => {
  if (items.length === 0) {
    return '（当前任务清单为空）'
  }
  return items
    .map((item) => `${STATUS_ICON[item.status]} ${item.id}. ${item.description}`)
    .join('\n')
}

/** 组装统一的成功返回结构 */
const buildResult = (
  action: 'create' | 'update' | 'list',
  items: TodoItem[]
): TodoListResult => ({
  success: true,
  action,
  storePath: path.relative(PROJECT_ROOT, STORE_FILE),
  total: items.length,
  pending: items.filter((item) => item.status === 'pending').length,
  inProgress: items.filter((item) => item.status === 'in_progress').length,
  completed: items.filter((item) => item.status === 'completed').length,
  items,
  view: renderView(items),
})

/** 校验同一份清单内 id 不重复 */
const findDuplicateId = (items: TodoItem[]): string | undefined => {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) return item.id
    seen.add(item.id)
  }
  return undefined
}

export const todoListTool = () => {
  return tool({
    description:
      '管理当前工作的任务清单（TODO List），用于把复杂任务拆解成可跟踪的步骤。支持 create（用新清单整体覆盖）、update（按 id 增量新增或更新任务）、list（只读取当前清单）三种操作。清单持久化在项目内的 .ai-assistant/todos.json，返回最新的完整清单与可读视图。操作失败时返回错误信息而不抛异常。',
    inputSchema: z.object({
      action: z
        .enum(['create', 'update', 'list'])
        .describe(
          '操作类型：create 用传入的 items 覆盖整个清单；update 按 id 增量新增或更新任务（未提及的任务保持不变）；list 只返回当前清单，无需传 items。'
        ),
      items: z
        .array(TodoItemSchema)
        .optional()
        .describe(
          '任务项数组，create 与 update 时必填，list 时忽略。每项包含 id、description、status 三个字段。'
        ),
    }),
    execute: async ({ action, items }): Promise<TodoListResult> => {
      console.log(`tools-call : todoListTool`)

      try {
        if (action === 'list') {
          const store = await readStore()
          return buildResult('list', store.items)
        }

        if (!items || items.length === 0) {
          return {
            success: false,
            error: `action 为 ${action} 时必须提供非空的 items 数组`,
          }
        }

        if (items.length > MAX_TODO_ITEMS) {
          return {
            success: false,
            error: `任务数量超限：单次最多 ${MAX_TODO_ITEMS} 条，当前 ${items.length} 条`,
          }
        }

        const duplicated = findDuplicateId(items)
        if (duplicated) {
          return {
            success: false,
            error: `任务 id 重复：${duplicated}`,
          }
        }

        if (action === 'create') {
          const store = await writeStore(items)
          return buildResult('create', store.items)
        }

        // action === 'update'：按 id 合并，保留原有顺序，新 id 追加到末尾
        const current = await readStore()
        const merged: TodoItem[] = current.items.map((existing) => {
          const patch = items.find((item) => item.id === existing.id)
          return patch ?? existing
        })
        const existingIds = new Set(current.items.map((item) => item.id))
        for (const item of items) {
          if (!existingIds.has(item.id)) {
            merged.push(item)
          }
        }

        if (merged.length > MAX_TODO_ITEMS) {
          return {
            success: false,
            error: `任务数量超限：清单最多 ${MAX_TODO_ITEMS} 条，合并后为 ${merged.length} 条`,
          }
        }

        const store = await writeStore(merged)
        return buildResult('update', store.items)
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}