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

CREATE TABLE IF NOT EXISTS roles (
  key VARCHAR(20) PRIMARY KEY,
  label VARCHAR(50) NOT NULL,
  color VARCHAR(20) NOT NULL DEFAULT '#6f42c1',
  builtin BOOLEAN NOT NULL DEFAULT FALSE,
  sort INT NOT NULL DEFAULT 0
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
  case_type_id INT REFERENCES case_types(id) ON DELETE CASCADE,
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

-- 通用字段：case_fields 支持不绑定具体类型（case_type_id NULL = 系统级通用字段）
ALTER TABLE case_fields ALTER COLUMN case_type_id DROP NOT NULL;

-- 可视化编辑器：模板文本字段 + 合同预填充 PDF
ALTER TABLE contract_templates ADD COLUMN IF NOT EXISTS text_fields JSONB DEFAULT '[]';
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS work_pdf_path VARCHAR(200);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS reminder_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS fee_agreement TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS fee_details TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS reminder_ack_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS reminder_ack_by INT REFERENCES users(id);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS reminder_notified_at TIMESTAMPTZ;

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

-- 软删除：案件进入回收站（deleted_at 为空=正常，非空=已删除）
ALTER TABLE cases ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS deleted_by INT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_cases_deleted ON cases(deleted_at);

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

-- 法律法规案例库
CREATE TABLE IF NOT EXISTS library_items (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  category VARCHAR(50) NOT NULL,
  content TEXT,
  file_path TEXT,
  file_original_name VARCHAR(500),
  file_mime VARCHAR(120),
  file_size BIGINT DEFAULT 0,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_library_category ON library_items(category);

-- 登录失败计数与锁定
CREATE TABLE IF NOT EXISTS login_attempts (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  fail_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 站内通知（红点）
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  event_key VARCHAR(50),
  title VARCHAR(200),
  content TEXT,
  link VARCHAR(500),
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);

-- 推送投递日志（含失败重试记录）
CREATE TABLE IF NOT EXISTS notify_logs (
  id SERIAL PRIMARY KEY,
  event_key VARCHAR(50),
  target_user_id INT REFERENCES users(id),
  channel VARCHAR(20) NOT NULL,
  content TEXT,
  status VARCHAR(10) NOT NULL,
  error TEXT,
  retries INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notify_logs_created ON notify_logs(created_at DESC);

-- 费用类型字典表（可后台增删改，替代代码内硬编码 FEE_TYPES）
CREATE TABLE IF NOT EXISTS fee_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  sort INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 费用付款方：case_fees 未区分当事人支付/员工垫付。旧行默认 'client'（当事人支付，不扣减）
ALTER TABLE case_fees ADD COLUMN IF NOT EXISTS paid_by VARCHAR(16) NOT NULL DEFAULT 'client';
`;

const SEED_TYPES = [
  { code: 'JT', name: '交通事故', color: '#dc3545', sort: 1 },
  { code: 'GS', name: '工伤', color: '#fd7e14', sort: 2 },
  { code: 'YW', name: '意外险', color: '#198754', sort: 3 },
  { code: 'XP', name: '学平险', color: '#0d6efd', sort: 4 },
  { code: 'RS', name: '人身损害', color: '#d63384', sort: 5 },
  { code: 'JC', name: '驾乘险', color: '#6f42c1', sort: 6 },
  { code: 'ZH', name: '综合保险', color: '#20c997', sort: 7 },
  { code: 'GZ', name: '雇主责任险', color: '#e8590c', sort: 8 },
  { code: 'MS', name: '民生险', color: '#15aabf', sort: 9 },
];

const SEED_TYPE_FIELDS = {
  JT: [
    ['事故时间', 'date', true, '如 2026-01-01'],
    ['事故地点', 'text', true, ''],
    ['责任认定情况', 'select', true, '[{"label":"全责"},{"label":"主责"},{"label":"同责"},{"label":"次责"},{"label":"无责"},{"label":"待定"}]'],
    ['事发经过', 'textarea', true, '请描述事故发生的经过（时间、经过、影响）'],
    ['对方当事人/保险公司', 'text', false, ''],
    ['伤情部位', 'text', false, ''],
    ['住院/门诊', 'select', false, '[{"label":"住院"},{"label":"门诊"},{"label":"未就医"}]'],
    ['医疗费用（元）', 'number', false, ''],
    ['是否伤残鉴定', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
    ['鉴定机构/等级', 'text', false, '如：司法鉴定所，十级'],
    ['伤残鉴定日期', 'date', false, ''],
    ['报告出具日期', 'date', false, ''],
    ['处理阶段', 'select', true, '[{"label":"协商理赔"},{"label":"调解"},{"label":"诉讼"},{"label":"执行"},{"label":"待定"}]'],
    ['备注', 'textarea', false, ''],
  ],
  GS: [
    ['工伤发生时间', 'date', true, ''],
    ['发生地点', 'text', true, ''],
    ['事发经过', 'textarea', true, '请描述工伤发生的经过（时间、经过、现场情况）'],
    ['用人单位', 'text', true, ''],
    ['是否缴纳社保', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"未知"}]'],
    ['是否已做工伤认定', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"办理中"}]'],
    ['认定文号', 'text', false, ''],
    ['伤情/伤残等级', 'text', false, '如：九级'],
    ['工资标准（元/月）', 'number', false, ''],
    ['处理阶段', 'select', true, '[{"label":"认定阶段"},{"label":"劳动能力鉴定"},{"label":"协商赔偿"},{"label":"仲裁"},{"label":"诉讼"},{"label":"待定"}]'],
    ['备注', 'textarea', false, ''],
  ],
  YW: [
    ['保单号', 'text', false, ''],
    ['保险公司', 'text', false, ''],
    ['投保人', 'text', false, ''],
    ['出险时间', 'date', true, ''],
    ['出险原因', 'textarea', true, ''],
    ['是否已报案', 'select', false, '[{"label":"是"},{"label":"否"}]'],
    ['报案号', 'text', false, ''],
    ['理赔金额（元）', 'number', false, ''],
    ['是否伤残鉴定', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
    ['鉴定机构/等级', 'text', false, '如：司法鉴定所，十级'],
    ['伤残鉴定日期', 'date', false, ''],
    ['报告出具日期', 'date', false, ''],
    ['处理阶段', 'select', true, '[{"label":"资料提交"},{"label":"等待审核"},{"label":"协商"},{"label":"诉讼"},{"label":"待定"}]'],
    ['备注', 'textarea', false, ''],
  ],
  XP: [
    ['保单号', 'text', false, ''],
    ['保险公司', 'text', false, ''],
    ['学校名称', 'text', true, ''],
    ['出险时间', 'date', true, ''],
    ['出险地点', 'text', true, ''],
    ['是否已报案', 'select', false, '[{"label":"是"},{"label":"否"}]'],
    ['报案号', 'text', false, ''],
    ['班主任/学校联系人', 'text', false, ''],
    ['是否伤残鉴定', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
    ['鉴定机构/等级', 'text', false, '如：司法鉴定所，十级'],
    ['伤残鉴定日期', 'date', false, ''],
    ['报告出具日期', 'date', false, ''],
    ['处理阶段', 'select', true, '[{"label":"资料提交"},{"label":"等待审核"},{"label":"协商"},{"label":"诉讼"},{"label":"待定"}]'],
    ['备注', 'textarea', false, ''],
  ],
  RS: [
    ['损害发生时间', 'date', true, ''],
    ['损害发生地点', 'text', true, ''],
    ['事发经过', 'textarea', true, '请描述人身损害发生的经过（时间、经过、受伤部位）'],
    ['侵权责任方', 'text', true, ''],
    ['责任/过错情况', 'select', false, '[{"label":"全责"},{"label":"主责"},{"label":"同责"},{"label":"次责"},{"label":"无责"},{"label":"待定"}]'],
    ['治疗情况', 'select', false, '[{"label":"门诊"},{"label":"住院"},{"label":"未就医"}]'],
    ['医疗费用（元）', 'number', false, ''],
    ['是否伤残鉴定', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
    ['鉴定机构/等级', 'text', false, '如：司法鉴定所，十级'],
    ['伤残鉴定日期', 'date', false, ''],
    ['报告出具日期', 'date', false, ''],
    ['处理阶段', 'select', true, '[{"label":"协商"},{"label":"调解"},{"label":"诉讼"},{"label":"执行"},{"label":"待定"}]'],
    ['备注', 'textarea', false, ''],
  ],
  JC: [
    ['保单号', 'text', false, ''],
    ['保险公司', 'text', false, ''],
    ['投保人', 'text', false, ''],
    ['车牌号/车辆信息', 'text', false, ''],
    ['出险时间', 'date', true, ''],
    ['出险地点', 'text', true, ''],
    ['出险原因', 'textarea', true, ''],
    ['是否已报案', 'select', false, '[{"label":"是"},{"label":"否"}]'],
    ['报案号', 'text', false, ''],
    ['理赔金额（元）', 'number', false, ''],
    ['是否伤残鉴定', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
    ['鉴定机构/等级', 'text', false, '如：司法鉴定所，十级'],
    ['伤残鉴定日期', 'date', false, ''],
    ['报告出具日期', 'date', false, ''],
    ['处理阶段', 'select', true, '[{"label":"资料提交"},{"label":"等待审核"},{"label":"协商"},{"label":"诉讼"},{"label":"待定"}]'],
    ['备注', 'textarea', false, ''],
  ],
  ZH: [
    ['险种名称', 'text', false, ''],
    ['保单号', 'text', false, ''],
    ['保险公司', 'text', false, ''],
    ['投保人', 'text', false, ''],
    ['出险时间', 'date', true, ''],
    ['出险原因', 'textarea', true, ''],
    ['是否已报案', 'select', false, '[{"label":"是"},{"label":"否"}]'],
    ['报案号', 'text', false, ''],
    ['理赔金额（元）', 'number', false, ''],
    ['是否伤残鉴定', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
    ['鉴定机构/等级', 'text', false, '如：司法鉴定所，十级'],
    ['伤残鉴定日期', 'date', false, ''],
    ['报告出具日期', 'date', false, ''],
    ['处理阶段', 'select', true, '[{"label":"资料提交"},{"label":"等待审核"},{"label":"协商"},{"label":"诉讼"},{"label":"待定"}]'],
    ['备注', 'textarea', false, ''],
  ],
  GZ: [
    ['保单号', 'text', false, ''],
    ['保险公司', 'text', false, ''],
    ['投保单位', 'text', true, ''],
    ['出险时间', 'date', true, ''],
    ['出险地点', 'text', true, ''],
    ['出险原因', 'textarea', true, ''],
    ['是否已报案', 'select', false, '[{"label":"是"},{"label":"否"}]'],
    ['报案号', 'text', false, ''],
    ['理赔金额（元）', 'number', false, ''],
    ['是否伤残鉴定', 'select', false, '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
    ['鉴定机构/等级', 'text', false, '如：司法鉴定所，十级'],
    ['伤残鉴定日期', 'date', false, ''],
    ['报告出具日期', 'date', false, ''],
    ['处理阶段', 'select', true, '[{"label":"资料提交"},{"label":"等待审核"},{"label":"协商"},{"label":"诉讼"},{"label":"待定"}]'],
    ['备注', 'textarea', false, ''],
  ],
  MS: [
    ['保单号', 'text', false, ''],
    ['保险公司', 'text', false, ''],
    ['投保单位', 'text', false, ''],
    ['保障项目', 'select', false, '[{"label":"自然灾害"},{"label":"火灾"},{"label":"意外身故伤残"},{"label":"医疗救助"},{"label":"其他"}]'],
    ['出险时间', 'date', true, ''],
    ['出险地点', 'text', true, ''],
    ['出险原因', 'textarea', true, ''],
    ['是否已报案', 'select', false, '[{"label":"是"},{"label":"否"}]'],
    ['报案号', 'text', false, ''],
    ['理赔金额（元）', 'number', false, ''],
    ['处理阶段', 'select', true, '[{"label":"资料提交"},{"label":"等待审核"},{"label":"协商"},{"label":"诉讼"},{"label":"待定"}]'],
    ['备注', 'textarea', false, ''],
  ],
};

const SEED_STATUSES = [
  // 已签约（1XX）
  ['住院中', 'signed', '#9F9114', 101],
  ['已出院', 'signed', '#0D3BC5', 102],
  ['材料收集中', 'signed', '#BA7D21', 103],
  ['材料补充中', 'signed', '#0667B7', 104],
  ['材料已齐全', 'signed', '#E9591C', 105],
  // 理赔中（2XX）
  ['已报案', 'processing', '#099AB3', 201],
  ['材料待提交', 'processing', '#E44949', 202],
  ['材料已提交', 'processing', '#149F8A', 203],
  ['材料审核中', 'processing', '#E10E4E', 204],
  ['赔偿方案沟通', 'processing', '#1CA065', 205],
  ['赔偿方案已确认', 'processing', '#F820A2', 206],
  ['理赔协议签署', 'processing', '#10A235', 207],
  ['赔偿钱款待支付', 'processing', '#F312DC', 208],
  ['赔偿钱款已支付', 'processing', '#20A419', 209],
  // 诉讼中（3XX）
  ['待立案', 'litigation', '#C745E8', 301],
  ['立案中', 'litigation', '#3E9E0A', 302],
  ['已立案', 'litigation', '#7824CC', 303],
  ['待质证', 'litigation', '#659905', 304],
  ['已质证', 'litigation', '#542EEA', 305],
  ['待鉴定', 'litigation', '#8F9608', 306],
  ['已鉴定', 'litigation', '#2638DF', 307],
  ['代排庭', 'litigation', '#B18A16', 308],
  ['待开庭', 'litigation', '#3A84F2', 309],
  ['已开庭', 'litigation', '#BA6621', 310],
  ['待判决', 'litigation', '#0797D5', 311],
  ['已判决', 'litigation', '#BE2D13', 312],
  ['调解中', 'litigation', '#08A0A0', 313],
  ['调解已确认', 'litigation', '#A4192D', 314],
  ['待支付', 'litigation', '#149F75', 315],
  ['赔偿已支付', 'litigation', '#D80E69', 316],
  ['赔偿已到账', 'litigation', '#1CA051', 317],
  ['上诉中', 'litigation', '#D507A1', 318],
  ['待二审开庭', 'litigation', '#10A21F', 319],
  ['二审开庭已开庭', 'litigation', '#BD0AC7', 320],
  ['待二审判决', 'litigation', '#34A419', 321],
  ['二审已判决', 'litigation', '#7415A8', 322],
  // 已结案（4XX）
  ['待支付服务费', 'closed', '#549E0A', 401],
  ['已支付服务费', 'closed', '#5B22C3', 402],
  ['已结案', 'closed', '#7C9905', 403],
  ['已归档', 'closed', '#1D14C8', 404],
];

// 旧模板 → 新模板案件状态引用迁移映射（仅升级时使用）
const LEGACY_STATUS_MAP = {
  '待受理': '住院中',
  '理赔中': '已报案',
  '诉讼中': '待立案',
  '调解中': '调解中',
  '已结案': '已结案',
  '已归档': '已归档',
};

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
    const { getUploadDir } = require('./paths');
    const uploadDir = getUploadDir();
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
        'cases.view', 'cases.view_all', 'cases.create', 'cases.edit', 'cases.delete', 'cases.assign',
        'cases.remind', 'cases.fee', 'cases.import_export', 'cases.batch', 'reports.view',
        'parties.manage', 'attachments.manage', 'contracts.manage', 'library.manage',
        'system.settings',
      ],
      staff: [
        'cases.view', 'cases.create', 'cases.edit', 'cases.remind', 'cases.fee', 'cases.batch', 'reports.view',
        'parties.manage', 'attachments.manage',
      ],
    };
    // 种子内置角色元数据
    await client.query(
      `INSERT INTO roles (key, label, color, builtin, sort) VALUES
         ('super_admin', '超级管理员', '#d63384', TRUE, 0),
         ('admin', '管理员', '#6f42c1', TRUE, 1),
         ('staff', '员工', '#4361ee', TRUE, 2)
       ON CONFLICT (key) DO NOTHING`
    ).catch(() => {});
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMS)) {
      for (const perm of perms) {
        await client.query(
          `INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [role, perm]
        );
      }
    }

    // 种子费用类型字典（幂等；用户可在后台新增/停用）
    const SEED_FEE_TYPES = ['保全费', '鉴定费', '一审诉讼费', '二审诉讼费', '律师费', '差旅费', '茶水费', '公证费', '其他'];
    for (let i = 0; i < SEED_FEE_TYPES.length; i++) {
      await client.query(
        `INSERT INTO fee_types (name, sort, active) VALUES ($1, $2, TRUE) ON CONFLICT (name) DO NOTHING`,
        [SEED_FEE_TYPES[i], i + 1]
      ).catch(() => {});
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

    // 迁移：存量库给 JT交通事故/GS工伤/RS人身损害 补「事发经过」textarea（幂等：以 类型+label 判存在；锚点字段后插入并顺移 sort）
    const MIGRATE_TEXTAREA_CODES = { JT: ['责任认定情况', '事发经过', 'textarea', '请描述事发经过（时间、经过、现场情况）'], GS: ['发生地点', '事发经过', 'textarea', '请描述工伤发生的经过（时间、经过、现场情况）'], RS: ['损害发生地点', '事发经过', 'textarea', '请描述损害发生的经过（时间、经过、现场情况）'] };
    for (const [code, [anchorLabel, mLabel, mType, mPlaceholder]] of Object.entries(MIGRATE_TEXTAREA_CODES)) {
      const { rows: tRows } = await client.query(`SELECT id FROM case_types WHERE code = $1`, [code]);
      if (tRows.length === 0) continue;
      const tid = tRows[0].id;
      const { rows: existRows } = await client.query(`SELECT id FROM case_fields WHERE case_type_id = $1 AND label = $2`, [tid, mLabel]);
      if (existRows.length > 0) continue;
      const { rows: aRows } = await client.query(`SELECT sort FROM case_fields WHERE case_type_id = $1 AND label = $2`, [tid, anchorLabel]);
      const base = Number.isFinite(aRows[0] ? aRows[0].sort : NaN) ? aRows[0].sort + 1 : 1;
      const { rows: maxRows } = await client.query(`SELECT COALESCE(MAX(sort), 0) AS m FROM case_fields WHERE case_type_id = $1`, [tid]);
      const curMax = maxRows[0].m;
      if (base <= curMax) await client.query(`UPDATE case_fields SET sort = sort + 1000 WHERE case_type_id = $1 AND sort >= $2`, [tid, base]);
      await client.query(
        `INSERT INTO case_fields (case_type_id, label, field_type, options, required, placeholder, sort, active)
         VALUES ($1, $2, $3, NULL, FALSE, $4, $5, TRUE)`,
        [tid, mLabel, mType, mPlaceholder, base]
      );
    }

    // 迁移：存量库补「伤残鉴定日期/报告出具日期」+ 无鉴定字段类型补「是否伤残鉴定/鉴定机构等级」（幂等）
    const MIGRATE_DISABILITY_FIELDS = {
      // JT/RS: 已有 是否伤残鉴定+鉴定机构等级，只补两个日期
      JT: { anchor: '鉴定机构/等级', fields: [
        ['伤残鉴定日期', 'date', ''], ['报告出具日期', 'date', '']
      ]},
      RS: { anchor: '鉴定机构/等级', fields: [
        ['伤残鉴定日期', 'date', ''], ['报告出具日期', 'date', '']
      ]},
      // YW/XP/JC/ZH/GZ: 无鉴定字段，在 处理阶段 前补 4 个
      YW: { anchor: '处理阶段', fields: [
        ['是否伤残鉴定', 'select', '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
        ['鉴定机构/等级', 'text', '如：司法鉴定所，十级'],
        ['伤残鉴定日期', 'date', ''], ['报告出具日期', 'date', '']
      ]},
      XP: { anchor: '处理阶段', fields: [
        ['是否伤残鉴定', 'select', '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
        ['鉴定机构/等级', 'text', '如：司法鉴定所，十级'],
        ['伤残鉴定日期', 'date', ''], ['报告出具日期', 'date', '']
      ]},
      JC: { anchor: '处理阶段', fields: [
        ['是否伤残鉴定', 'select', '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
        ['鉴定机构/等级', 'text', '如：司法鉴定所，十级'],
        ['伤残鉴定日期', 'date', ''], ['报告出具日期', 'date', '']
      ]},
      ZH: { anchor: '处理阶段', fields: [
        ['是否伤残鉴定', 'select', '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
        ['鉴定机构/等级', 'text', '如：司法鉴定所，十级'],
        ['伤残鉴定日期', 'date', ''], ['报告出具日期', 'date', '']
      ]},
      GZ: { anchor: '处理阶段', fields: [
        ['是否伤残鉴定', 'select', '[{"label":"是"},{"label":"否"},{"label":"待定"}]'],
        ['鉴定机构/等级', 'text', '如：司法鉴定所，十级'],
        ['伤残鉴定日期', 'date', ''], ['报告出具日期', 'date', '']
      ]},
    };
    for (const [code, { anchor, fields }] of Object.entries(MIGRATE_DISABILITY_FIELDS)) {
      const { rows: tRows } = await client.query(`SELECT id FROM case_types WHERE code = $1`, [code]);
      if (tRows.length === 0) continue;
      const tid = tRows[0].id;
      // 检查是否全部已存在（幂等）
      const allExist = await Promise.all(fields.map(async ([label]) => {
        const { rows } = await client.query(`SELECT id FROM case_fields WHERE case_type_id = $1 AND label = $2`, [tid, label]);
        return rows.length > 0;
      }));
      if (allExist.every(Boolean)) continue;
      // 查锚点 sort
      const { rows: aRows } = await client.query(`SELECT sort FROM case_fields WHERE case_type_id = $1 AND label = $2`, [tid, anchor]);
      if (aRows.length === 0) continue;
      let base = aRows[0].sort + 1;
      // 顺移冲突 sort
      const { rows: maxRows } = await client.query(`SELECT COALESCE(MAX(sort), 0) AS m FROM case_fields WHERE case_type_id = $1`, [tid]);
      if (base <= maxRows[0].m) await client.query(`UPDATE case_fields SET sort = sort + $1 WHERE case_type_id = $2 AND sort >= $3`, [fields.length * 1000, tid, base]);
      // 逐个插入未存在的字段
      for (let i = 0; i < fields.length; i++) {
        const [label, type, options] = fields[i];
        const { rows: exist } = await client.query(`SELECT id FROM case_fields WHERE case_type_id = $1 AND label = $2`, [tid, label]);
        if (exist.length > 0) continue;
        await client.query(
          `INSERT INTO case_fields (case_type_id, label, field_type, options, required, placeholder, sort, active)
           VALUES ($1, $2, $3, $4, FALSE, '', $5, TRUE)`,
          [tid, label, type, options === 'text' || options === 'date' ? null : options, base + i]
        );
      }
    }

    // 迁移：移除旧类型中与当事人表格重复的人员信息字段（person info now lives in case_parties）
    const OBSOLETE_REPEAT_FIELDS = {
      JT: ['当事人姓名', '当事人手机号', '身份证号'],
      GS: ['伤者姓名', '伤者手机号', '身份证号'],
      YW: ['被保人', '联系电话'],
      XP: ['学生姓名', '家长姓名', '家长手机号'],
    };
    for (const code of Object.keys(OBSOLETE_REPEAT_FIELDS)) {
      const tRows = await client.query(`SELECT id FROM case_types WHERE code = $1`, [code]);
      if (tRows.rows.length === 0) continue;
      await client.query(
        `DELETE FROM case_fields WHERE case_type_id = $1 AND label = ANY($2::text[])`,
        [tRows.rows[0].id, OBSOLETE_REPEAT_FIELDS[code]]
      );
    }

    // 迁移：按案件类型设置必填字段（幂等：只把 false→true，不反向改）
    const REQUIRED_FIELDS_BY_TYPE = {
      JT: ['事故时间', '事故地点', '责任认定情况', '事发经过', '处理阶段'],
      GS: ['发生地点', '事发经过', '处理阶段'],
      RS: ['损害发生时间', '损害发生地点', '事发经过', '侵权责任方', '处理阶段'],
      YW: ['出险时间', '出险原因', '处理阶段'],
      XP: ['出险时间', '出险地点', '学校名称', '处理阶段'],
      JC: ['出险时间', '出险地点', '出险原因', '处理阶段'],
      ZH: ['出险时间', '出险原因', '处理阶段'],
      GZ: ['出险时间', '出险地点', '出险原因', '投保单位', '处理阶段'],
      MS: ['出险时间', '出险地点', '出险原因', '处理阶段'],
    };
    for (const [code, labels] of Object.entries(REQUIRED_FIELDS_BY_TYPE)) {
      const { rows: tRows } = await client.query(`SELECT id FROM case_types WHERE code = $1`, [code]);
      if (tRows.length === 0) continue;
      const tid = tRows[0].id;
      for (const label of labels) {
        await client.query(
          `UPDATE case_fields SET required = TRUE WHERE case_type_id = $1 AND label = $2 AND required = FALSE`,
          [tid, label]
        );
      }
    }

    // 迁移：给所有「处理阶段」select 字段补「待定」选项（幂等：已含则跳过）
    await client.query(
      `UPDATE case_fields
       SET options = options::jsonb || '[{"label":"待定"}]'::jsonb
       WHERE label = '处理阶段' AND field_type = 'select'
         AND NOT (options::jsonb @> '[{"label":"待定"}]'::jsonb)`
    );

    // 迁移：存量库 wecom_push_events 补 reminder_notify 事件开关（幂等：已含则跳过）
    const { rows: wecomRow } = await client.query(`SELECT value FROM app_settings WHERE key = 'wecom_push_events'`);
    if (wecomRow.length > 0) {
      try {
        const ev = JSON.parse(wecomRow[0].value || '{}');
        if (!ev.reminder_notify) {
          ev.reminder_notify = '1';
          await client.query(`UPDATE app_settings SET value = $1 WHERE key = 'wecom_push_events'`, [JSON.stringify(ev)]);
        }
      } catch {}
    }

    const { rows: statusRows } = await client.query(`SELECT id FROM statuses LIMIT 1`);
    if (statusRows.length === 0) {
      for (const [name, category, color, sort] of SEED_STATUSES) {
        await client.query(
          `INSERT INTO statuses (name, category, color, sort) VALUES ($1,$2,$3,$4)`,
          [name, category, color, sort]
        );
      }
    } else {
      // 迁移①：旧模板（待受理/理赔中/诉讼中/调解中/已结案/已归档）→ 新 4 分类模板
      // 触发条件：存在旧模板标志状态"待受理"（该名称新模板与自定义均不会使用）
      const { rows: legacyCheck } = await client.query(
        `SELECT id, name, sort FROM statuses WHERE name = '待受理' LIMIT 1`
      );
      if (legacyCheck.length > 0) {
        // 保留所有行 id（案件引用安全），将旧名行更新为新模板对应行
        const { rows: allRows } = await client.query(`SELECT id, name FROM statuses`);
        const byName = {};
        allRows.forEach(r => { byName[r.name] = r.id; });
        const LEGACY_MAP = LEGACY_STATUS_MAP;
        for (const [oldName, newName] of Object.entries(LEGACY_MAP)) {
          const rowId = byName[oldName];
          if (!rowId) continue;
          const tpl = SEED_STATUSES.find(s => s[0] === newName);
          if (!tpl) continue;
          await client.query(
            `UPDATE statuses SET name=$1, category=$2, color=$3, sort=$4 WHERE id=$5`,
            [tpl[0], tpl[1], tpl[2], tpl[3], rowId]
          );
        }
        // 补齐新模板中缺失的状态
        const { rows: afterRows } = await client.query(`SELECT id, name FROM statuses`);
        const afterNames = new Set(afterRows.map(r => r.name));
        for (const tpl of SEED_STATUSES) {
          if (afterNames.has(tpl[0])) continue;
          await client.query(
            `INSERT INTO statuses (name, category, color, sort) VALUES ($1,$2,$3,$4)`,
            [tpl[0], tpl[1], tpl[2], tpl[3]]
          );
        }
        // 统一重排 sort：模板内状态按模板序号，其余（自定义/停用）排后
        const tplIdx = {};
        SEED_STATUSES.forEach((t, i) => { tplIdx[t[0]] = i + 1; });
        const { rows: finalRows } = await client.query(`SELECT id, name, sort FROM statuses ORDER BY sort, id`);
        const ordered = finalRows.slice().sort((a, b) => {
          const ai = tplIdx[a.name] !== undefined ? tplIdx[a.name] : 1000 + (a.sort || 0);
          const bi = tplIdx[b.name] !== undefined ? tplIdx[b.name] : 1000 + (b.sort || 0);
          return ai - bi;
        });
        for (let i = 0; i < ordered.length; i++) {
          await client.query(`UPDATE statuses SET sort = $1 WHERE id = $2`, [i + 1, ordered[i].id]);
        }
      } else {
        // 补插：确保 40 个模板状态齐全（已有同名状态不再新增）
        const { rows: curRows } = await client.query(`SELECT id, name FROM statuses`);
        const curNames = new Set(curRows.map(r => r.name));
        let insertedAny = false;
        for (const tpl of SEED_STATUSES) {
          if (curNames.has(tpl[0])) continue;
          await client.query(
            `INSERT INTO statuses (name, category, color, sort) VALUES ($1,$2,$3,$4)`,
            [tpl[0], tpl[1], tpl[2], tpl[3]]
          );
          insertedAny = true;
        }
        // 仅当本次补插了缺失状态时重排，避免覆盖用户在设置页拖拽调整过的排序
        if (insertedAny) {
          const tplIdx = {};
          SEED_STATUSES.forEach((t, i) => { tplIdx[t[0]] = i + 1; });
          const { rows: fRows } = await client.query(`SELECT id, name, sort FROM statuses ORDER BY sort, id`);
          const ordered = fRows.slice().sort((a, b) => {
            const ai = tplIdx[a.name] !== undefined ? tplIdx[a.name] : 1000 + (a.sort || 0);
            const bi = tplIdx[b.name] !== undefined ? tplIdx[b.name] : 1000 + (b.sort || 0);
            return ai - bi;
          });
          for (let i = 0; i < ordered.length; i++) {
            await client.query(`UPDATE statuses SET sort = $1 WHERE id = $2`, [i + 1, ordered[i].id]);
          }
        }
        // 迁移②：仅当存在重复排序序号时，按 sort,id 顺序重新编连续唯一序号
        const { rows: dupCheck } = await client.query(
          `SELECT COUNT(*)::int AS n FROM (
             SELECT sort FROM statuses GROUP BY sort HAVING COUNT(*) > 1
           ) d`
        );
        if (dupCheck[0].n > 0) {
          await client.query(
            `WITH ranked AS (
               SELECT id, ROW_NUMBER() OVER (ORDER BY sort, id) AS new_sort FROM statuses
             )
             UPDATE statuses s SET sort = r.new_sort FROM ranked r WHERE s.id = r.id`
          );
        }
      }
      // 迁移③：状态前缀排序 + 独特色板（一次性，用 app_settings 标记保证执行一次）
      const { rows: paletteFlag } = await client.query(
        `SELECT value FROM app_settings WHERE key = 'status_palette_v2' LIMIT 1`
      );
      if (paletteFlag.length === 0) {
        const { rows: cur = [] } = await client.query(`SELECT id, name, category FROM statuses`);
        const byName = {};
        cur.forEach((r) => { byName[r.name] = r; });
        for (const tpl of SEED_STATUSES) {
          const row = byName[tpl[0]];
          if (!row) continue;
          await client.query(
            `UPDATE statuses SET color=$1, sort=$2 WHERE id=$3`,
            [tpl[2], tpl[3], row.id]
          );
        }
        // 非种子状态（自定义/停用）保持相对顺序，排到 4XX 之后（从 900 起，避免区间冲突）
        const seedNames = SEED_STATUSES.map((t) => t[0]);
        const { rows: customRows } = await client.query(
          `SELECT id FROM statuses WHERE NOT (name = ANY($1::text[])) ORDER BY sort, id`,
          [seedNames]
        );
        for (let i = 0; i < customRows.length; i++) {
          await client.query(`UPDATE statuses SET sort = $1 WHERE id = $2`, [900 + i + 1, customRows[i].id]);
        }
        await client.query(
          `INSERT INTO app_settings (key, value, description) VALUES ('status_palette_v2', '1', '状态前缀排序与调色板已应用') ON CONFLICT (key) DO NOTHING`
        );
      }
      // 迁移④：调色板 v2 优化（按名称重新应用语义色，相邻状态色相间距≥100°，40色全唯一）
      const { rows: paletteV3Flag } = await client.query(
        `SELECT value FROM app_settings WHERE key = 'status_palette_v3' LIMIT 1`
      );
      if (paletteV3Flag.length === 0) {
        const { rows: cur3 = [] } = await client.query(`SELECT id, name, category FROM statuses`);
        const byName3 = {};
        cur3.forEach((r) => { byName3[r.name] = r; });
        const hasV2 = paletteFlag.length > 0;
        for (const tpl of SEED_STATUSES) {
          const row = byName3[tpl[0]];
          if (!row) continue;
          // 若 v2 已应用（前缀排序已完成），只改颜色不碰 sort；否则连 sort 一起修正
          if (hasV2) {
            await client.query(
              `UPDATE statuses SET color=$1 WHERE id=$2`, [tpl[2], row.id]
            );
          } else {
            await client.query(
              `UPDATE statuses SET color=$1, sort=$2 WHERE id=$3`, [tpl[2], tpl[3], row.id]
            );
          }
        }
        if (!hasV2) {
          // 非种子状态（自定义/停用）保持相对顺序，排到 4XX 之后（从 900 起）
          const seedNames3 = SEED_STATUSES.map((t) => t[0]);
          const { rows: customRows3 } = await client.query(
            `SELECT id FROM statuses WHERE NOT (name = ANY($1::text[])) ORDER BY sort, id`,
            [seedNames3]
          );
          for (let i = 0; i < customRows3.length; i++) {
            await client.query(`UPDATE statuses SET sort = $1 WHERE id = $2`, [900 + i + 1, customRows3[i].id]);
          }
        }
        await client.query(
          `INSERT INTO app_settings (key, value, description) VALUES ('status_palette_v3', '1', '调色板 v2 优化（相邻≥100°、40色唯一）已应用') ON CONFLICT (key) DO NOTHING`
        );
      }
      // 迁移⑤：调色板 v3 丰富化（40色均匀色相网格，列表相邻色相差≈171°，色相族均衡）
      const { rows: paletteV4Flag } = await client.query(
        `SELECT value FROM app_settings WHERE key = 'status_palette_v4' LIMIT 1`
      );
      if (paletteV4Flag.length === 0) {
        const { rows: cur4 = [] } = await client.query(`SELECT id, name FROM statuses`);
        const byName4 = {};
        cur4.forEach((r) => { byName4[r.name] = r; });
        for (const tpl of SEED_STATUSES) {
          const row = byName4[tpl[0]];
          if (!row) continue;
          await client.query(`UPDATE statuses SET color=$1 WHERE id=$2`, [tpl[2], row.id]);
        }
        await client.query(
          `INSERT INTO app_settings (key, value, description) VALUES ('status_palette_v4', '1', '调色板 v3 丰富化（均匀色相网格、相邻≈171°）已应用') ON CONFLICT (key) DO NOTHING`
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
      ['wecom_push_events', '{"reminder_notify":"1"}', '企业微信推送事件开关 JSON（case_assigned/status_changed/reminder_due/reminder_notify/new_attachment）'],
      ['wecom_webhook', '', '企业微信群机器人 Webhook 地址'],
      ['library_categories', JSON.stringify([
        { name: '法律法规', color: '#0d6efd' },
        { name: '赔偿标准', color: '#ffc107' },
        { name: '调解判决案例', color: '#0dcaf0' },
        { name: '司法解释', color: '#dc3545' },
        { name: '操作指引', color: '#198754' },
        { name: '其他', color: '#6c757d' }
      ]), '法律法规库分类列表 JSON（含名称和颜色）'],
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
