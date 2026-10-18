# 3Dokploy: the web app + its small read-only Dokploy API server in one image.
# Needs DOKPLOY_URL and DOKPLOY_API_KEY at runtime.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
# Node 24 runs the (erasable) TypeScript in server/ directly.
CMD ["node", "server/index.ts"]
