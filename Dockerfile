FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY container/tracing.mjs ./tracing.mjs
COPY container/server.mjs ./server.mjs
COPY container/shell-demo.mjs ./shell-demo.mjs
COPY container/shell-steps.sh ./shell-steps.sh

EXPOSE 8080
CMD ["node", "server.mjs"]
