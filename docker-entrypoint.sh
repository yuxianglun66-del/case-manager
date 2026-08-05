#!/bin/sh
set -e

echo "[entrypoint] 等待数据库就绪..."
until pg_isready -h db -p 5432 -U casemgr -d casemgr -q 2>/dev/null; do
  sleep 1
done
echo "[entrypoint] 数据库已就绪"

echo "[entrypoint] 启动应用..."
exec "$@"
