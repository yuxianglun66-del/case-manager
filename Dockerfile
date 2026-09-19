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

# 镜像内一场 npm ci（npmmirror + 超时/重试，国内网络下失败即带 [ERROR] 退出，不再 2000s 卡死）
# 探针已实锤：宿主预装+bind 在无 node 的 Ubuntu 上只产出空目录 → 镜像依赖层被压成空 → app 无限 Restart(1)
# 所以依赖必须/只能 ci 在镜像内这一层。
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-timeout 300000 \
    && npm config set fetch-retries 3 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm ci --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /app/uploads /app/backups && chown -R 1000:1000 /app

USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]
