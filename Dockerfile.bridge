FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN bun run build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public
COPY package.json ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
