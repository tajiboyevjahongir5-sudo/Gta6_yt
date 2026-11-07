FROM node:22-bookworm-slim
# ffmpeg = montaj, yt-dlp = stream yuklab olish, fonts = prevyu yozuvlari
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl fonts-dejavu-core \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
