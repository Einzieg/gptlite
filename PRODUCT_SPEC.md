# gptlite 产品与技术规格

## 1. 定位

`gptlite` 是一个轻量版 ChatGPT 移动端 Web 应用。

它不追求复刻 LobeHub 的全功能，而是复刻 ChatGPT 移动端的核心使用体验：打开即聊天、会话管理、模型切换、Markdown 阅读、图片生成。

核心约束：

- 移动端优先。
- 低配服务器可构建、可运行。
- 不使用 Next.js。
- 不做插件市场、MCP、社区、技能商店。
- 后端直接对接 OpenAI-compatible API，优先接入本机 `new-api`。

## 2. 功能范围

### MVP 必须实现

- 登录 / 登出。
- 管理员初始化。
- 移动端主页。
- 新建聊天。
- 流式聊天。
- 停止生成。
- 重新生成回答。
- 复制消息。
- 编辑用户消息并重新发送。
- Markdown 渲染。
- 代码块复制。
- 会话历史列表。
- 会话重命名。
- 会话删除。
- Chat / Thinking / Image 模式切换，模型由环境变量默认值决定。
- 图片生成。
- 图片历史。
- 默认图片模型 `gpt-image-2`。
- Docker Compose 部署。
- 直连 `new-api_default` Docker 网络。

### P1 建议实现

- 会话搜索。
- 消息搜索。
- Prompt 快捷按钮。
- 回答中的图片展示。
- 图片结果下载。
- 深色模式。
- 多用户。
- 管理员管理用户。
- 管理员管理模型。

### 暂不实现

- 插件系统。
- MCP。
- 知识库。
- 工作流。
- 桌面端复杂布局。
- Electron。
- PWA 离线缓存。
- 多语言大包。
- 文件管理器。
- Notebook。
- Artifacts。
- 语音通话模式。

语音输入可以先保留按钮 UI，不接真实语音能力。

## 3. ChatGPT 移动端基础体验复刻

### 3.1 首页布局

首屏参考用户截图：

```text
顶部安全区
  左侧：圆形菜单按钮
  右侧：新建会话 / 会话入口按钮

中间区域
  大留白
  标题：有什么可以帮忙的？
  快捷操作：
    创建图片
    构思
    给我惊喜
    总结文本

底部固定输入栏
  左侧：+
  中间：问问 Einzieg
  最右：黑色圆形发送按钮
```

### 3.2 聊天页交互

聊天页和首页可以是同一个页面状态：

- 无消息时展示欢迎标题和快捷按钮。
- 有消息后展示消息流。
- 输入框固定底部。
- assistant 回复使用流式更新。
- 生成中显示停止按钮。
- 长按或点击消息菜单显示：
  - 复制
  - 重新生成
  - 编辑并重发
  - 删除

### 3.3 侧边栏

左上角菜单打开全屏抽屉：

- 新聊天。
- 会话列表。
- 搜索会话。
- 用户信息。
- 设置。
- 管理员入口，仅管理员显示。

### 3.4 模式胶囊

顶部 `Thinking` 胶囊打开模式选择：

- 快速模式。
- Thinking 模式。
- 图片生成模式。

MVP 可以简化为：

- Chat：默认聊天模型。
- Thinking：使用配置中的 reasoning 模型。
- Image：跳转图片生成。

## 4. 视觉规范

```css
:root {
  --bg: #f7f7f4;
  --surface: #ffffff;
  --text: #111111;
  --muted: #8d8d8d;
  --border: #ececec;
  --shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
  --radius-pill: 999px;
}
```

规则：

- 页面背景为暖白。
- 顶部按钮和输入栏为白色。
- 输入栏使用 pill 圆角。
- 快捷按钮为细边框胶囊。
- 不使用大型 UI 组件库。
- 避开 iOS safe-area。
- 首屏必须像移动 App，而不是桌面网页缩小版。

## 5. 推荐技术栈

目录：

```text
/soft/gptlite
  apps/
    web/              # Vite React SPA
    server/           # Fastify API
  packages/
    shared/           # 共享类型
  docker-compose.yml
  Dockerfile
```

前端：

- Vite。
- React。
- TypeScript。
- Zustand。
- TanStack Query。
- react-markdown 或 markdown-it。
- lucide-react。
- CSS Modules 或原生 CSS。

后端：

- Node.js 22。
- Fastify。
- Drizzle ORM。
- SQLite 默认数据库。
- JWT Cookie 登录态。
- OpenAI-compatible API 转发。

不使用：

- Next.js。
- Ant Design。
- 大型 model-bank。
- 多包 monorepo 编译链。

## 6. 后端接口

### 6.1 鉴权

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

### 6.2 会话

```text
GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:id
PATCH  /api/conversations/:id
DELETE /api/conversations/:id
```

### 6.3 消息

```text
GET    /api/conversations/:id/messages
POST   /api/chat/stream
POST   /api/messages/:id/regenerate
PATCH  /api/messages/:id
DELETE /api/messages/:id
```

`POST /api/chat/stream`：

```json
{
  "conversationId": "uuid",
  "mode": "chat",
  "message": "你好",
  "temperature": 0.7
}
```

响应：

```text
content-type: text/event-stream
```

### 6.4 图片生成

```text
POST /api/images/generations
GET  /api/images
GET  /api/images/:id
DELETE /api/images/:id
```

请求：

```json
{
  "model": "gpt-image-2",
  "prompt": "一张极简风格的移动端聊天应用界面",
  "size": "1024x1024",
  "n": 1
}
```

### 6.5 管理

```text
GET   /api/admin/users
POST  /api/admin/users
PATCH /api/admin/users/:id
DELETE /api/admin/users/:id

GET   /api/admin/models
POST  /api/admin/models
PATCH /api/admin/models/:id
DELETE /api/admin/models/:id

GET   /api/admin/settings
PATCH /api/admin/settings
```

## 7. 数据库设计

SQLite MVP 表结构：

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '新会话',
  model TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  parent_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  url TEXT,
  base64 TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  created_at INTEGER NOT NULL
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

默认模型种子：

```sql
INSERT INTO models (id, type, display_name, enabled, sort, created_at, updated_at)
VALUES
  ('gpt-5.4-mini', 'chat', 'GPT-5.4 mini', 1, 10, unixepoch(), unixepoch()),
  ('gpt-5.4', 'reasoning', 'GPT-5.4', 1, 15, unixepoch(), unixepoch()),
  ('gpt-image-2', 'image', 'GPT Image 2', 1, 20, unixepoch(), unixepoch());
```

## 8. new-api 接入

环境变量：

```env
OPENAI_BASE_URL=http://new-api:3000/v1
OPENAI_API_KEY=sk-xxx
DEFAULT_CHAT_MODEL=gpt-5.4-mini
DEFAULT_THINKING_MODEL=gpt-5.4
DEFAULT_IMAGE_MODEL=gpt-image-2
```

聊天请求：

```text
POST ${OPENAI_BASE_URL}/chat/completions
```

图片请求：

```text
POST ${OPENAI_BASE_URL}/images/generations
```

服务容器必须加入：

```yaml
networks:
  new-api-network:
    external: true
    name: new-api_default
```

## 9. Docker 部署

```yaml
services:
  gptlite:
    build: .
    container_name: gptlite
    ports:
      - "3211:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=file:/data/gptlite.db
      - OPENAI_BASE_URL=http://new-api:3000/v1
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - JWT_SECRET=${JWT_SECRET}
      - DEFAULT_CHAT_MODEL=gpt-5.4-mini
      - DEFAULT_THINKING_MODEL=gpt-5.4
      - DEFAULT_IMAGE_MODEL=gpt-image-2
    volumes:
      - ./data:/data
    restart: always
    networks:
      - gptlite
      - new-api-network

networks:
  gptlite:
    driver: bridge
  new-api-network:
    external: true
    name: new-api_default
```

## 10. 性能目标

- `pnpm install` 依赖数尽量少。
- 前端构建小于 30 秒。
- 首屏 gzip JS 小于 500 KB。
- 总前端 gzip 资源小于 2 MB。
- 服务运行内存小于 200 MB。
- Docker 镜像小于 250 MB。
- SQLite 单文件数据库，免维护。

## 11. 实施计划

### 阶段 1：项目骨架

- 初始化 `/soft/gptlite`。
- 创建 Vite React 前端。
- 创建 Fastify 后端。
- 服务端托管前端静态文件。
- Docker Compose 跑通。

### 阶段 2：首页和聊天

- 复刻截图主页。
- 实现底部输入栏。
- 实现消息列表。
- 实现 SSE 流式聊天。
- 实现 Markdown 渲染。
- 实现停止生成。

### 阶段 3：会话管理

- 左侧抽屉。
- 新会话。
- 历史会话。
- 搜索、重命名、删除。

### 阶段 4：图片生成

- 创建图片快捷按钮。
- 图片生成页。
- 默认 `gpt-image-2`。
- 图片历史。

### 阶段 5：管理能力

- 管理员初始化。
- 用户管理。
- 模型管理。
- 系统设置。

## 12. 验收标准

移动端：

- 手机浏览器打开就是类 ChatGPT 首页。
- 底部输入栏固定，不被键盘遮挡。
- 首页快捷按钮可直接填入提示或进入图片页。
- 聊天回复流式显示。
- Markdown 正常展示标题、列表、代码块、链接。
- 会话历史可管理。
- 图片生成可用。

后端：

- 不依赖 LobeHub。
- 不依赖 Next.js。
- 不依赖桌面端资源。
- 容器能直连 `new-api`。
- 重启后会话不丢失。
