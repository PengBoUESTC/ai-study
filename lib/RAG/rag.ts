import { embed } from 'ai'
import { createAlibaba } from '@ai-sdk/alibaba'
let done = false

const alibaba = createAlibaba({
  embeddingBaseURL: "https://llm-3vy77v4cfq140nxv.cn-beijing.maas.aliyuncs.com/api/v1"
})

export const embedding = async (content: string) => {
  try {
    if (done || !content) return ;
    console.log('content :: ', content)
    const { embedding } = await embed({
      model: alibaba.embedding('qwen3.7-text-embedding-flash'),
      value: content,
    })
    done = true
    console.log('embedding :: content', embedding[0])
  } catch (e) {
    console.error(e)
  }
}