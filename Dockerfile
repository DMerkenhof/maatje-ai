FROM node:22-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3080

# git houdt de geschiedenis van je memory-bestanden bij.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Draait als gebruiker "node" (uid 1000), niet als root.
USER node
EXPOSE 3080

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
