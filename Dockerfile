FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    TZ=Asia/Shanghai

# 系统依赖：Node.js 20 + 中文字体（PDF 生成必需）+ LibreOffice（Word 转 PDF 回退方案）
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg tzdata \
      fonts-wqy-microhei fonts-noto-cjk fonts-droid-fallback \
      libreoffice-writer libreoffice-core \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com

COPY . .

RUN mkdir -p /app/uploads /app/backups && chown -R 1000:1000 /app

USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]
