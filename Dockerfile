# --- build the web clients (plain JS output, so build once on the native platform) ---
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY build.js ./
COPY shared ./shared
COPY web ./web
COPY public ./public
RUN npm run build

# --- runtime: only the server and its two small dependencies ----------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4777 VAULT_DIR=/vault
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/public ./public
LABEL org.opencontainers.image.title="InkVault" \
      org.opencontainers.image.description="Markdown notes typed on the PC, ink drawn on the tablet"
VOLUME /vault
EXPOSE 4777 4778
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4777/api/info >/dev/null || exit 1
CMD ["node", "server/index.js"]
