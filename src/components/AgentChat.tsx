import React, { useState, useRef, useEffect } from "react";
import {
  Send,
  Trash2,
  Paperclip,
  Mic,
  Bot,
  User,
  ShieldCheck,
  FolderKanban,
  Sparkles,
  ClipboardCheck,
  X,
  Loader,
} from "lucide-react";
import { Repo, Message, Attachment } from "../types";

interface AgentChatProps {
  activeRepo: Repo | null;
  activeBranch: string;
  githubToken: string;
  messages: Message[];
  onSendMessage: (msg: Message) => void;
  onClearChat: () => void;
}

export const AgentChat: React.FC<AgentChatProps> = ({
  activeRepo,
  activeBranch,
  githubToken,
  messages,
  onSendMessage,
  onClearChat,
}) => {
  const [inputText, setInputInputText] = useState<string>("");
  const [isThinking, setIsThinking] = useState<boolean>(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [executedLogs, setExecutedLogs] = useState<string[]>([]);

  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<any>(null);

  // Auto-scroll to bottom of chat
  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isThinking, executedLogs]);

  // Speech Recognition (Voice Input)
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = "en-US";

      rec.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInputInputText((prev) => (prev ? prev + " " + transcript : transcript));
      };

      rec.onerror = (err: any) => {
        console.error("Speech Recognition Error", err);
        setIsRecording(false);
      };

      rec.onend = () => {
        setIsRecording(false);
      };

      recognitionRef.current = rec;
    }
  }, []);

  const handleMicToggle = () => {
    if (!recognitionRef.current) {
      alert("Microphone/Speech voice input is not supported in this browser.");
      return;
    }

    if (isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
    } else {
      try {
        setIsRecording(true);
        recognitionRef.current.start();
      } catch (err) {
        setIsRecording(false);
        console.error(err);
      }
    }
  };

  const handleFileAttachment = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();

      const base64Data = await new Promise<string>((resolve) => {
        reader.onload = (event) => resolve(event.target?.result as string);
        reader.readAsDataURL(file);
      });

      setAttachments((prev) => [
        ...prev,
        {
          name: file.name,
          mime: file.type || "application/octet-stream",
          data: base64Data,
        },
      ]);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleSend = async () => {
    if (isThinking) return;
    const textClean = inputText.trim();
    if (!textClean && attachments.length === 0) return;

    // Create user message
    const userMsg: Message = {
      id: Math.random().toString(),
      role: "user",
      content: textClean,
      timestamp: new Date().toLocaleTimeString(),
      attachments: attachments.length > 0 ? [...attachments] : undefined,
    };

    onSendMessage(userMsg);
    setInputInputText("");
    setAttachments([]);
    setIsThinking(true);
    setExecutedLogs([]);

    // Format historical messages for Gemini context
    // Include attachments context inside message body if present
    const payloadMessages = messages.map((m) => {
      let combinedContent = m.content;
      if (m.attachments && m.attachments.length > 0) {
        m.attachments.forEach((att) => {
          if (att.mime.startsWith("text/") || att.name.endsWith(".txt") || att.name.endsWith(".json")) {
            combinedContent += `\n\n--- ATTACHED FILE "${att.name}" ---\n${att.data}`;
          } else {
            combinedContent += `\n\n--- ATTACHED ASSET "${att.name}" (${att.mime}) ---`;
          }
        });
      }
      return {
        role: m.role,
        content: combinedContent,
      };
    });

    // Append the newly created user message to payload
    let newUserCombined = userMsg.content;
    if (userMsg.attachments && userMsg.attachments.length > 0) {
      userMsg.attachments.forEach((att) => {
        if (att.mime.startsWith("text/") || att.name.endsWith(".txt") || att.name.endsWith(".json") || att.name.endsWith(".ts") || att.name.endsWith(".tsx") || att.name.endsWith(".js") || att.name.endsWith(".css") || att.name.endsWith(".html") || att.name.endsWith(".md")) {
          // If plain text content base64, try to decode
          let contentStr = att.data;
          if (att.data.includes("base64,")) {
            try {
              contentStr = atob(att.data.split("base64,")[1]);
            } catch (e) {}
          }
          newUserCombined += `\n\n--- ATTACHED FILE "${att.name}" ---\n${contentStr}`;
        } else {
          newUserCombined += `\n\n--- ATTACHED ASSET "${att.name}" (${att.mime}) ---`;
        }
      });
    }

    payloadMessages.push({
      role: "user",
      content: newUserCombined,
    });

    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: payloadMessages,
          token: githubToken,
          repo: activeRepo ? activeRepo.full_name : null,
          branch: activeBranch || "main",
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Gemini Agent request failed.");
      }

      // Display executing tool actions
      if (data.executed && data.executed.length > 0) {
        setExecutedLogs(data.executed);
      }

      const assistantMsg: Message = {
        id: Math.random().toString(),
        role: "assistant",
        content: data.content || "I have analyzed your repository and updated changes.",
        timestamp: new Date().toLocaleTimeString(),
      };

      onSendMessage(assistantMsg);
    } catch (err: any) {
      onSendMessage({
        id: Math.random().toString(),
        role: "assistant",
        content: `❌ AI Agent Connection Error:\n\n${err.message || "An error occurred with Gemini Agent endpoint."}`,
        timestamp: new Date().toLocaleTimeString(),
      });
    } finally {
      setIsThinking(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Simple renderer for formatting code blocks inside chat messages
  const renderMessageContent = (text: string) => {
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((part, index) => {
      if (part.startsWith("```") && part.endsWith("```")) {
        const lines = part.split("\n");
        const match = lines[0].match(/```(\w+)?/);
        const language = match ? match[1] : "code";
        const code = lines.slice(1, -1).join("\n");

        return (
          <div key={index} className="my-2 border border-slate-800 rounded-lg overflow-hidden shrink-0">
            <div className="bg-slate-950 px-3.5 py-1.5 flex items-center justify-between text-[10px] text-slate-400 font-mono select-none">
              <span>{language?.toUpperCase() || "CODE"}</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(code);
                  alert("✓ Copied code block to clipboard");
                }}
                className="text-blue-400 hover:text-blue-300 flex items-center gap-1 font-semibold"
              >
                <ClipboardCheck className="w-3.5 h-3.5" />
                Copy
              </button>
            </div>
            <pre className="p-3 bg-slate-900 overflow-x-auto text-[11px] font-mono text-slate-100 leading-relaxed whitespace-pre">
              <code>{code}</code>
            </pre>
          </div>
        );
      }
      return (
        <p key={index} className="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">
          {part}
        </p>
      );
    });
  };

  return (
    <div id="screen-agent" className="flex flex-col h-[calc(100vh-140px)] animate-fadein">
      {/* Title */}
      <div className="mb-2 shrink-0">
        <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
          🤖 AI Agent Control
        </h2>
        <p className="text-xs text-slate-400">Instruct Gemini to list, read, edit, or search code directly on your GitHub</p>
      </div>

      {/* Main Agent Panel */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col flex-1 min-h-0">
        {/* Header bar */}
        <div className="bg-slate-950 px-4 py-2.5 flex items-center justify-between border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
            <div className={`w-2 h-2 rounded-full ${isThinking ? "bg-amber-500 animate-ping" : "bg-emerald-500"}`} />
            <span>{isThinking ? "Agent is thinking..." : "Gemini Agent Status: Ready"}</span>
          </div>
          <button
            onClick={() => {
              if (window.confirm("Clear conversation log?")) onClearChat();
            }}
            className="text-slate-500 hover:text-rose-400 flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear chat
          </button>
        </div>

        {/* Dynamic Context banner */}
        <div className="bg-slate-950/65 px-4 py-1.5 flex flex-wrap gap-x-4 gap-y-1 items-center border-b border-slate-850 shrink-0 text-[10px] text-slate-400 font-mono">
          <span className="flex items-center gap-1">
            <FolderKanban className="w-3.5 h-3.5 text-blue-500" />
            Active: <strong className="text-blue-400">{activeRepo ? activeRepo.name : "None"}</strong>
          </span>
          <span className="flex items-center gap-1">
            🌿 Branch: <strong className="text-emerald-400">{activeBranch}</strong>
          </span>
          <span className="flex items-center gap-1 ml-auto">
            <ShieldCheck className="w-3.5 h-3.5 text-blue-400" />
            Token: <strong className={githubToken ? "text-emerald-400" : "text-rose-500"}>{githubToken ? "SECURE" : "MISSING"}</strong>
          </span>
        </div>

        {/* Messages space */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-950/20">
          {messages.map((m) => {
            const isAss = m.role === "assistant";
            return (
              <div
                key={m.id}
                className={`flex gap-3 max-w-[85%] animate-fadein ${
                  isAss ? "self-start" : "self-end ml-auto flex-row-reverse"
                }`}
              >
                {/* Avatar */}
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                    isAss ? "bg-blue-600 text-white shadow-md shadow-blue-900/30" : "bg-slate-800 text-slate-300"
                  }`}
                >
                  {isAss ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
                </div>

                {/* Message Bubble */}
                <div className="space-y-1.5">
                  <div
                    className={`p-3.5 rounded-xl border text-xs sm:text-sm ${
                      isAss
                        ? "bg-slate-900 border-slate-800 text-slate-200"
                        : "bg-blue-600 border-blue-500 text-white font-medium"
                    }`}
                  >
                    {/* Render attachments first if user sent them */}
                    {!isAss && m.attachments && m.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2 border-b border-blue-500 pb-2">
                        {m.attachments.map((att, i) => (
                          <span
                            key={i}
                            className="bg-blue-700/80 px-2 py-0.5 rounded text-[10px] font-mono flex items-center gap-1"
                          >
                            📎 {att.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {isAss ? renderMessageContent(m.content) : m.content}
                  </div>
                  <div
                    className={`text-[9px] font-mono text-slate-500 ${!isAss ? "text-right" : ""}`}
                  >
                    {m.timestamp}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Executed Tools progress logs */}
          {executedLogs.length > 0 && (
            <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl space-y-1.5 max-w-[85%] self-start animate-fadein">
              <span className="text-[10px] font-bold text-emerald-400 font-mono flex items-center gap-1 uppercase select-none">
                <Sparkles className="w-3.5 h-3.5" /> Agent Action Logs
              </span>
              <div className="font-mono text-[10px] text-slate-400 space-y-1">
                {executedLogs.map((log, idx) => (
                  <div key={idx} className="flex gap-2">
                    <span className="text-slate-600">[{idx + 1}]</span>
                    <span>{log}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Thinking animation loader */}
          {isThinking && (
            <div className="flex gap-3 max-w-[85%] self-start animate-pulse">
              <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center shrink-0 text-slate-400">
                <Loader className="w-4 h-4 animate-spin text-amber-500" />
              </div>
              <div className="p-3.5 bg-slate-900 border border-slate-800 rounded-xl text-slate-400 text-xs">
                Gemini is coordinating workspace context and building solutions...
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Input attachment display bar */}
        {attachments.length > 0 && (
          <div className="bg-slate-950 border-t border-slate-850 px-4 py-2 flex flex-wrap gap-2 shrink-0">
            {attachments.map((att, i) => (
              <div
                key={i}
                className="bg-slate-900 border border-slate-800 px-2 py-1 rounded-lg text-[10px] text-slate-300 font-mono flex items-center gap-1.5 animate-fadein"
              >
                <span>📎 {att.name}</span>
                <button
                  onClick={() => removeAttachment(i)}
                  className="text-slate-500 hover:text-rose-400 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input form panel */}
        <div className="bg-slate-950 p-3 flex gap-2 border-t border-slate-800 shrink-0">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileAttachment}
            multiple
            className="hidden"
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-11 h-11 shrink-0 border border-slate-800 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-200 active:bg-slate-900 transition-all cursor-pointer"
            title="Attach file"
          >
            <Paperclip className="w-5 h-5" />
          </button>

          <button
            onClick={handleMicToggle}
            className={`w-11 h-11 shrink-0 border border-slate-800 rounded-xl flex items-center justify-center transition-all cursor-pointer ${
              isRecording
                ? "bg-rose-950/40 border-rose-600/50 text-rose-400 animate-pulse"
                : "text-slate-400 hover:text-slate-200 active:bg-slate-900"
            }`}
            title="Voice speech text dictation"
          >
            <Mic className="w-5 h-5" />
          </button>

          <textarea
            value={inputText}
            onChange={(e) => setInputInputText(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder={githubToken ? "Ask Gemini to build and commit features..." : "Please configure GitHub token to chat"}
            disabled={!githubToken}
            className="w-full h-11 p-3 bg-slate-900/60 border border-slate-850 hover:border-slate-800 focus:border-blue-500 rounded-xl text-slate-200 text-xs sm:text-sm outline-none resize-none leading-relaxed transition"
          />

          <button
            onClick={handleSend}
            disabled={(!inputText.trim() && attachments.length === 0) || isThinking || !githubToken}
            className="w-11 h-11 shrink-0 bg-blue-600 hover:bg-blue-500 text-white rounded-xl flex items-center justify-center active:scale-90 disabled:opacity-40 disabled:scale-100 transition cursor-pointer"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
