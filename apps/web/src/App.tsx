import { type ChangeEvent, type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Copy,
  Download,
  ImageIcon,
  LogOut,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  Shield,
  SquarePen,
  Trash2,
  UserPlus,
  Wand2,
  X
} from "lucide-react";
import type { ChatMessage, Conversation, ConversationMode, ModelRecord, User } from "@gptlite/shared";
import { api, readEventStream } from "./api";
import { useAppStore } from "./store";

type EditingState = Pick<ChatMessage, "id" | "conversationId" | "content"> | null;

interface ImageMessagePayload {
  type: "image_result";
  prompt: string;
  outputFormat?: string;
  images: Array<{
    id: string;
    url: string | null;
    base64: string | null;
    mimeType?: string | null;
    extension?: string | null;
  }>;
}

interface PreviewImage {
  src: string;
  prompt: string;
  id: string;
  extension?: string | null;
}

interface ReferenceImage {
  id: string;
  name: string;
  type: string;
  data: string;
}

interface ImageParams {
  size: string;
  quality: "auto" | "low" | "medium" | "high";
  output_format: "png" | "jpeg" | "webp";
  output_compression: number | null;
  moderation: "auto" | "low";
  n: number;
}

interface StreamingState {
  conversationId: string;
  userContent?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  assistantContent: string;
}

const IMAGE_MESSAGE_PREFIX = "__gptlite_image__:";
const DEFAULT_IMAGE_PARAMS: ImageParams = {
  size: "auto",
  quality: "auto",
  output_format: "png",
  output_compression: null,
  moderation: "auto",
  n: 1
};

const aspectRatioOptions = [
  { value: "auto", label: "自动", ratio: "" },
  { value: "1:1", label: "方形", ratio: "1:1" },
  { value: "3:4", label: "竖版", ratio: "3:4" },
  { value: "9:16", label: "故事", ratio: "9:16" },
  { value: "4:3", label: "横屏", ratio: "4:3" },
  { value: "16:9", label: "宽屏", ratio: "16:9" }
] as const;

const modeLabels: Record<ConversationMode, string> = {
  chat: "ChatGPT",
  thinking: "Thinking",
  image: "Image"
};

export default function App() {
  const meQuery = useQuery({ queryKey: ["me"], queryFn: api.me });

  if (meQuery.isLoading) {
    return <Splash />;
  }

  if (meQuery.data?.setupRequired) {
    return <AuthScreen mode="setup" />;
  }

  if (!meQuery.data?.user) {
    return <AuthScreen mode="login" />;
  }

  return <ChatShell user={meQuery.data.user} />;
}

function Splash() {
  return (
    <main className="auth-screen">
      <div className="brand-mark">
        <Bot size={28} />
      </div>
    </main>
  );
}

function AuthScreen({ mode }: { mode: "login" | "setup" }) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "setup") {
        await api.setup({ username, password });
      } else {
        await api.login({ username, password });
      }
      const me = await api.me();
      if (!me.user) {
        throw new Error("登录成功但浏览器没有保存登录态，请检查是否使用 HTTPS 或允许 Cookie");
      }
      queryClient.setQueryData(["me"], me);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="auth-panel" onSubmit={submit}>
        <div className="brand-mark">
          {mode === "setup" ? <Shield size={28} /> : <Bot size={28} />}
        </div>
        <h1>{mode === "setup" ? "初始化管理员" : "登录 gptlite"}</h1>
        <label>
          <span>用户名</span>
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        <label>
          <span>密码</span>
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete={mode === "setup" ? "new-password" : "current-password"}
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "处理中" : mode === "setup" ? "创建并进入" : "进入"}
        </button>
      </form>
    </main>
  );
}

function ChatShell({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const {
    activeConversationId,
    drawerOpen,
    mode,
    adminOpen,
    setActiveConversationId,
    setDrawerOpen,
    setMode,
    setAdminOpen
  } = useAppStore();
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [editing, setEditing] = useState<EditingState>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageOptionsOpen, setImageOptionsOpen] = useState(false);
  const [imageParams, setImageParams] = useState<ImageParams>(DEFAULT_IMAGE_PARAMS);
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);

  const conversationsQuery = useQuery({
    queryKey: ["conversations", search],
    queryFn: () => api.conversations(search)
  });
  const messagesQuery = useQuery({
    queryKey: ["messages", activeConversationId],
    queryFn: () => api.messages(activeConversationId!),
    enabled: Boolean(activeConversationId)
  });

  const messages = messagesQuery.data ?? [];
  const conversations = useMemo(
    () => [...(conversationsQuery.data ?? [])].sort(compareConversationsByRecency),
    [conversationsQuery.data]
  );
  const currentConversation = conversations.find((item) => item.id === activeConversationId);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 152)}px`;
  }, [draft]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const visibleMessages = useMemo(() => {
    const next = [...messages];
    if (streaming && streaming.conversationId === activeConversationId) {
      if (streaming.userContent && !next.some((message) => message.id === streaming.userMessageId)) {
        next.push(makeLocalMessage("local-user", streaming.conversationId, "user", streaming.userContent));
      }
      if (!next.some((message) => message.id === streaming.assistantMessageId)) {
        next.push(makeLocalMessage("local-assistant", streaming.conversationId, "assistant", streaming.assistantContent, "streaming"));
      }
    }
    return next;
  }, [activeConversationId, messages, streaming]);
  const selectedAspectRatio =
    aspectRatioOptions.find((option) => option.value === imageParams.size) ?? aspectRatioOptions[0];

  async function ensureConversation(initialText?: string) {
    if (activeConversationId) {
      return activeConversationId;
    }
    const conversation = await api.createConversation({
      title: initialText ? initialText.replace(/\s+/g, " ").slice(0, 28) : "新会话",
      mode
    });
    setActiveConversationId(conversation.id);
    await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    return conversation.id;
  }

  async function consumeStream(response: Response, conversationId: string, userContent?: string) {
    let userMessageId: string | undefined;
    let assistantMessageId = "";
    let assistantContent = "";
    setStreaming({ conversationId, userContent, assistantContent: "" });
    await readEventStream(response, (event) => {
      if (event.event === "meta") {
        userMessageId = event.data.userMessageId;
        assistantMessageId = event.data.assistantMessageId;
        setStreaming((current) =>
          current
            ? {
                ...current,
                userMessageId: event.data.userMessageId,
                assistantMessageId: event.data.assistantMessageId
              }
            : current
        );
      }
      if (event.event === "delta") {
        assistantContent += event.data.content;
        setStreaming((current) =>
          current ? { ...current, assistantContent: current.assistantContent + event.data.content } : current
        );
      }
      if (event.event === "done") {
        assistantContent = event.data.content;
      }
      if (event.event === "error") {
        setNotice(event.data.message);
      }
    });

    if (assistantMessageId) {
      writeStreamResultToCache({
        queryClient,
        conversationId,
        userContent,
        userMessageId,
        assistantMessageId,
        assistantContent
      });
    }
  }

  async function sendChat(content: string) {
    const conversationId = await ensureConversation(content);
    abortRef.current = new AbortController();
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        mode,
        message: content,
        temperature: 0.7
      }),
      signal: abortRef.current.signal
    });
    await consumeStream(response, conversationId, content);
    return conversationId;
  }

  async function regenerate(messageId: string, conversationId: string) {
    queryClient.setQueryData<ChatMessage[]>(["messages", conversationId], (current = []) =>
      current.filter((message) => message.id !== messageId)
    );
    abortRef.current = new AbortController();
    const response = await fetch(`/api/messages/${messageId}/regenerate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
      signal: abortRef.current.signal
    });
    await consumeStream(response, conversationId);
    return conversationId;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || streaming || imageBusy) {
      return;
    }

    setNotice("");
    setDraft("");
    let touchedConversationId = activeConversationId;

    try {
      if (mode === "image") {
        setImageBusy(true);
        const conversationId = await ensureConversation(content);
        touchedConversationId = conversationId;
        const result = await api.generateImage({
          prompt: content,
          size: imageParams.size,
          n: imageParams.n,
          quality: imageParams.quality,
          output_format: imageParams.output_format,
          output_compression: imageParams.output_format === "png" ? null : imageParams.output_compression,
          moderation: imageParams.moderation,
          conversationId,
          referenceImages: referenceImages.map(({ name, type, data }) => ({ name, type, data }))
        });
        appendMessagesToCache(queryClient, result.conversationId, result.messages);
        setActiveConversationId(result.conversationId);
        setReferenceImages([]);
        setEditing(null);
        setNotice("图片已生成");
        return;
      }

      if (editing) {
        touchedConversationId = editing.conversationId;
        await api.patchMessage(editing.id, content);
        setEditing(null);
        await regenerate(editing.id, editing.conversationId);
        return;
      }

      touchedConversationId = await sendChat(content);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setNotice(err instanceof Error ? err.message : "请求失败");
      }
    } finally {
      abortRef.current = null;
      setImageBusy(false);
      if (touchedConversationId) {
        await queryClient.invalidateQueries({ queryKey: ["messages", touchedConversationId] });
      }
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setStreaming(null);
    }
  }

  function stopStreaming() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(null);
  }

  function startNewConversation() {
    stopStreaming();
    setActiveConversationId(null);
    setDraft("");
    setEditing(null);
    setMode("chat");
    setImageOptionsOpen(false);
    setReferenceImages([]);
    setDrawerOpen(false);
  }

  async function addReferenceImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
    event.target.value = "";
    if (files.length === 0) {
      return;
    }

    try {
      const nextImages = await Promise.all(files.slice(0, 4).map(readReferenceImage));
      setReferenceImages((current) => [...current, ...nextImages].slice(0, 4));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "参考图读取失败");
    }
  }

  function removeReferenceImage(id: string) {
    setReferenceImages((current) => current.filter((image) => image.id !== id));
  }

  async function copyText(text: string) {
    await navigator.clipboard.writeText(text);
    setNotice("已复制");
  }

  async function deleteMessage(message: ChatMessage) {
    await api.deleteMessage(message.id);
    await queryClient.invalidateQueries({ queryKey: ["messages", message.conversationId] });
  }

  async function updateConversationTitle(id: string, currentTitle: string) {
    const title = window.prompt("重命名会话", currentTitle);
    if (!title?.trim()) {
      return;
    }
    await api.updateConversation(id, { title: title.trim() });
    await queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }

  async function deleteConversation(id: string) {
    if (!window.confirm("删除这个会话？")) {
      return;
    }
    await api.deleteConversation(id);
    if (activeConversationId === id) {
      setActiveConversationId(null);
    }
    await queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }

  async function logout() {
    await api.logout();
    await queryClient.invalidateQueries({ queryKey: ["me"] });
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="top-left">
          <button className="icon-button naked" type="button" title="菜单" onClick={() => setDrawerOpen(true)}>
            <Menu size={22} />
          </button>
          <button className="mode-pill" type="button" onClick={() => setModelOpen((open) => !open)}>
            <span>{modeLabels[mode]}</span>
            <ChevronDown size={16} />
          </button>
        </div>
        <div className="top-actions">
          <button className="icon-button naked" type="button" title="用户" onClick={() => setDrawerOpen(true)}>
            <UserPlus size={21} />
          </button>
          <button className="icon-button naked" type="button" title="新聊天" onClick={startNewConversation}>
            <SquarePen size={21} />
          </button>
        </div>
      </header>

      {modelOpen ? (
        <ModeSheet
          mode={mode}
          onMode={(nextMode) => {
            setMode(nextMode);
            setModelOpen(false);
          }}
          onClose={() => setModelOpen(false)}
        />
      ) : null}

      <section className="content-area">
        {visibleMessages.length === 0 ? (
          mode === "image" ? <ImageEmpty busy={imageBusy} /> : <Welcome />
        ) : (
          <>
            <MessageList
              messages={visibleMessages}
              onCopy={copyText}
              onDelete={deleteMessage}
              onRegenerate={(message) => regenerate(message.id, message.conversationId)}
              onEdit={(message) => {
                setEditing(message);
                setDraft(message.content);
              }}
              onPreview={setPreviewImage}
            />
            {mode === "image" && imageBusy ? <ImageLoading inline /> : null}
          </>
        )}
      </section>

      {notice ? (
        <button className="toast" type="button" onClick={() => setNotice("")}>
          {notice}
        </button>
      ) : null}

      {editing ? (
        <div className="editing-strip">
          <Pencil size={14} />
          <span>编辑后重发</span>
          <button type="button" onClick={() => setEditing(null)} title="取消编辑">
            <X size={14} />
          </button>
        </div>
      ) : null}

      {mode === "image" ? (
        <div className="image-control-stack">
          {imageOptionsOpen ? (
            <AspectRatioPanel
              value={imageParams.size}
              onSelect={(size) => {
                setImageParams((current) => ({ ...current, size }));
                setImageOptionsOpen(false);
              }}
            />
          ) : null}
          {referenceImages.length > 0 ? (
            <div className="reference-strip">
              {referenceImages.map((image) => (
                <figure key={image.id}>
                  <img src={image.data} alt="" />
                  <button type="button" title="移除参考图" onClick={() => removeReferenceImage(image.id)}>
                    <X size={13} />
                  </button>
                </figure>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <form className={mode === "image" ? "composer image-composer" : "composer"} onSubmit={submit}>
        {mode === "image" ? (
          <>
            <button
              className="composer-tool image-upload-trigger"
              type="button"
              title="上传参考图"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus size={21} />
            </button>
            <button
              className={referenceImages.length > 0 ? "image-mode-chip active" : "image-mode-chip"}
              type="button"
              title="上传参考图"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageIcon size={17} />
              <span>图片</span>
              <X size={14} />
            </button>
            <button
              className={imageOptionsOpen ? "image-auto-pill active" : "image-auto-pill"}
              type="button"
              title="生图参数"
              onClick={() => setImageOptionsOpen((open) => !open)}
            >
              <span>{selectedAspectRatio.label}</span>
              <ChevronDown size={15} />
            </button>
          </>
        ) : (
          <button className="composer-tool" type="button" title="新聊天" onClick={startNewConversation}>
            <Plus size={21} />
          </button>
        )}
        <input
          ref={fileInputRef}
          className="file-input"
          type="file"
          accept="image/*"
          multiple
          onChange={addReferenceImages}
        />
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={1}
          placeholder={mode === "image" ? "描述或编辑图片" : "你好"}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {streaming ? (
          <button className="send-button" type="button" title="停止生成" onClick={stopStreaming}>
            <CircleStop size={21} />
          </button>
        ) : (
          <button className="send-button" type="submit" title="发送" disabled={!draft.trim() || imageBusy}>
            {imageBusy ? <Wand2 className="send-spinner" size={20} /> : <Send size={19} />}
          </button>
        )}
      </form>

      <Drawer
        open={drawerOpen}
        user={user}
        conversations={conversations}
        activeConversationId={activeConversationId}
        search={search}
        onSearch={setSearch}
        onClose={() => setDrawerOpen(false)}
        onNew={startNewConversation}
        onSelect={(conversation) => {
          stopStreaming();
          setActiveConversationId(conversation.id);
          setMode(conversation.mode);
          setEditing(null);
          setDrawerOpen(false);
          void queryClient.invalidateQueries({ queryKey: ["messages", conversation.id] });
        }}
        onRename={updateConversationTitle}
        onDelete={deleteConversation}
        onLogout={logout}
        onAdmin={() => {
          setAdminOpen(true);
          setDrawerOpen(false);
        }}
      />

      {adminOpen && user.role === "admin" ? <AdminPanel onClose={() => setAdminOpen(false)} /> : null}

      <ImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />

      {currentConversation ? <span className="sr-only">{currentConversation.title}</span> : null}
    </main>
  );
}

function Welcome() {
  return (
    <div className="welcome">
      <h1>你在忙什么？</h1>
    </div>
  );
}

function ModeSheet(props: {
  mode: ConversationMode;
  onMode: (mode: ConversationMode) => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <section className="mode-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="segmented">
          {(["chat", "thinking", "image"] as ConversationMode[]).map((item) => (
            <button
              key={item}
              type="button"
              className={props.mode === item ? "active" : ""}
              onClick={() => props.onMode(item)}
            >
              {modeLabels[item]}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function MessageList(props: {
  messages: ChatMessage[];
  onCopy: (content: string) => void;
  onDelete: (message: ChatMessage) => void;
  onRegenerate: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onPreview: (image: PreviewImage) => void;
}) {
  return (
    <div className="message-list">
      {props.messages.map((message) => {
        const imagePayload = parseImageMessage(message.content);
        const copyContent = imagePayload?.prompt ?? message.content;

        return (
          <article key={message.id} className={`message-row ${message.role}`}>
            <div className="message-bubble">
              {imagePayload ? (
                <ImageResult payload={imagePayload} onPreview={props.onPreview} />
              ) : message.content ? (
                <MarkdownMessage content={message.content} />
              ) : message.status === "streaming" ? (
                <ThinkingIndicator />
              ) : (
                <span className="typing-cursor" />
              )}
            </div>
            <div className="message-actions">
              <button type="button" title="复制" onClick={() => props.onCopy(copyContent)}>
                <Copy size={14} />
              </button>
              {message.role === "assistant" && !imagePayload ? (
                <button type="button" title="重新生成" onClick={() => props.onRegenerate(message)}>
                  <RotateCcw size={14} />
                </button>
              ) : null}
              {message.role !== "assistant" ? (
                <button type="button" title="编辑并重发" onClick={() => props.onEdit(message)}>
                  <Pencil size={14} />
                </button>
              ) : null}
              <button type="button" title="删除" onClick={() => props.onDelete(message)}>
                <Trash2 size={14} />
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ children, className, ...rest }) {
          const value = String(children).replace(/\n$/, "");
          const block = value.includes("\n");
          if (!block) {
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          }
          return (
            <div className="code-block">
              <button type="button" title="复制代码" onClick={() => navigator.clipboard.writeText(value)}>
                <Copy size={13} />
              </button>
              <pre>
                <code className={className} {...rest}>
                  {value}
                </code>
              </pre>
            </div>
          );
        }
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function ThinkingIndicator() {
  return (
    <div className="thinking-indicator" role="status" aria-live="polite">
      <span className="thinking-mark">
        <Bot size={16} />
      </span>
      <span className="thinking-copy">思考中</span>
      <span className="thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function AspectRatioPanel(props: {
  value: string;
  onSelect: (size: string) => void;
}) {
  return (
    <section className="aspect-ratio-panel" aria-label="Choose image aspect ratio">
      <header>Choose image aspect ratio</header>
      <div className="aspect-ratio-list">
        {aspectRatioOptions.map((option) => (
          <button key={option.value} type="button" onClick={() => props.onSelect(option.value)}>
            <span className={`ratio-icon ratio-${option.value.replace(":", "-")}`} aria-hidden="true" />
            <span className="ratio-label">{option.label}</span>
            {option.ratio ? <span className="ratio-value">{option.ratio}</span> : null}
            {props.value === option.value ? <Check className="ratio-check" size={17} /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function ImageEmpty({ busy }: { busy: boolean }) {
  return (
    <div className="image-empty">
      {busy ? <ImageLoading /> : <ImageIcon size={30} />}
      {!busy ? <h1>创建图片</h1> : null}
    </div>
  );
}

function ImageLoading({ inline = false }: { inline?: boolean }) {
  return (
    <div className={inline ? "image-loading inline" : "image-loading"}>
      <span className="image-loading-icon">
        <Wand2 size={22} />
      </span>
      <span className="image-loading-copy">
        <strong>生成图片中</strong>
        <small>正在整理提示词和参考图</small>
      </span>
      <span className="image-loading-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function ImageResult(props: {
  payload: ImageMessagePayload;
  onPreview: (image: PreviewImage) => void;
}) {
  const images = props.payload.images
    .map((image) => ({ ...image, src: imageSource(image) }))
    .filter((image) => image.src);

  if (images.length === 0) {
    return <span className="image-placeholder-text">图片结果为空</span>;
  }

  return (
    <div className="generated-image-result">
      <div className="generated-image-grid">
        {images.map((image) => (
          <figure key={image.id} className="generated-image-card">
            <button
              className="generated-image-open"
              type="button"
              title="预览图片"
              onClick={() =>
                props.onPreview({
                  id: image.id,
                  src: image.src,
                  prompt: props.payload.prompt,
                  extension: image.extension ?? props.payload.outputFormat ?? "png"
                })
              }
            >
              <img src={image.src} alt={props.payload.prompt} />
            </button>
            <a
              className="image-download-button generated-image-download"
              href={image.src}
              download={`${image.id}.${image.extension ?? props.payload.outputFormat ?? "png"}`}
              title="下载图片"
            >
              <Download size={16} />
            </a>
          </figure>
        ))}
      </div>
    </div>
  );
}

function ImagePreview({ image, onClose }: { image: PreviewImage | null; onClose: () => void }) {
  if (!image) {
    return null;
  }

  return (
    <div className="image-preview-backdrop" onClick={onClose}>
      <section className="image-preview" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <button className="image-preview-close" type="button" title="关闭预览" onClick={onClose}>
          <X size={20} />
        </button>
        <div className="image-preview-media">
          <img src={image.src} alt={image.prompt} />
          <a className="image-download-button" href={image.src} download={`${image.id}.${image.extension ?? "png"}`} title="下载图片">
            <Download size={17} />
          </a>
        </div>
      </section>
    </div>
  );
}

function Drawer(props: {
  open: boolean;
  user: User;
  conversations: Conversation[];
  activeConversationId: string | null;
  search: string;
  onSearch: (value: string) => void;
  onClose: () => void;
  onNew: () => void;
  onSelect: (conversation: Conversation) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onLogout: () => void;
  onAdmin: () => void;
}) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  if (!props.open) {
    return null;
  }

  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <aside className="drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-top">
          <span className="drawer-logo">
            <Bot size={21} />
          </span>
          <button className="drawer-close" type="button" title="关闭" onClick={props.onClose}>
            <X size={20} />
          </button>
        </div>
        <button className="drawer-new" type="button" onClick={props.onNew}>
          <SquarePen size={18} />
          <span>新聊天</span>
        </button>
        <label className="search-box">
          <Search size={18} />
          <input value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="搜索聊天" />
        </label>
        <div className="conversation-section-title">最近</div>
        <div className="conversation-list">
          {props.conversations.map((conversation) => (
            <div key={conversation.id} className={conversation.id === props.activeConversationId ? "active" : ""}>
              <button className="conversation-main" type="button" onClick={() => props.onSelect(conversation)}>
                <span>{conversation.title}</span>
              </button>
              <button
                className="conversation-more"
                type="button"
                title="重命名"
                onClick={() => props.onRename(conversation.id, conversation.title)}
              >
                <MoreHorizontal size={17} />
              </button>
            </div>
          ))}
        </div>
        <div className="drawer-footer">
          {userMenuOpen ? (
            <div className="user-panel">
              <button className="user-panel-account" type="button" onClick={() => setUserMenuOpen(false)}>
                <span className="avatar">{props.user.username.slice(0, 2).toUpperCase()}</span>
                <span>
                  <strong>{props.user.username}</strong>
                  <small>Pro</small>
                </span>
                <ChevronRight size={18} />
              </button>
              {props.user.role === "admin" ? (
                <button type="button" onClick={props.onAdmin}>
                  <Settings size={17} />
                  <span>设置</span>
                </button>
              ) : null}
              <button type="button" onClick={props.onLogout}>
                <LogOut size={17} />
                <span>退出登录</span>
                <ChevronRight size={18} />
              </button>
            </div>
          ) : null}
          <button className="user-chip" type="button" onClick={() => setUserMenuOpen((open) => !open)}>
            <span className="avatar">{props.user.username.slice(0, 2).toUpperCase()}</span>
            <span>
              <strong>{props.user.username}</strong>
              <small>Pro</small>
            </span>
          </button>
          {props.user.role === "admin" && !userMenuOpen ? (
            <button className="drawer-admin-shortcut" type="button" onClick={props.onAdmin}>
              <Settings size={17} />
              <span>设置</span>
            </button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function AdminPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const usersQuery = useQuery({ queryKey: ["admin-users"], queryFn: api.adminUsers });
  const modelsQuery = useQuery({ queryKey: ["admin-models"], queryFn: api.adminModels });
  const [userForm, setUserForm] = useState({ username: "", password: "", role: "user" as "user" | "admin" });
  const [modelForm, setModelForm] = useState({ id: "", displayName: "", type: "chat", sort: 30 });
  const [error, setError] = useState("");

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.createAdminUser(userForm);
      setUserForm({ username: "", password: "", role: "user" });
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建用户失败");
    }
  }

  async function createModel(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.createModel({ ...modelForm, enabled: true });
      setModelForm({ id: "", displayName: "", type: "chat", sort: 30 });
      await queryClient.invalidateQueries({ queryKey: ["admin-models"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建模型失败");
    }
  }

  return (
    <div className="admin-backdrop">
      <section className="admin-panel">
        <header>
          <h2>管理</h2>
          <button className="icon-button" type="button" onClick={onClose} title="关闭">
            <X size={20} />
          </button>
        </header>
        {error ? <p className="form-error">{error}</p> : null}
        <section className="admin-section">
          <h3>用户</h3>
          <form className="admin-form" onSubmit={createUser}>
            <input placeholder="用户名" value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} />
            <input
              placeholder="密码"
              type="password"
              value={userForm.password}
              onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
            />
            <select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value as "user" | "admin" })}>
              <option value="user">用户</option>
              <option value="admin">管理员</option>
            </select>
            <button type="submit" title="新增用户">
              <UserPlus size={16} />
            </button>
          </form>
          <div className="admin-list">
            {(usersQuery.data ?? []).map((item) => (
              <div key={item.id}>
                <span>{item.username}</span>
                <small>{item.role}</small>
                <button
                  type="button"
                  title="删除用户"
                  onClick={async () => {
                    await api.deleteAdminUser(item.id);
                    await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="admin-section">
          <h3>模型</h3>
          <form className="admin-form" onSubmit={createModel}>
            <input placeholder="模型 ID" value={modelForm.id} onChange={(e) => setModelForm({ ...modelForm, id: e.target.value })} />
            <input
              placeholder="显示名称"
              value={modelForm.displayName}
              onChange={(e) => setModelForm({ ...modelForm, displayName: e.target.value })}
            />
            <select value={modelForm.type} onChange={(e) => setModelForm({ ...modelForm, type: e.target.value })}>
              <option value="chat">Chat</option>
              <option value="reasoning">Thinking</option>
              <option value="image">Image</option>
            </select>
            <button type="submit" title="新增模型">
              <Plus size={16} />
            </button>
          </form>
          <div className="admin-list">
            {(modelsQuery.data ?? []).map((item) => (
              <div key={item.id}>
                <span>{item.displayName}</span>
                <small>{item.type}</small>
                <button
                  type="button"
                  title={item.enabled ? "禁用" : "启用"}
                  onClick={async () => {
                    await api.updateModel(item.id, { enabled: !item.enabled });
                    await queryClient.invalidateQueries({ queryKey: ["admin-models"] });
                  }}
                >
                  {item.enabled ? <Check size={14} /> : <X size={14} />}
                </button>
                <button
                  type="button"
                  title="删除模型"
                  onClick={async () => {
                    await api.deleteModel(item.id);
                    await queryClient.invalidateQueries({ queryKey: ["admin-models"] });
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}

function writeStreamResultToCache(params: {
  queryClient: QueryClient;
  conversationId: string;
  userContent?: string;
  userMessageId?: string;
  assistantMessageId: string;
  assistantContent: string;
}) {
  const timestamp = Math.floor(Date.now() / 1000);

  params.queryClient.setQueryData<ChatMessage[]>(["messages", params.conversationId], (current = []) => {
    const withoutStreamed = current.filter(
      (message) => message.id !== params.userMessageId && message.id !== params.assistantMessageId
    );
    const additions: ChatMessage[] = [];

    if (params.userContent && params.userMessageId) {
      additions.push({
        id: params.userMessageId,
        conversationId: params.conversationId,
        role: "user",
        content: params.userContent,
        model: null,
        status: "done",
        parentId: null,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }

    additions.push({
      id: params.assistantMessageId,
      conversationId: params.conversationId,
      role: "assistant",
      content: params.assistantContent,
      model: null,
      status: "done",
      parentId: params.userMessageId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    return [...withoutStreamed, ...additions];
  });
}

function appendMessagesToCache(queryClient: QueryClient, conversationId: string, newMessages: ChatMessage[]) {
  queryClient.setQueryData<ChatMessage[]>(["messages", conversationId], (current = []) => {
    const nextIds = new Set(newMessages.map((message) => message.id));
    return [...current.filter((message) => !nextIds.has(message.id)), ...newMessages];
  });
}

function compareConversationsByRecency(left: Conversation, right: Conversation) {
  return right.updatedAt - left.updatedAt || right.createdAt - left.createdAt;
}

function parseImageMessage(content: string): ImageMessagePayload | null {
  if (!content.startsWith(IMAGE_MESSAGE_PREFIX)) {
    return null;
  }

  try {
    const payload = JSON.parse(content.slice(IMAGE_MESSAGE_PREFIX.length)) as Partial<ImageMessagePayload>;
    if (payload.type !== "image_result" || !Array.isArray(payload.images)) {
      return null;
    }

    return {
      type: "image_result",
      prompt: typeof payload.prompt === "string" ? payload.prompt : "",
      outputFormat: typeof payload.outputFormat === "string" ? payload.outputFormat : undefined,
      images: payload.images
        .map((image) => ({
          id: typeof image?.id === "string" ? image.id : crypto.randomUUID(),
          url: typeof image?.url === "string" ? image.url : null,
          base64: typeof image?.base64 === "string" ? image.base64 : null,
          mimeType: typeof image?.mimeType === "string" ? image.mimeType : null,
          extension: typeof image?.extension === "string" ? image.extension : null
        }))
        .filter((image) => image.url || image.base64)
    };
  } catch {
    return null;
  }
}

function imageSource(image: { url: string | null; base64: string | null; mimeType?: string | null }) {
  return image.url ?? (image.base64 ? `data:${image.mimeType ?? "image/png"};base64,${image.base64}` : "");
}

function readReferenceImage(file: File) {
  if (file.size > 12 * 1024 * 1024) {
    return Promise.reject(new Error("参考图不能超过 12MB"));
  }

  return new Promise<ReferenceImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("参考图读取失败"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("参考图读取失败"));
        return;
      }

      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type || "image/png",
        data: reader.result
      });
    };
    reader.readAsDataURL(file);
  });
}

function makeLocalMessage(
  id: string,
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  status: "done" | "streaming" = "done"
): ChatMessage {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    id,
    conversationId,
    role,
    content,
    model: null,
    status,
    parentId: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
