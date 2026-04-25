# gptlite

`gptlite` 是一个轻量移动端 AI 聊天应用。

目标是复刻 ChatGPT 移动端的基础体验，同时保持低资源占用：

- 移动端优先主页。
- 流式聊天。
- Markdown 渲染。
- 会话历史、新建会话、重命名、删除。
- Chat / Thinking / Image 模式切换，模型使用环境变量默认值。
- 图片生成，默认 `gpt-image-2`。
- 对话/思考与生图可以配置不同 API 渠道，生图支持 OpenAI 兼容接口和 GRSAI GPT Image。
- 直接连接 `new-api` 的 Docker 网络。
- 单容器部署，避免 Next.js 和大型 monorepo。

完整方案见：

- [PRODUCT_SPEC.md](./PRODUCT_SPEC.md)

## 当前实现

- `apps/web`：Vite + React + TypeScript 移动端 SPA。
- `apps/server`：Fastify API，SQLite 持久化，JWT Cookie 登录态。
- `packages/shared`：前后端共享类型。
- 单容器部署，服务端托管前端静态文件。

## 本地开发

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm dev
```

前端开发服务默认运行在 `http://localhost:5173`，API 服务默认运行在 `http://localhost:3000`。

首次打开时如果数据库里没有用户，会进入管理员初始化页。也可以在 `.env` 中设置 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`，首次启动时自动创建管理员。

## 构建与运行

```bash
pnpm build
pnpm start
```

生产环境需要设置：

```env
JWT_SECRET=replace-with-a-long-random-secret
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=http://new-api:3000/v1
DATABASE_URL=file:/data/gptlite.db
COOKIE_SECURE=false
```

如果通过 HTTPS 访问，把 `COOKIE_SECURE` 设置为 `true`。如果通过 `http://IP:3211` 在手机上访问，必须保持 `false`，否则移动端浏览器不会保存登录 Cookie。

默认情况下，对话、思考和生图都会沿用 `OPENAI_BASE_URL` / `OPENAI_API_KEY`。如需拆分渠道：

```env
CHAT_API_BASE_URL=http://new-api:3000/v1
CHAT_API_KEY=sk-chat

IMAGE_API_PROVIDER=grsai
IMAGE_API_BASE_URL=https://grsaiapi.com
IMAGE_API_KEY=grsai-api-key
DEFAULT_IMAGE_MODEL=gpt-image-2
PUBLIC_APP_URL=https://gpt.einzieg.io
```

GRSAI GPT Image 的公开文档地址是 `https://grsai.ai/zh/dashboard/documents/gpt-image`，当前实现使用 `POST /v1/draw/completions` 创建任务，并通过 `POST /v1/draw/result` 轮询结果。`PUBLIC_APP_URL` 用于把上传的参考图转成可被 GRSAI 拉取的临时公开 URL。

## Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
```

容器端口映射为 `3211:3000`，并会加入外部 Docker 网络 `new-api_default`。
