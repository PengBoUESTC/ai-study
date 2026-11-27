import { ModelMessage, generateText } from 'ai'
import { deepseek } from '@ai-sdk/deepseek'

const MAX_LEN = 10
export const compressHistory = async (messages: ModelMessage[]): Promise<{
  messages: ModelMessage[],
  instructions: string
}> => {
    if (messages.length <= MAX_LEN) {
    return { instructions: '', messages };
  }
  const preMessages = messages.slice(0, messages.length - MAX_LEN)

  const lastMessages = messages.slice(-MAX_LEN)
  const result = await generateText({
    model: deepseek('deepseek-flash'),
    instructions: `你是一个对话摘要助手。请将以下对话历史压缩为一段简洁的摘要，
保留所有重要信息，包括：
- 用户的身份信息（名字、位置、职业等）
- 用户表达的偏好和需求
- 做出的决定和达成的共识
- 关键的事实和数据
删除寒暄、重复和无关信息。用第三人称描述。`,
    prompt: preMessages.map(m => `${m.role}: ${m.content}`).join('\n')
  })

  return {
    instructions: `[之前的对话摘要] ${result.text}`,
    // 摘要 应该放在 下轮对话的 message 中还是 instructions 中
    messages: [{
      role: 'system',
      content: `[之前的对话摘要] ${result.text}`,
    }, ...lastMessages]
  }
}