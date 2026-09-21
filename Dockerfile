FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    TZ=Asia/Shanghai

# apt 加超时重试，国内镜像慢时不会无限卡死
RUN echo 'Acquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::Retries "3";\nAcquire::http::Pipeline-Depth "0";' > /etc/apt/apt.conf.d/99timeout \
    && sed -i 's@//.*archive.ubuntu.com@//mirrors.aliyun.com@g; s@//security.ubuntu.com@//mirrors.aliyun.com@g' /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg tzdata xz-utils \
      fonts-wqy-microhei fonts-noto-cjk fonts-droid-fallback \
      libreoffice-core libreoffice-calc libreoffice-common libreoffice-writer \
    && apt-get purge -y --auto-remove libreoffice-help* libreoffice-l10n* 2>/dev/null \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/locale

# Node.js 20 从 npmmirror CDN 下载二进制包（绕过被墙的 deb.nodesource.com）
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then NODE_ARCH="x64"; elif [ "$ARCH" = "aarch64" ]; then NODE_ARCH="arm64"; fi && \
    curl -fsSL "https://cdn.npmmirror.com/binaries/node/v20.18.0/node-v20.18.0-linux-${NODE_ARCH}.tar.xz" | tar -xJ -C /usr/local --strip-components=1 && \
    node -v && npm -v

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
