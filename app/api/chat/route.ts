// app/api/chat/route.ts
import { streamText, convertToModelMessages, toUIMessageStream, createUIMessageStreamResponse, UIMessage } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from 'zod'
import { WORK_ASSISTANT_PROMPT } from "@/prompts/work-assistant";

const RequestSchema = z.object({
  // v7 的 UI 消息没有 content，而是 parts 数组
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      parts: z.array(z.unknown()).min(1), // 至少一个 part（文本/工具调用等）
    })
  ).min(1).max(50), // 限制对话历史长度
});

export async function POST(req: Request) {
  try {
    const body = await req.json(); // 客户端 useChat 发来的是 UI 消息（含 parts）
  
    const { data, error, success } = RequestSchema.safeParse(body)
  
    if (!success) {
      return new Response(
        JSON.stringify({ error: "Invalid request", details: error }),
        { status: 400 }
      );
    }
  
    const { messages } = data
    const result = streamText({
      model: deepseek("deepseek-chat"),
      instructions: WORK_ASSISTANT_PROMPT.system,
      maxOutputTokens: 2000,
      // UI 消息要先转成模型消息（含 role/content），streamText 才能消费
      messages: await convertToModelMessages(messages as unknown as UIMessage[]),
      onFinish({ usage }) {
        // 记录 Token 使用量（用于成本监控）
        console.log(
          `[Chat] Tokens used - prompt: ${usage.inputTokens}, completion: ${usage.outputTokens}`
        );
      },
    });
  
    return createUIMessageStreamResponse({
      stream: toUIMessageStream({ stream: result.stream }),
    });
  } catch (error) {
    console.error("Chat API error:", error);

    if (error instanceof Error) {
      if (error.message.includes('rate_limit')) {
        return new Response(JSON.stringify({ error: "请求过于频繁，请稍后再试"  }), { status: 429 })
      }
      if (error.message.includes("insufficient_quota")) {
        return new Response(
          JSON.stringify({ error: "API 额度不足" }),
          { status: 503 }
        );
      }
    }

    return new Response(JSON.stringify({ error: "服务暂时不可用，请稍后重试" }), {
      status: 500
    })
  }
}