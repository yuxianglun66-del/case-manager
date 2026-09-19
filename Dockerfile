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

# 依赖不在此处安装：宿主 npm ci 预装 node_modules，经 docker-compose bind mount 进容器
# 目的：Docker build 阶段不再发起 npm 网络请求（国内网络 npm 源不稳是 build 2000s 卡死的真凶）

COPY . .

RUN mkdir -p /app/uploads /app/backups && chown -R 1000:1000 /app

USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]
