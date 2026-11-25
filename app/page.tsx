"use client";

import { useState, type SubmitEvent } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { TypingIndicator } from '@/app/components/TypingIndicator'
// 从一条消息的 parts 里提取文本（v7 的消息内容从 content 字符串变成了 parts 数组）
function messageText(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

export default function ChatPage() {
  // v7 的 useChat 不再提供 input / handleInputChange，输入框自己用 useState 管理
  const [input, setInput] = useState("");

  const {
    messages,    // 消息列表 UIMessage[]
    sendMessage, // 发送一条消息并触发生成（旧版的 handleSubmit + append）
    status,      // 'submitted' | 'streaming' | 'ready' | 'error'（旧版是 isLoading）
    stop,        // 停止生成
    error,       // 错误信息
    regenerate,  // 重新生成最后一条回复（旧版的 reload）
  } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }), // 旧版的 api 选项移到了 transport 里
    onFinish({ message }) {          // 一条消息完全生成后的回调（参数从 message 变成 { message }）
      console.log("生成完毕:", message);
    },
    onError(error) {             // 错误回调
      console.error("出错了:", error);
    },
  });

  // 旧版的 isLoading 由 status 推导：正在等待或正在流式输出都算"加载中"
  const isLoading = status === "submitted" || status === "streaming";

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    sendMessage({ text }); // 发送并触发 AI 生成
    setInput("");
  };

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto">
      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${
              message.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 ${
                message.role === "user"
                  ? "bg-blue-500 text-white"
                  : "bg-gray-100 text-gray-900"
              }`}
            >
              {TypingIndicator({ content: messageText(message), isStreaming: true })}
            </div>
          </div>
        ))}
      </div>

      {/* 输入区域 */}
      <form onSubmit={handleSubmit} className="border-t p-4 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入你的问题..."
          className="flex-1 border rounded-lg px-4 py-2"
          disabled={isLoading}
        />
        {isLoading ? (
          <button
            type="button"
            onClick={stop}
            className="px-4 py-2 bg-red-500 text-white rounded-lg"
          >
            停止
          </button>
        ) : (
          <button
            type="submit"
            className="px-4 py-2 bg-blue-500 text-white rounded-lg"
          >
            发送
          </button>
        )}
      </form>
    </div>
  );
}