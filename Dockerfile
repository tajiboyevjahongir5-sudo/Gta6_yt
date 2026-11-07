FROM node:22-bookworm-slim
# ffmpeg = montaj, yt-dlp = stream yuklab olish, fonts = prevyu yozuvlari, pil + noto emoji = animatsion emojilar
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pil ca-certificates curl fonts-dejavu-core fonts-noto-color-emoji \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
# Shorts subtitles: faster-whisper, model downloaded once at build time (WHISPER_MODEL must match the setting)
ARG WHISPER_MODEL=small
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages faster-whisper \
 && python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"
COPY . .
ENV DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
