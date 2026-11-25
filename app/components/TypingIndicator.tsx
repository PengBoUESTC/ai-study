"use client";
// 推荐：react-markdown，对不完整 Markdown 有较好的容错性
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useDeferredValue } from 'react'

interface TypingIndicatorProps {
  content: string;
  isStreaming: boolean;
}

export function TypingIndicator({
  content = '',
  isStreaming,
}: TypingIndicatorProps) {

  // const renderContent = useDeferredValue(content)
  return (
    <div className="relative">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      {isStreaming && (
        <span className="inline-block w-2 h-5 bg-gray-800 ml-0.5 animate-pulse" />
      )}
    </div>
  );
}