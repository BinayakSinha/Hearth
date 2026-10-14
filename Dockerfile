FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
ENV PORT=8787 NODE_OPTIONS=--no-warnings HEARTH_DB=/app/data/hearth.db HEARTH_TZ=Europe/London
# The family's journal lives here. Mount a persistent volume on /app/data, or it's lost on redeploy.
VOLUME ["/app/data"]
# Seed the demo family on first start (only if there's no database yet), then serve.
CMD ["sh", "-c", "[ -f \"$HEARTH_DB\" ] || node --import tsx scripts/seed.ts; node --import tsx src/server.ts"]
EXPOSE 8787
