# 案件管理系统 - 部署与使用文档

## 1. 技术栈
- **运行时**：Node.js 20 (Alpine)
- **框架**：Express (CommonJS)
- **数据库**：PostgreSQL 16
- **模板**：EJS (服务端渲染)
- **前端**：Bootstrap 5 + Bootstrap Icons + Chart.js（全部本地 vendor，无外网 CDN 依赖）
- **容器**：Docker + Docker Compose（2 容器：app + db）

---

## 2. 目录结构
```
case-manager/
├── server.js                 # 入口
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .dockerignore
├── src/
│   ├── db.js                 # PG 连接池、建表、种子数据
│   ├── auth.js               # 登录/权限中间件
│   └── util.js               # multer、案号生成、工具函数
├── routes/
│   ├── auth.js               # 登录/登出
│   ├── pages.js              # 页面路由
│   └── api.js                # REST API
├── views/
│   ├── layout.ejs            # 主布局（侧边栏、顶栏、主题变量）
│   ├── login.ejs
│   ├── error.ejs
│   ├── dashboard.ejs         # 统计看板
│   ├── cases/
│   │   ├── list.ejs          # 列表（搜索/筛选/分页/导出/导入）
│   │   ├── form.ejs          # 新建/编辑（动态字段）
│   │   ├── detail.ejs        # 详情（信息/字段/当事人/附件/进度/时间线）
│   │   └── preview.ejs       # 附件预览（图片/PDF/其它）
│   ├── users/list.ejs        # 用户管理
│   └── settings/index.ejs    # 系统设置（类型/字段/状态/品牌/主题）
├── public/
│   ├── css/app.css           # 自定义样式（含深色模式、响应式）
│   └── js/app.js             # 通用 JS（toast、postJSON、confirmBox、侧边栏切换）
├── test/
│   ├── run-test.js           # 嵌入式 PG 测试运行器
│   ├── smoke-test.js         # 23 项集成测试
│   └── serve.js              # 本地常驻服务（开发调试用）
└── screenshots/              # 页面截图
```

---

## 3. 本地开发/测试（Windows，无 Docker）
```bash
# 1. 安装依赖
npm install

# 2. 运行测试（自动启动 embedded-postgres + app，端口 3100）
node test/run-test.js

# 3. 常驻开发服务（端口 3102，DEMO=1 自动以 admin 登录，数据持久化在 .test-pg/）
node test/serve.js
# 访问 http://127.0.0.1:3102
# 默认账号：admin / admin123
```

---

## 4. 生产部署（Ubuntu + Docker）

### 4.1 准备
```bash
# 将项目复制到服务器
scp -r case-manager user@server:/opt/

# 进入目录
cd /opt/case-manager
```

### 4.2 配置环境变量
```bash
cp .env.example .env
# 编辑 .env，务必修改以下项：
# DB_PASSWORD=强密码
# SESSION_SECRET=随机长字符串（建议 32+ 字符）
# APP_BASE_URL=https://your-domain.com
# MAX_FILE_MB=50  # 单文件上传上限
```

### 4.3 启动
```bash
docker compose up -d --build
# app 容器：node:20-alpine，端口 3000 内部，映射宿主 8080
# db  容器：postgres:16-alpine，健康检查 pg_isready
# 数据卷：./data/postgres 与 ./data/uploads 为 bind mount
```

### 4.4 Nginx 反向代理 + SSL（示例）
```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        client_max_body_size 100M;  # 配合 MAX_FILE_MB
    }
}
```

### 4.5 首次登录
- 访问 `https://your-domain.com`
- 默认账号：`admin` / `admin123`
- **登录后立即修改密码**（用户管理 → 编辑 admin → 重置密码）

---

## 5. 核心功能

| 模块 | 说明 |
|------|------|
| **案件类型/字段** | 后台可视化配置：4 内置类型（交通事故/工伤/意外险/学平险），每类 12-14 字段，支持文本/多行/数字/日期/下拉/手机号，必填/排序/启停用 |
| **状态流转** | 6 内置状态（待受理/理赔中/诉讼中/调解中/已结案/已归档），分类用于看板统计，每次变更自动写入时间线 |
| **动态表单** | 新建/编辑案件时，按类型切换显示对应字段，必填校验 |
| **当事人管理** | 一个案件可关联多个当事人（姓名/角色/证件/电话/地址/联系人/备注/排序），增删改查 |
| **附件管理** | 多文件上传（图片/Word/PDF/Excel/ZIP/RAR 等），中文文件名安全，支持预览（图片/PDF 内嵌，其它引导下载）、替换、删除 |
| **进度时间线** | 创建/状态变更/编辑/附件操作自动记录，备注可编辑，按类型着色 |
| **统计看板** | 总量/待受理/处理中/结案归档 4 卡片 + 柱状图（按类型）+ 环形图（按状态）+ 员工办案量表（管理员） |
| **权限控制** | 管理员全量访问；员工仅见自己负责的案件、不可访问设置/用户管理 |
| **品牌/主题** | 公司名称、Logo 上传、主色调/侧边栏色/亮/暗/跟随系统 3 种模式、6 套预设配色一键应用 |
| **导入导出** | 列表导出 CSV/Excel（含筛选条件）、标准模板下载、CSV 导入（类型/状态/负责人自动匹配） |
| **响应式** | PC 固定侧边栏，移动端顶部栏+抽屉菜单，表格隐藏非关键列 |

---

## 6. 常用维护

### 备份
```bash
# 数据库
docker exec case-manager-db pg_dump -U casemgr casemgr > backup_$(date +%F).sql

# 上传文件
tar -czf uploads_$(date +%F).tar.gz ./data/uploads
```

### 恢复
```bash
# 数据库
docker exec -i case-manager-db psql -U casemgr casemgr < backup_2026-08-01.sql

# 文件
tar -xzf uploads_2026-08-01.tar.gz -C ./data/
```

### 升级
```bash
git pull  # 或重新复制代码
docker compose build --no-cache app
docker compose up -d app
```

### 日志
```bash
docker compose logs -f app
docker compose logs -f db
```

---

## 7. 默认数据（首次初始化自动写入）

| 类型代码 | 名称 | 颜色 | 字段数 |
|----------|------|------|--------|
| JT | 交通事故 | #dc3545 | 14 |
| GS | 工伤 | #fd7e14 | 13 |
| YW | 意外险 | #198754 | 12 |
| XP | 学平险 | #0d6efd | 13 |

| 状态 | 分类 | 颜色 |
|------|------|------|
| 待受理 | pending | #6c757d |
| 理赔中 | processing | #0d6efd |
| 诉讼中 | litigation | #fd7e14 |
| 调解中 | processing | #20c997 |
| 已结案 | closed | #198754 |
| 已归档 | archived | #6f42c1 |

---

## 8. 故障排查

| 现象 | 原因 | 处理 |
|------|------|------|
| 登录后跳回登录页 | SESSION_SECRET 不一致或 cookie 域名不对 | 检查 .env、Nginx `proxy_set_header Host` |
| 附件上传 413 | Nginx `client_max_body_size` 过小 | 调大至 ≥ MAX_FILE_MB |
| 图标不显示 | bootstrap-icons 路径错误 | 确认 `/vendor/bootstrap-icons/bootstrap-icons.css` 返回 200 |
| 深色模式不生效 | localStorage 未保存 | 在设置页保存一次主题设置 |
| 导入报“类型不存在” | CSV 中 case_type_code 与库中不符 | 核对代码大写、是否启用 |

---

## 9. 许可
内部使用，禁止外泄。