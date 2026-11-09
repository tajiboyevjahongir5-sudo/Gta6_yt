# Debian 13: ffmpeg 7.x (Debian 12 had 5.1, which failed to mix sound-effect audio)
FROM node:22-trixie-slim
# ffmpeg = montaj, fonts = prevyu yozuvlari, pil + noto emoji = animatsion emojilar, git = PO token server
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-pil ca-certificates curl unzip git \
    fonts-dejavu-core fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*
# yt-dlp (pip, so plugins load) + bgutil PO token plugin: helps get past YouTube's "confirm you're not a bot" on server IPs
RUN pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" bgutil-ytdlp-pot-provider && yt-dlp --version
# yt-dlp needs a JavaScript runtime (Deno) for full YouTube support
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
 && unzip -q /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip && deno --version
# bgutil PO token HTTP server, same version as the plugin (https://github.com/Brainicism/bgutil-ytdlp-pot-provider).
# Optional: if it fails to build, the app still works without it.
RUN V=$(pip3 show bgutil-ytdlp-pot-provider | awk '/^Version/{print $2}') \
 && git clone --depth 1 --single-branch --branch "$V" https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
 && cd /opt/bgutil/server && npm ci --no-audit --no-fund && npx tsc && test -f build/main.js \
 || (echo "PO token server build skipped" && rm -rf /opt/bgutil)
# Cloudflare WARP as a free extra route to YouTube (wgcf: free account + WireGuard profile; wireproxy: user-space
# tunnel with a local SOCKS5 port, no root/TUN needed). Optional: skipped if a download fails.
RUN (U=$(curl -fsSL https://api.github.com/repos/ViRb3/wgcf/releases/latest | grep -o 'https://[^"]*linux_amd64' | head -1) \
   && curl -fsSL "$U" -o /usr/local/bin/wgcf && chmod +x /usr/local/bin/wgcf \
   && curl -fsSL https://github.com/pufferffish/wireproxy/releases/latest/download/wireproxy_linux_amd64.tar.gz | tar -xz -C /usr/local/bin wireproxy \
   && wgcf --help >/dev/null && wireproxy --version) || (echo "WARP skipped" && rm -f /usr/local/bin/wgcf /usr/local/bin/wireproxy)
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
# Shorts subtitles: faster-whisper, model downloaded once at build time (WHISPER_MODEL must match the setting)
ARG WHISPER_MODEL=large-v3-turbo
# + OpenCV (4.x: has the Haar face detector) to find a streamer webcam in the video
RUN pip3 install --no-cache-dir --break-system-packages faster-whisper "opencv-python-headless<5" \
 && python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"
# precise subtitle timing: Meta MMS forced aligner (torchaudio, CPU). Its model (~1.2 GB) is downloaded on first use
# into the data volume, not into the image. Optional: if anything fails, Whisper's aligner is used
RUN pip3 install --no-cache-dir --break-system-packages --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple torch==2.8.0 torchaudio==2.8.0 \
 || echo "MMS aligner skipped"
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
