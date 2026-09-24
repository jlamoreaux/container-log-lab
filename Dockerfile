FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY container/tracing.mjs ./tracing.mjs
COPY container/server.mjs ./server.mjs

EXPOSE 8080
CMD ["node", "server.mjs"]
