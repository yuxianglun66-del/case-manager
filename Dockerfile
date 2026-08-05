FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    TZ=Asia/Shanghai

# 系统依赖：Node.js 20 + 中文字体（PDF 生成必需）+ LibreOffice（Word 转 PDF 回退方案）
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg tzdata \
      fonts-wqy-microhei fonts-noto-cjk \
      libreoffice-writer libreoffice-core \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /app/uploads /app/backups && chown -R node:node /app

USER node
EXPOSE 3000
CMD ["node", "server.js"]
