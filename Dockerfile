FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3-venv && rm -rf /var/lib/apt/lists/*
# Pin YT_DLP_SPEC at image build time when reproducing a validated deployment.
ARG YT_DLP_SPEC=yt-dlp[default]>=2025.11.12
RUN python3 -m venv /opt/media && /opt/media/bin/pip install --no-cache-dir "$YT_DLP_SPEC"
ENV PATH="/opt/media/bin:${PATH}"
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node assets ./assets
USER node
CMD ["node", "dist/index.js"]
