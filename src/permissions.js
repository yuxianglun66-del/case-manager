const { pool } = require('./db');

const PERMISSIONS = [
  { key: 'cases.view', group: '案件管理', label: '查看案件详情', desc: '可以查看案件详情、附件和费用' },
  { key: 'cases.view_all', group: '案件管理', label: '查看全部案件', desc: '未开启仅能查看自己负责的案件' },
  { key: 'cases.create', group: '案件管理', label: '新建案件', desc: '可以创建新案件' },
  { key: 'cases.edit', group: '案件管理', label: '编辑案件', desc: '可以编辑案件信息与状态' },
  { key: 'cases.delete', group: '案件管理', label: '删除/回收站', desc: '可以将案件移入回收站、恢复或彻底删除' },
  { key: 'cases.assign', group: '案件管理', label: '指派负责人', desc: '可以指派 / 改派案件负责人' },
  { key: 'cases.remind', group: '案件管理', label: '设置流程提醒', desc: '可以设置下一步流程与提醒时间' },
  { key: 'cases.fee', group: '案件管理', label: '收费管理', desc: '可以编辑收费约定与明细' },
  { key: 'cases.import_export', group: '案件管理', label: '导入 / 导出', desc: '可以批量导入、导出案件数据' },
  { key: 'cases.batch', group: '案件管理', label: '批量操作', desc: '可以批量修改案件状态、指派负责人' },
  { key: 'reports.view', group: '报表统计', label: '查看费用报表', desc: '可以查看费用 / 业绩统计报表' },
  { key: 'parties.manage', group: '当事人管理', label: '管理当事人', desc: '可以新增、编辑、删除当事人' },
  { key: 'attachments.manage', group: '附件管理', label: '管理附件', desc: '可以上传、替换、删除附件' },
  { key: 'contracts.manage', group: '合同管理', label: '合同签署与模板', desc: '可以发起电子签署、管理合同与模板' },
  { key: 'library.manage', group: '法律法规库', label: '管理法律法规', desc: '可以新增、编辑、删除法律法规资料' },
  { key: 'system.users', group: '系统管理', label: '用户管理', desc: '可以管理用户账号' },
  { key: 'system.roles', group: '系统管理', label: '角色与权限', desc: '可以配置角色的权限、新建自定义角色' },
  { key: 'system.settings', group: '系统管理', label: '系统设置', desc: '可以管理案件类型、状态、品牌主题等' },
];

/* 内置角色元数据（自定义角色保存在 roles 表） */
const ROLES = {
  super_admin: { label: '超级管理员', color: '#d63384', builtin: true },
  admin: { label: '管理员', color: '#6f42c1', builtin: true },
  staff: { label: '员工', color: '#4361ee', builtin: true },
};

const BUILTIN_ROLES = Object.keys(ROLES);

const DEFAULT_PERMS = {
  admin: [
    'cases.view', 'cases.view_all', 'cases.create', 'cases.edit', 'cases.delete', 'cases.assign',
    'cases.remind', 'cases.fee', 'cases.import_export', 'cases.batch', 'reports.view',
    'parties.manage', 'attachments.manage', 'contracts.manage', 'library.manage',
  ],
  staff: [
    'cases.view', 'cases.create', 'cases.edit', 'cases.remind', 'cases.fee', 'cases.batch', 'reports.view',
    'parties.manage', 'attachments.manage',
  ],
};

const ALL_PERM_KEYS = PERMISSIONS.map((p) => p.key);

let cache = null; // Map<role, Set<permission>>
let rolesCache = null; // Map<role, {key,label,color,builtin,sort}>

async function loadRoles() {
  const { rows } = await pool.query(
    `SELECT key, label, color, builtin, sort FROM roles ORDER BY sort, key`
  );
  rolesCache = new Map();
  for (const r of rows) rolesCache.set(r.key, r);
  return rolesCache;
}

async function loadPermissions() {
  const { rows } = await pool.query(`SELECT role, permission FROM role_permissions`);
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.role)) m.set(r.role, new Set());
    m.get(r.role).add(r.permission);
  }
  cache = m;
  try { await loadRoles(); } catch (e) {} // roles 表缺失时忽略，使用内置角色兜底
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

/* ---- 角色元数据（内置 + 自定义） ---- */

function getRoles() {
  if (rolesCache) {
    return Array.from(rolesCache.values());
  }
  return Object.keys(ROLES).map((k) => ({ key: k, label: ROLES[k].label, color: ROLES[k].color, builtin: true, sort: 1 }));
}

function getRoleMap() {
  if (rolesCache) return rolesCache;
  const m = new Map();
  for (const [k, v] of Object.entries(ROLES)) m.set(k, { key: k, label: v.label, color: v.color, builtin: true, sort: 1 });
  return m;
}

function getRoleLabel(role) {
  if (rolesCache) return (rolesCache.get(role) || {}).label || role;
  return (ROLES[role] || {}).label || role;
}

function roleExists(role) {
  return getRoleMap().has(role);
}

async function createRole(key, label, color) {
  if (!/^[a-z][a-z0-9_]{1,19}$/.test(key)) {
    throw new Error('角色标识须为小写字母开头的英文/数字/下划线，长度 2-20');
  }
  if (BUILTIN_ROLES.includes(key)) throw new Error('该角色标识为内置角色，不可重复创建');
  if (!label || !label.trim()) throw new Error('角色名称不能为空');
  if (roleExists(key)) throw new Error('该角色标识已存在');
  await pool.query(
    `INSERT INTO roles (key, label, color, builtin, sort) VALUES ($1, $2, $3, FALSE, 5)`,
    [key, (label || '').trim(), color || '#6f42c1']
  );
  await loadRoles();
  if (!cache) cache = new Map();
  cache.set(key, new Set());
  return key;
}

async function updateRole(key, label, color) {
  if (BUILTIN_ROLES.includes(key)) throw new Error('内置角色不可修改');
  const r = (await pool.query(`UPDATE roles SET label = $1, color = $2 WHERE key = $3 RETURNING key`, [(label || '').trim(), color || '#6f42c1', key])).rows;
  if (!r.length) throw new Error('角色不存在');
  await loadRoles();
}

async function deleteRole(key) {
  if (BUILTIN_ROLES.includes(key)) throw new Error('内置角色不可删除');
  if (!roleExists(key)) throw new Error('角色不存在');
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role = $1`, [key]);
  if (rows[0].n > 0) throw new Error(`该角色下还有 ${rows[0].n} 个用户，请先将用户调整到其他角色`);
  await pool.query(`DELETE FROM role_permissions WHERE role = $1`, [key]);
  await pool.query(`DELETE FROM roles WHERE key = $1`, [key]);
  await loadRoles();
  if (cache) cache.delete(key);
}

module.exports = {
  PERMISSIONS,
  ROLES,
  BUILTIN_ROLES,
  DEFAULT_PERMS,
  ALL_PERM_KEYS,
  loadPermissions,
  hasPermission,
  hasAnyPermission,
  permissionsOf,
  setPermissions,
  getRoles,
  getRoleMap,
  getRoleLabel,
  roleExists,
  createRole,
  updateRole,
  deleteRole,
};