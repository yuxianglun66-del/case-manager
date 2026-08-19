const { pool } = require('./db');

const PERMISSIONS = [
  { key: 'cases.view_all', group: '案件管理', label: '查看全部案件', desc: '未开启仅能查看自己负责的案件' },
  { key: 'cases.create', group: '案件管理', label: '新建案件', desc: '可以创建新案件' },
  { key: 'cases.edit', group: '案件管理', label: '编辑案件', desc: '可以编辑案件信息与状态' },
  { key: 'cases.delete', group: '案件管理', label: '删除案件', desc: '可以删除案件（危险操作）' },
  { key: 'cases.assign', group: '案件管理', label: '指派负责人', desc: '可以指派 / 改派案件负责人' },
  { key: 'cases.remind', group: '案件管理', label: '设置流程提醒', desc: '可以设置下一步流程与提醒时间' },
  { key: 'cases.fee', group: '案件管理', label: '收费管理', desc: '可以编辑收费约定与明细' },
  { key: 'cases.import_export', group: '案件管理', label: '导入 / 导出', desc: '可以批量导入、导出案件数据' },
  { key: 'parties.manage', group: '当事人管理', label: '管理当事人', desc: '可以新增、编辑、删除当事人' },
  { key: 'attachments.manage', group: '附件管理', label: '管理附件', desc: '可以上传、替换、删除附件' },
  { key: 'contracts.manage', group: '合同管理', label: '合同签署与模板', desc: '可以发起电子签署、管理合同与模板' },
  { key: 'system.users', group: '系统管理', label: '用户管理', desc: '可以管理用户账号' },
  { key: 'system.roles', group: '系统管理', label: '角色与权限', desc: '可以配置各角色的细粒度权限（默认仅超级管理员）' },
  { key: 'system.settings', group: '系统管理', label: '系统设置', desc: '可以管理案件类型、状态、品牌主题等' },
];

const ROLES = {
  super_admin: { label: '超级管理员', color: '#d63384' },
  admin: { label: '管理员', color: '#6f42c1' },
  staff: { label: '员工', color: '#4361ee' },
};

const DEFAULT_PERMS = {
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

const ALL_PERM_KEYS = PERMISSIONS.map((p) => p.key);

let cache = null; // Map<role, Set<permission>>

async function loadPermissions() {
  const { rows } = await pool.query(`SELECT role, permission FROM role_permissions`);
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.role)) m.set(r.role, new Set());
    m.get(r.role).add(r.permission);
  }
  cache = m;
  return m;
}

function ensureLoaded() {
  if (!cache) {
    throw new Error('权限缓存尚未加载，请先调用 loadPermissions()');
  }
}

function hasPermission(user, perm) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  ensureLoaded();
  const set = cache.get(user.role);
  return !!set && set.has(perm);
}

function hasAnyPermission(user, perms) {
  return perms.some((p) => hasPermission(user, p));
}

function permissionsOf(role) {
  if (role === 'super_admin') return ALL_PERM_KEYS.slice();
  ensureLoaded();
  const set = cache.get(role);
  return set ? Array.from(set) : [];
}

async function setPermissions(role, permKeys) {
  const clean = Array.from(new Set(permKeys)).filter((k) => ALL_PERM_KEYS.includes(k));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM role_permissions WHERE role = $1`, [role]);
    for (const key of clean) {
      await client.query(`INSERT INTO role_permissions (role, permission) VALUES ($1, $2)`, [role, key]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  if (!cache) cache = new Map();
  cache.set(role, new Set(clean));
  return clean;
}

module.exports = {
  PERMISSIONS,
  ROLES,
  DEFAULT_PERMS,
  ALL_PERM_KEYS,
  loadPermissions,
  hasPermission,
  hasAnyPermission,
  permissionsOf,
  setPermissions,
};
