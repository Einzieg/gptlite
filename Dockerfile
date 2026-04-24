FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app
RUN corepack enable

FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install

FROM deps AS build
COPY . .
RUN pnpm build
RUN pnpm --filter @gptlite/server deploy --prod --legacy /prod/server

FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app
RUN apk add --no-cache libstdc++
COPY --from=build /prod/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
