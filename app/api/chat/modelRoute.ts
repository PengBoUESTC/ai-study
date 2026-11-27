import { generateText, Output } from 'ai'
import type { ModelMessage } from 'ai'
import { deepseek } from '@ai-sdk/deepseek'
import { z } from 'zod'


/**
 * 从 UI 消息列表中提取用于模型路由的文本。
 * 优先取最后一条含文本的 user 消息；若不存在，则退化为最后一条含文本的消息；都没有时返回空字符串。
 */
export function extractRoutingText(messages: ModelMessage[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = message.content as string
    if (text) return text
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const text = message.content as string
    if (text) return text
  }

  return ''
}

/** 路由决策的结构化输出 schema（提取为常量，便于用 z.infer 推导类型，避免重复声明联合类型） */
const routingSchema = z.object({
  complexity: z.enum(['simple', 'medium', 'hard']).describe("问题难度等级"),
  taskType: z.enum(['chat', 'analysis', 'coding', 'translation', 'creative']),
  estimatedTokens: z.number().describe('预估需要的输出 token 数'),
})

type Routing = z.infer<typeof routingSchema>
type Complexity = Routing['complexity']

/**
 * 三档难度 → DeepSeek 模型 id 映射。
 * 只使用 @ai-sdk/deepseek 模型目录中真实存在的 id。
 */
export const COMPLEXITY_MODEL_MAP = {
  // 简单：闲聊 / 简短问答，选最轻量、最快、最便宜的 flash
  simple: 'deepseek-v4-flash',
  // 中等：一般分析、翻译、短代码，v4-flash 在质量与成本之间最均衡
  medium: 'deepseek-v4-flash',
  // 困难：复杂推理、长代码、深度分析，用能力最强的 v4-pro
  hard: 'deepseek-v4-pro',
} as const satisfies Record<Complexity, string>

/** 默认兜底档位：非法/缺失的难度统一按 medium 处理 */
const DEFAULT_COMPLEXITY: Complexity = 'medium'

/** 把难度解析为具体的模型id，非法/缺失值兜底为 medium 档，不抛异常 */
export function resolveModelId(
  complexity: Complexity | undefined | null
): (typeof COMPLEXITY_MODEL_MAP)[Complexity] {
  return complexity && complexity in COMPLEXITY_MODEL_MAP
    ? COMPLEXITY_MODEL_MAP[complexity]
    : COMPLEXITY_MODEL_MAP[DEFAULT_COMPLEXITY]
}

/** 根据难度返回对应的 DeepSeek LanguageModel 实例，非法/缺失值兜底为 medium 档 */
export function resolveModel(complexity: Complexity | undefined | null) {
  return deepseek(resolveModelId(complexity))
}

export const selectModel = async (question: string) => {
  const result = await generateText({
    model: deepseek('deepseek-flash'),
    prompt: `分析以下用户消息的任务复杂度和类型：\n${question}`,
    output: Output.object({ schema: routingSchema })
  })

  const modelId = resolveModelId(result.output.complexity)

  console.log(
    `[ModelRoute] complexity=${result.output.complexity} taskType=${result.output.taskType} estimatedTokens=${result.output.estimatedTokens} modelId=${modelId}`
  )

  return { ...result.output, modelId }
}
