FROM node:20-bookworm-slim

# Install system dependencies: FFmpeg, ffprobe, Python 3, pip, and Unicode/Indian fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-setuptools \
    fonts-noto-core \
    fonts-indic \
    fonts-freefont-ttf \
    fonts-dejavu-core \
    fonts-liberation \
    fontconfig \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Refresh font cache so FFmpeg libass detects all Unicode and Hindi fonts
RUN fc-cache -f -v

# Link python and install latest yt-dlp globally
RUN ln -sf /usr/bin/python3 /usr/bin/python \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp

# Hugging Face Spaces standard non-root user (UID 1000)
RUN useradd -m -u 1000 user
WORKDIR /app

# Create necessary directories
RUN mkdir -p /app/data/uploads /app/data/exports/previews /app/assets/bgm /app/vendor

# Copy application files
COPY --chown=user:user package.json ./
COPY --chown=user:user server.js index.html ./
COPY --chown=user:user assets/ ./assets/

# Grant full read/write permissions to user
RUN chown -R user:user /app \
    && chmod -R 777 /app/data /app/assets /app/vendor

USER user
ENV PORT=7860
ENV NODE_ENV=production
EXPOSE 7860

CMD ["node", "server.js"]
