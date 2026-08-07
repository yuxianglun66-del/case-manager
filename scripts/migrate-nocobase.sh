#!/usr/bin/env bash
# 从 NocoBase 迁移数据到案件管理系统（在服务器上执行）
set -e
cd "$(dirname "$0")/.."

echo "== 1. 让 app 容器能访问 NocoBase 数据库 =="
docker network connect nocobase_noco_network case-manager-app-1 2>/dev/null || echo "  已连接"

echo "== 2. 拷贝 NocoBase 附件文件到 app 容器 =="
docker cp /mnt/nocobase_data/noco_storage/. case-manager-app-1:/tmp/noco_files/

echo "== 3. 执行迁移 =="
PW=$(docker exec noco sh -c 'echo $DB_PASSWORD')
docker exec -e NODE_PATH=/app/node_modules -e NOC_PG_PW="$PW" case-manager-app-1 node /app/scripts/migrate-nocobase.js

echo "== 完成 =="
