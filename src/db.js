const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://casemgr:changeme123@localhost:5432/casemgr',
  max: 10,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'staff',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  security_question VARCHAR(200),
  security_answer VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role VARCHAR(20) NOT NULL,
  permission VARCHAR(50) NOT NULL,
  PRIMARY KEY (role, permission)
);


CREATE TABLE IF NOT EXISTS case_types (
  id SERIAL PRIMARY KEY,
  code VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(20) NOT NULL DEFAULT '#0d6efd',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_fields (
  id SERIAL PRIMARY KEY,
  case_type_id INT NOT NULL REFERENCES case_types(id) ON DELETE CASCADE,
  label VARCHAR(100) NOT NULL,
  field_type VARCHAR(30) NOT NULL DEFAULT 'text',
  options TEXT,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  placeholder VARCHAR(200),
  sort INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS statuses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'processing',
  color VARCHAR(20) NOT NULL DEFAULT '#0d6efd',
  sort INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS cases (
  id SERIAL PRIMARY KEY,
  case_no VARCHAR(50) UNIQUE NOT NULL,
  case_type_id INT NOT NULL REFERENCES case_types(id),
  title VARCHAR(200) NOT NULL,
  client_name VARCHAR(100),
  assignee_id INT REFERENCES users(id),
  status_id INT REFERENCES statuses(id),
  status_note TEXT,
  status_at TIMESTAMPTZ,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_field_values (
  id SERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  field_id INT NOT NULL REFERENCES case_fields(id) ON DELETE CASCADE,
  value TEXT,
  UNIQUE (case_id, field_id)
);

CREATE TABLE IF NOT EXISTS case_history (
  id SERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL,
  status_id INT REFERENCES statuses(id),
  note TEXT,
  operator_id INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name VARCHAR(200) NOT NULL,
  mime_type VARCHAR(120),
  size BIGINT NOT NULL DEFAULT 0,
  uploaded_by INT REFERENCES users(id),
  remark VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) UNIQUE NOT NULL,
  value TEXT,
  description VARCHAR(200)
);

CREATE TABLE IF NOT EXISTS case_parties (
  id SERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(50) NOT NULL,
  id_card VARCHAR(30),
  phone VARCHAR(20),
  address VARCHAR(200),
  contact_person VARCHAR(50),
  contact_phone VARCHAR(20),
  injury_info TEXT,
  hospital_dept VARCHAR(100),
  remark TEXT,
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contract_templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  case_type_id INT REFERENCES case_types(id) ON DELETE SET NULL,
  pdf_path VARCHAR(200) NOT NULL,     -- 上传的 PDF 模板文件路径
  sign_positions JSONB,               -- 签名位置配置：[{page, x, y, width, height, party_role, label}]
  text_fields JSONB DEFAULT '[]',     -- 文本配置：[{page, x, y, width, height, text, size}]
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contracts (
  id SERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  template_id INT REFERENCES contract_templates(id) ON DELETE SET NULL,
  title VARCHAR(200) NOT NULL,
  pdf_path VARCHAR(200),              -- 生成的已签署 PDF 路径
  work_pdf_path VARCHAR(200),         -- 创建合同时预填充文本的 PDF 路径
  status VARCHAR(20) NOT NULL DEFAULT 'draft',  -- draft/sent/signed/expired/revoked
  initiator_id INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS contract_signatures (
  id SERIAL PRIMARY KEY,
  contract_id INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  party_id INT REFERENCES case_parties(id) ON DELETE SET NULL,  -- 关联当事人
  party_name VARCHAR(100) NOT NULL,   -- 签署人姓名（冗余，防当事人被删）
  party_role VARCHAR(50),             -- 签署角色
  sign_token VARCHAR(64) UNIQUE NOT NULL,  -- 唯一签署令牌
  signature_image_path VARCHAR(200),  -- 签名图片路径
  signed_at TIMESTAMPTZ,
  ip_address VARCHAR(45),
  user_agent TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending/signed/expired
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cases_type ON cases(case_type_id);
CREATE INDEX IF NOT EXISTS idx_cases_assignee ON cases(assignee_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status_id);
CREATE INDEX IF NOT EXISTS idx_cfv_case ON case_field_values(case_id);
CREATE INDEX IF NOT EXISTS idx_ch_case ON case_history(case_id);
CREATE INDEX IF NOT EXISTS idx_att_case ON attachments(case_id);
CREATE INDEX IF NOT EXISTS idx_contracts_case ON contracts(case_id);
CREATE INDEX IF NOT EXISTS idx_signatures_contract ON contract_signatures(contract_id);
CREATE INDEX IF NOT EXISTS idx_signatures_token ON contract_signatures(sign_token);
CREATE INDEX IF NOT EXISTS idx_signatures_party ON contract_signatures(party_id);

-- C4: 强制首次登录修改密码
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- M5: 签署令牌过期时间
ALTER TABLE contract_signatures ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 单链接多人签署：同一合同的所有签署记录共用同一个 sign_token（去掉原 UNIQUE 约束）
ALTER TABLE contract_signatures DROP CONSTRAINT IF EXISTS contract_signatures_sign_token_key;

-- 安全问题（忘记密码）
ALTER TABLE users ADD COLUMN IF NOT EXISTS security_question VARCHAR(200);
ALTER TABLE users ADD COLUMN IF NOT EXISTS security_answer VARCHAR(200);

-- 可视化编辑器：模板文本字段 + 合同预填充 PDF
ALTER TABLE contract_templates ADD COLUMN IF NOT EXISTS text_fields JSONB DEFAULT '[]';
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS work_pdf_path VARCHAR(200);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS reminder_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS fee_agreement TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS fee_details TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS reminder_ack_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS reminder_ack_by INT REFERENCES users(id);

-- 案件当事人扩展字段（注意：这些字段不得再写进上方 CREATE TABLE，否则迁移会提前撞 duplicate_column）
ALTER TABLE case_parties ADD COLUMN IF NOT EXISTS injury_info TEXT;
ALTER TABLE case_parties ADD COLUMN IF NOT EXISTS hospital_dept VARCHAR(100);
ALTER TABLE case_parties ADD COLUMN IF NOT EXISTS gender VARCHAR(10);
ALTER TABLE case_parties ADD COLUMN IF NOT EXISTS age INT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS remark VARCHAR(200);

-- 签单信息：签单人员（系统内员工）+ 签单日期
ALTER TABLE cases ADD COLUMN IF NOT EXISTS sign_staff_id INT REFERENCES users(id);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS sign_date DATE;
CREATE INDEX IF NOT EXISTS idx_cases_sign_date ON cases(sign_date);

-- 标的金额 / 实收金额
ALTER TABLE cases ADD COLUMN IF NOT EXISTS target_amount NUMERIC(12,2);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS received_amount NUMERIC(12,2);

-- 企业微信推送：用户绑定企业微信 UserID
ALTER TABLE users ADD COLUMN IF NOT EXISTS wecom_userid VARCHAR(64);

-- 操作日志：登录 + 所有数据变更（含变更前后内容），仅超管可查看
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INT,
  display_name VARCHAR(100),
  action VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50),
  entity_id INT,
  detail TEXT,
  before_data JSONB,
  after_data JSONB,
  ip VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);

-- 结构化费用表（每笔费用独立一行，支持截图/发票上传）
CREATE TABLE IF NOT EXISTS case_fees (
  id SERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  fee_type VARCHAR(50) NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  direction VARCHAR(10) NOT NULL DEFAULT 'expense',
  payer VARCHAR(200),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  paid_at DATE,
  file_path TEXT,
  file_original_name VARCHAR(200),
  file_mime VARCHAR(120),
  file_size BIGINT DEFAULT 0,
  note TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_case_fees_case ON case_fees(case_id);
`;

const SEED_TYPES = [
  { code: 'JT', name: '交通事故', color: '#dc3545', sort: 1 },
  { code: 'GS', name: '工伤', color: '#fd7e14', sort: 2 },
  { code: 'YW', name: '意外险', color: '#198754', sort: 3 },
  { code: 'XP', name: '学平险', color: '#0d6efd', sort: 4 },
];

const SEED_TYPE_FIELDS = {
  JT: [
    ['事故时间', 'date', false, '如 2026-01-01'],
    ['事故地点', 'text', false, ''],
    ['当事人姓名', 'text', true, ''],
    ['当事人手机号', 'phone', true, ''],
    ['身份证号', 'text', false, ''],
    ['责任认定情况', 'select', false, '[{"label":"全责"},{"label":"主责"},{"label":"同责"},{"label":"次责"},{"label":"无责"},{"label":"待定"}]'],
    ['对方当事人/保险公司', 'text', false, ''],
    ['伤情部位', 'text', false, ''],
    ['住院/门诊', 'select', false, '[{"label":"住院"},{"label":"门诊"},{"label":"未就医"}]'],
    ['医疗费用（元）', 'number', false, ''],
    ['是否伤残鉴定', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
    ['鉴定机构/等级', 'text', false, '如：司法鉴定所，十级'],
    ['处理阶段', 'select', false, '[{"label":"协商理赔"},{"label":"调解"},{"label":"诉讼"},{"label":"执行"}]'],
    ['备注', 'textarea', false, ''],
  ],
  GS: [
    ['工伤发生时间', 'date', true, ''],
    ['发生地点', 'text', false, ''],
    ['伤者姓名', 'text', true, ''],
    ['伤者手机号', 'phone', true, ''],
    ['身份证号', 'text', false, ''],
    ['用人单位', 'text', true, ''],
    ['是否缴纳社保', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"未知"}]'],
    ['是否已做工伤认定', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"办理中"}]'],
    ['认定文号', 'text', false, ''],
    ['伤情/伤残等级', 'text', false, '如：九级'],
    ['工资标准（元/月）', 'number', false, ''],
    ['处理阶段', 'select', false, '[{"label":"认定阶段"},{"label":"劳动能力鉴定"},{"label":"协商赔偿"},{"label":"仲裁"},{"label":"诉讼"}]'],
    ['备注', 'textarea', false, ''],
  ],
  YW: [
    ['保单号', 'text', false, ''],
    ['保险公司', 'text', false, ''],
    ['投保人', 'text', false, ''],
    ['被保人', 'text', true, ''],
    ['联系电话', 'phone', false, ''],
    ['出险时间', 'date', false, ''],
    ['出险原因', 'textarea', false, ''],
    ['是否已报案', 'select', false, '[{"label":"是"},{"label":"否"}]'],
    ['报案号', 'text', false, ''],
    ['理赔金额（元）', 'number', false, ''],
    ['处理阶段', 'select', false, '[{"label":"资料提交"},{"label":"等待审核"},{"label":"协商"},{"label":"诉讼"}]'],
    ['备注', 'textarea', false, ''],
  ],
  XP: [
    ['保单号', 'text', false, ''],
    ['保险公司', 'text', false, ''],
    ['学校名称', 'text', true, ''],
    ['学生姓名', 'text', true, ''],
    ['家长姓名', 'text', true, ''],
    ['家长手机号', 'phone', true, ''],
    ['出险时间', 'date', false, ''],
    ['出险地点', 'text', false, ''],
    ['是否已报案', 'select', false, '[{"label":"是"},{"label":"否"}]'],
    ['报案号', 'text', false, ''],
    ['班主任/学校联系人', 'text', false, ''],
    ['处理阶段', 'select', false, '[{"label":"资料提交"},{"label":"等待审核"},{"label":"协商"},{"label":"诉讼"}]'],
    ['备注', 'textarea', false, ''],
  ],
};

const SEED_STATUSES = [
  ['待受理', 'pending', '#6c757d', 1],
  ['理赔中', 'processing', '#0d6efd', 2],
  ['诉讼中', 'litigation', '#fd7e14', 3],
  ['调解中', 'processing', '#20c997', 4],
  ['已结案', 'closed', '#198754', 5],
  ['已归档', 'archived', '#6f42c1', 6],
];

// 合同模板种子（PDF 文件需手动上传到 uploads/contracts/，这里只建记录）
const SEED_CONTRACT_TEMPLATES = [
  { name: '交通事故调解协议书', case_type_code: 'JT', pdf_path: 'contracts/traffic_mediation.pdf', sign_positions: JSON.stringify([{ page: 1, x: 100, y: 600, width: 180, height: 60, party_role: '原告', label: '受害人签名' }, { page: 1, x: 400, y: 600, width: 180, height: 60, party_role: '被告', label: '肇事方签名' }]) },
  { name: '工伤赔偿协议书', case_type_code: 'GS', pdf_path: 'contracts/work_injury_compensation.pdf', sign_positions: JSON.stringify([{ page: 1, x: 100, y: 580, width: 180, height: 60, party_role: '伤者', label: '伤者签名' }, { page: 1, x: 400, y: 580, width: 180, height: 60, party_role: '用人单位', label: '单位盖章' }]) },
  { name: '意外险理赔协议书', case_type_code: 'YW', pdf_path: 'contracts/accident_insurance.pdf', sign_positions: JSON.stringify([{ page: 1, x: 100, y: 600, width: 180, height: 60, party_role: '被保人', label: '被保人签名' }, { page: 1, x: 400, y: 600, width: 180, height: 60, party_role: '保险公司', label: '保险公司盖章' }]) },
  { name: '学平险理赔协议书', case_type_code: 'XP', pdf_path: 'contracts/student_insurance.pdf', sign_positions: JSON.stringify([{ page: 1, x: 100, y: 600, width: 180, height: 60, party_role: '家长/监护人', label: '监护人签名' }, { page: 1, x: 400, y: 600, width: 180, height: 60, party_role: '保险公司', label: '保险公司盖章' }]) },
  { name: '通用授权委托书', case_type_code: null, pdf_path: 'contracts/general_power_of_attorney.pdf', sign_positions: JSON.stringify([{ page: 1, x: 100, y: 650, width: 180, height: 60, party_role: '委托人', label: '委托人签名' }, { page: 1, x: 400, y: 650, width: 180, height: 60, party_role: '受托人', label: '受托人签名' }]) }
];

// 为内置模板生成占位 PDF（若 uploads/contracts/ 下文件缺失）
async function ensureTemplatePdfs() {
  try {
    const fs = require('fs');
    const path = require('path');
    const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
    const contractsDir = path.join(uploadDir, 'contracts');
    if (!fs.existsSync(contractsDir)) fs.mkdirSync(contractsDir, { recursive: true });

    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    let cjkFont = null;
    let fontkit = null;
    try {
      fontkit = require('@pdf-lib/fontkit');
      const fontCandidates = [
        path.join(__dirname, '..', 'assets', 'fonts', 'DroidSansFallbackFull.ttf'),
        'C:/Windows/Fonts/simhei.ttf',
        'C:/Windows/Fonts/simsun.ttc',
        'C:/Windows/Fonts/msyh.ttc',
        '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
        '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
      ];
      for (const found of fontCandidates) {
        if (!fs.existsSync(found)) continue;
        try {
          const buf = fs.readFileSync(found);
          const probe = fontkit.create(buf);
          // .ttc 集合字体没有 layout 方法，embed 后在 drawText/save 时抛
          // "this.font.layout is not a function"，必须跳过，只用单字体 .ttf/.otf
          if (typeof probe.layout !== 'function') continue;
          const doc = await PDFDocument.create();
          doc.registerFontkit(fontkit);
          cjkFont = await doc.embedFont(buf);
          break;
        } catch (e) { cjkFont = null; }
      }
    } catch (e) { cjkFont = null; }

    for (const tmpl of SEED_CONTRACT_TEMPLATES) {
      const fp = path.join(uploadDir, tmpl.pdf_path);
      if (fs.existsSync(fp)) continue;
      const doc = await PDFDocument.create();
      const page = doc.addPage([595.28, 841.89]); // A4
      const font = cjkFont || await doc.embedFont(StandardFonts.Helvetica);
      page.drawText(tmpl.name, { x: 40, y: 780, size: 20, font });
      page.drawText('甲方：____________________         乙方：____________________', { x: 60, y: 700, size: 12, font });
      const positions = JSON.parse(tmpl.sign_positions || '[]');
      positions.forEach((pos, i) => {
        page.drawRectangle({
          x: pos.x, y: page.getHeight() - pos.y - (pos.height || 60),
          width: pos.width || 180, height: pos.height || 60,
          borderColor: rgb(0.2, 0.4, 0.8), borderWidth: 1.5,
        });
        page.drawText(pos.label || `签名区${i + 1}`, { x: pos.x, y: page.getHeight() - pos.y - (pos.height || 60) + 5, size: 10, font });
      });
      page.drawText('（系统生成的占位模板，请上传正式合同文件替换）', { x: 40, y: 50, size: 9, font });
      const bytes = await doc.save();
      fs.writeFileSync(fp, bytes);
      console.log(`[db] 已生成占位模板 PDF：${tmpl.pdf_path}`);
    }
  } catch (e) {
    console.warn('[db] 生成占位模板 PDF 失败（可手动上传）:', e.message);
  }
}

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SCHEMA);

    const { rows: adminRows } = await client.query(
      `SELECT id FROM users WHERE username = 'admin'`
    );
    const bcrypt = require('bcryptjs');
    if (adminRows.length === 0) {
      // 首次创建：密码可用 ADMIN_PASSWORD 环境变量覆盖；首次登录强制改密
      const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
      const hash = await bcrypt.hash(adminPassword, 10);
      const secHash = await bcrypt.hash('0101', 10);
      await client.query(
        `INSERT INTO users (username, password_hash, display_name, role, must_change_password, security_question, security_answer) VALUES ('admin', $1, '超级管理员', 'super_admin', TRUE, $2, $3)`,
        [hash, '我的生日是哪一天？', secHash]
      );
    } else {
      // 仅首次创建时强制改密；后续重启保持密码稳定
      // 设置默认安全问题（如果还没有，答案以 bcrypt 哈希存储）
      const existing = (await client.query(`SELECT security_answer, security_question FROM users WHERE username = 'admin'`)).rows[0];
      if (existing && !existing.security_question) {
        const secHash = await bcrypt.hash('0101', 10);
        await client.query(`UPDATE users SET security_question = '我的生日是哪一天？', security_answer = $1 WHERE username = 'admin'`, [secHash]).catch(() => {});
      }
      // 权限模型升级：admin 账号升级为超级管理员
      await client.query(`UPDATE users SET role = 'super_admin' WHERE username = 'admin' AND role = 'admin'`).catch(() => {});
    }

    // S2: 迁移已存在用户的明文安全答案 → bcrypt 哈希（幂等）
    const { rows: plainRows } = await client.query(
      `SELECT id, security_answer FROM users WHERE security_answer IS NOT NULL AND security_answer <> '' AND security_answer NOT LIKE '$2%'`
    );
    for (const r of plainRows) {
      const secHash = await bcrypt.hash(r.security_answer, 10);
      await client.query(`UPDATE users SET security_answer = $1 WHERE id = $2`, [secHash, r.id]).catch(() => {});
    }

    // 默认角色权限（超管始终拥有全部权限，此处仅记录 管理员/员工 默认值）
    const DEFAULT_ROLE_PERMS = {
      admin: [
        'cases.view_all', 'cases.create', 'cases.edit', 'cases.delete', 'cases.assign',
        'cases.remind', 'cases.fee', 'cases.import_export',
        'parties.manage', 'attachments.manage', 'contracts.manage',
      ],
      staff: [
        'cases.create', 'cases.edit', 'cases.remind', 'cases.fee',
        'parties.manage', 'attachments.manage',
      ],
    };
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMS)) {
      for (const perm of perms) {
        await client.query(
          `INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [role, perm]
        );
      }
    }

    for (const t of SEED_TYPES) {
      const { rows } = await client.query(`SELECT id FROM case_types WHERE code = $1`, [t.code]);
      if (rows.length === 0) {
        const ins = await client.query(
          `INSERT INTO case_types (code, name, color, sort) VALUES ($1,$2,$3,$4) RETURNING id`,
          [t.code, t.name, t.color, t.sort]
        );
        const typeId = ins.rows[0].id;
        const fields = SEED_TYPE_FIELDS[t.code] || [];
        for (let i = 0; i < fields.length; i++) {
          const [label, ftype, required, placeholder] = fields[i];
          await client.query(
            `INSERT INTO case_fields (case_type_id, label, field_type, options, required, placeholder, sort)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [typeId, label, ftype, ftype === 'select' ? (placeholder || '[]') : null, required, placeholder, i]
          );
        }
      }
    }

    const { rows: statusRows } = await client.query(`SELECT id FROM statuses LIMIT 1`);
    if (statusRows.length === 0) {
      for (const [name, category, color, sort] of SEED_STATUSES) {
        await client.query(
          `INSERT INTO statuses (name, category, color, sort) VALUES ($1,$2,$3,$4)`,
          [name, category, color, sort]
        );
      }
    }

    // 默认应用设置
    const defaultSettings = [
      ['company_name', '案件管理系统', '公司/系统名称'],
      ['company_logo', '', 'Logo 文件名（存放在 uploads/logo/）'],
      ['theme_mode', 'light', '主题模式：light/dark/auto'],
      ['theme_primary', '#0d6efd', '主色调'],
      ['theme_sidebar', '#16203a', '侧边栏背景色'],
      ['bg_gradient', 'linear-gradient(180deg, #060a14, #0b1120 40%, #0f172a 100%)', '页面背景渐变'],
      ['app_url', '', '部署域名（用于生成绝对链接，如 https://example.com）'],
      ['reminder_advance_days', '3', '提醒提前天数：工作台展示该天数内到期/已逾期的提醒'],
      ['backup_enabled', '0', '是否启用自动备份：0/1'],
      ['backup_schedule_type', 'daily', '自动备份频率：daily/weekly'],
      ['backup_time', '02:00', '自动备份执行时间（HH:MM，24小时制）'],
      ['backup_weekday', '0', '每周备份的星期（0=周日，1-6=周一至周六）'],
      ['backup_retention_days', '7', '备份保留天数，超过自动清除'],
      ['audit_retention_days', '30', '操作日志保留天数，超过自动清除（0=不自动清理）'],
      ['wecom_corpid', '', '企业微信 CorpID'],
      ['wecom_agentid', '', '企业微信自建应用 AgentID'],
      ['wecom_secret', '', '企业微信自建应用 Secret'],
      ['wecom_enabled', '0', '企业微信推送总开关：0/1'],
      ['wecom_push_events', '{}', '企业微信推送事件开关 JSON（case_assigned/status_changed/reminder_due/new_attachment）'],
      ['wecom_webhook', '', '企业微信群机器人 Webhook 地址'],
    ];
    for (const [key, value, desc] of defaultSettings) {
      await client.query(
        `INSERT INTO app_settings (key, value, description) VALUES ($1,$2,$3)
         ON CONFLICT (key) DO NOTHING`,
        [key, value, desc]
      );
    }

    // 默认合同模板（PDF 文件需手动放到 uploads/contracts/）
    for (const tmpl of SEED_CONTRACT_TEMPLATES) {
      let typeId = null;
      if (tmpl.case_type_code) {
        const { rows } = await client.query(`SELECT id FROM case_types WHERE code = $1`, [tmpl.case_type_code]);
        if (rows.length) typeId = rows[0].id;
      }
      const { rows: exist } = await client.query(`SELECT id FROM contract_templates WHERE name = $1`, [tmpl.name]);
      if (exist.length === 0) {
        await client.query(
          `INSERT INTO contract_templates (name, case_type_id, pdf_path, sign_positions) VALUES ($1,$2,$3,$4)`,
          [tmpl.name, typeId, tmpl.pdf_path, tmpl.sign_positions]
        );
      }
    }
    // 为内置模板生成占位 PDF（若文件缺失，保证演示可用）
    ensureTemplatePdfs();

    await client.query('COMMIT');
    console.log('[db] 数据库初始化完成');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
