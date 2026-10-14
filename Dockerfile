FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
ENV PORT=8787 NODE_OPTIONS=--no-warnings
# Seed the demo family on first start if the database is empty, then serve.
CMD ["sh", "-c", "[ -f data/hearth.db ] || npx tsx scripts/seed.ts; npx tsx src/server.ts"]
EXPOSE 8787
