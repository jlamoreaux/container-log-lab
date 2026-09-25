FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY container/tracing.mjs ./tracing.mjs
COPY container/server.mjs ./server.mjs
COPY container/shell-demo.mjs ./shell-demo.mjs
COPY container/shell-steps.sh ./shell-steps.sh
COPY container/opt-in-demo.mjs ./opt-in-demo.mjs
COPY container/opt-in-steps.sh ./opt-in-steps.sh
COPY container/cli-shims/democtl ./cli-shims/democtl
COPY container/mock-bin/democtl ./mock-bin/democtl
RUN chmod +x ./cli-shims/democtl ./mock-bin/democtl

EXPOSE 8080
CMD ["node", "server.mjs"]
