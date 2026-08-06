FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    TZ=Asia/Shanghai

# 系统依赖：Node.js 20 + 中文字体（PDF 生成必需）+ LibreOffice（Word/Excel 转 PDF）
# 国内网络优化：apt 走阿里云镜像
RUN sed -i 's@//.*archive.ubuntu.com@//mirrors.aliyun.com@g; s@//security.ubuntu.com@//mirrors.aliyun.com@g' /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg tzdata \
      fonts-wqy-microhei fonts-noto-cjk fonts-droid-fallback \
      libreoffice-writer libreoffice-calc libreoffice-core \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com \
    && npm ci --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /app/uploads /app/backups && chown -R 1000:1000 /app

USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]
