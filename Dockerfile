# Musicplayer server image: Node + ffmpeg + yt-dlp + spotDL.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download tools live in /app/tools/venv, where the server looks for them. Owned by the
# unprivileged "node" user (uid 1000), so the daily auto-update can upgrade them with pip.
RUN python3 -m venv /app/tools/venv \
 && /app/tools/venv/bin/pip install --no-cache-dir -U "yt-dlp[default]" spotdl \
 && chown -R node:node /app/tools

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application code stays owned by root: the app can read it but not change it.
COPY server ./server
COPY public ./public

# /music = your songs (folders become playlists), /data = playlists, covers, settings.
# Both are volumes, so they survive restarts, updates and rebuilds. On the host they must
# be writable for uid 1000 (see README).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    MUSIC_DIR=/music \
    DATA_DIR=/data \
    HOME=/data/home \
    PIP_DISABLE_PIP_VERSION_CHECK=1
VOLUME ["/music", "/data"]
EXPOSE 4321

# Run as the unprivileged "node" user instead of root.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:4321/api/ping').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
