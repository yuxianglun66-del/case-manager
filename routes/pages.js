const express = require('express');
const path = require('path');
const fs = require('fs');
const { pool } = require('../src/db');
const { requireLogin, requirePermission, canViewCase } = require('../src/auth');
const { hasPermission, PERMISSIONS, ROLES, permissionsOf } = require('../src/permissions');

const router = express.Router();
router.use(requireLogin);

function canViewAll(user) {
  return hasPermission(user, 'cases.view_all');
}

function scopeClause(user) {
  if (canViewAll(user)) return { where: '', params: [] };
  return { where: ' AND c.assignee_id = $1', params: [user.id] };
}

// 全文搜索：案号/标题/客户 + 自定义字段（备注/地点等）+ 当事人 + 历史备注
function kwCond(params) {
  const p = params.length;
  return `(c.case_no ILIKE $${p} OR c.title ILIKE $${p} OR c.client_name ILIKE $${p}
    OR c.status_note ILIKE $${p} OR c.next_action ILIKE $${p}
    OR EXISTS (SELECT 1 FROM case_field_values fv WHERE fv.case_id = c.id AND fv.value ILIKE $${p})
    OR EXISTS (SELECT 1 FROM case_parties pp WHERE pp.case_id = c.id AND pp.name ILIKE $${p})
    OR EXISTS (SELECT 1 FROM case_history h WHERE h.case_id = c.id AND h.note ILIKE $${p}))`;
}

/* ---------- 看板 ---------- */
router.get('/dashboard', async (req, res, next) => {
  try {
    const sc = scopeClause(req.session.user);

    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM cases c WHERE c.deleted_at IS NULL${sc.where}`, sc.params);
    const byType = await pool.query(
      `SELECT t.id, t.name, t.color, COUNT(c.id)::int AS n
       FROM case_types t
       LEFT JOIN cases c ON c.case_type_id = t.id AND c.deleted_at IS NULL
       WHERE t.active = TRUE${sc.where.replace(/c\.assignee_id/g, 'c.assignee_id')}
       GROUP BY t.id ORDER BY t.sort`,
      sc.params
    );
    const byStatus = await pool.query(
      `SELECT s.id, s.name, s.color, s.category, COUNT(c.id)::int AS n
       FROM statuses s
       LEFT JOIN cases c ON c.status_id = s.id AND c.deleted_at IS NULL
       WHERE s.active = TRUE${sc.where.replace(/c\.assignee_id/g, 'c.assignee_id')}
       GROUP BY s.id ORDER BY s.sort`,
      sc.params
    );
    const recent = await pool.query(
      `SELECT c.id, c.case_no, c.title, c.client_name, c.updated_at,
              t.name AS type_name, t.color AS type_color,
              s.name AS status_name, s.color AS status_color,
              u.display_name AS assignee_name
       FROM cases c
       LEFT JOIN case_types t ON t.id = c.case_type_id
       LEFT JOIN statuses s ON s.id = c.status_id
       LEFT JOIN users u ON u.id = c.assignee_id
       WHERE c.deleted_at IS NULL${sc.where}
       ORDER BY c.updated_at DESC LIMIT 8`,
      sc.params
    );

    const workload = canViewAll(req.session.user)
      ? (await pool.query(
          `SELECT u.id, u.display_name, COUNT(c.id)::int AS n
           FROM users u LEFT JOIN cases c ON c.assignee_id = u.id AND c.deleted_at IS NULL
           WHERE u.active = TRUE GROUP BY u.id, u.display_name ORDER BY n DESC`
        )).rows
      : [];

    /* ---------- 待办提醒：已逾期 + 今天 + 未来 advanceDays 天内 ---------- */
    const advDaysRow = (await pool.query(`SELECT value FROM app_settings WHERE key = 'reminder_advance_days'`)).rows[0];
    const advanceDays = Math.max(parseInt(advDaysRow && advDaysRow.value, 10) || 3, 0);
    const reminderScope = canViewAll(req.session.user)
      ? { where: '', params: [] }
      : { where: ' AND c.assignee_id = $2', params: [req.session.user.id] };
    const remindersSql =
      `SELECT c.id, c.case_no, c.title, c.client_name, c.next_action, c.reminder_at,
              c.assignee_id, c.reminder_ack_at, c.reminder_ack_by,
              u.display_name AS assignee_name,
              s.name AS status_name, s.color AS status_color
       FROM cases c
       LEFT JOIN users u ON u.id = c.assignee_id
       LEFT JOIN statuses s ON s.id = c.status_id
       WHERE c.reminder_at IS NOT NULL
         AND c.deleted_at IS NULL
         AND c.next_action IS NOT NULL AND c.next_action <> ''
         AND c.reminder_ack_at IS NULL
         AND c.reminder_at <= now() + ($1 * interval '1 day')
         ${reminderScope.where}
       ORDER BY c.reminder_at ASC`;
    const remParams = [advanceDays].concat(reminderScope.params);
    const { rows: reminders } = await pool.query(remindersSql, remParams);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const classified = reminders.map(r => {
      const d = new Date(r.reminder_at);
      let level;
      if (d < startOfToday) level = 'overdue';          // 已逾期
      else if (d < endOfToday) level = 'today';          // 今天到期
      else level = 'upcoming';                            // 未来 advanceDays 天内
      return { ...r, level, reminder_at: d };
    });
    const overdueCount = classified.filter(r => r.level === 'overdue').length;
    const todayCount = classified.filter(r => r.level === 'today').length;
    const upcomingCount = classified.filter(r => r.level === 'upcoming').length;

    res.render('dashboard', {
      title: '工作看板',
      total: total.rows[0].n,
      byType: byType.rows,
      byStatus: byStatus.rows,
      recent: recent.rows,
      workload,
      reminders: classified,
      advanceDays,
      overdueCount,
      todayCount,
      upcomingCount,
    });
  } catch (e) { next(e); }
});

/* ---------- 案件列表 ---------- */
router.get('/cases', async (req, res, next) => {
  try {
    const user = req.session.user;
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const per = 20;
    const kw = (req.query.kw || '').trim();
    const typeId = parseInt(req.query.type, 10) || null;
    const statusId = parseInt(req.query.status, 10) || null;
    const assigneeId = parseInt(req.query.assignee, 10) || null;
    const dateFrom = (req.query.date_from || '').trim();
    const dateTo = (req.query.date_to || '').trim();
    const cat = (req.query.cat || '').trim();

    const where = ['c.deleted_at IS NULL'];
    const params = [];
    if (kw) { params.push(`%${kw}%`); where.push(kwCond(params)); }
    if (typeId) { params.push(typeId); where.push(`c.case_type_id = $${params.length}`); }
    if (statusId) { params.push(statusId); where.push(`c.status_id = $${params.length}`); }
    if (assigneeId && canViewAll(user)) { params.push(assigneeId); where.push(`(c.assignee_id = $${params.length} OR c.sign_staff_id = $${params.length})`); }
    if (dateFrom) { params.push(dateFrom); where.push(`c.sign_date >= $${params.length}`); }
    if (dateTo) { params.push(dateTo); where.push(`c.sign_date <= $${params.length}`); }
    const catSql = {
      pending: `s2.category = 'pending'`,
      processing: `s2.category = 'processing'`,
      litigation: `s2.category = 'litigation'`,
      closed: `(s2.category = 'closed' OR s2.category = 'archived')`
    };
    if (catSql[cat]) where.push(`EXISTS (SELECT 1 FROM statuses s2 WHERE s2.id = c.status_id AND ${catSql[cat]})`);
    if (!canViewAll(user)) { params.push(user.id); where.push(`(c.assignee_id = $${params.length} OR c.sign_staff_id = $${params.length})`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM cases c ${whereSql}`, params);
    const totalPages = Math.max(Math.ceil(count.rows[0].n / per), 1);
    const cur = Math.min(page, totalPages);
    const offset = (cur - 1) * per;

    params.push(per, offset);
    const { rows: cases } = await pool.query(
      `SELECT c.id, c.case_no, c.title, c.client_name, c.updated_at, c.next_action, c.reminder_at, c.fee_agreement, c.fee_details,
              c.sign_date, c.sign_staff_id,
              t.name AS type_name, t.color AS type_color, t.code AS type_code,
              s.name AS status_name, s.color AS status_color,
              u.display_name AS assignee_name,
              us.display_name AS sign_staff_name,
              (SELECT COUNT(*)::int FROM attachments a WHERE a.case_id = c.id) AS file_count
       FROM cases c
       LEFT JOIN case_types t ON t.id = c.case_type_id
       LEFT JOIN statuses s ON s.id = c.status_id
       LEFT JOIN users u ON u.id = c.assignee_id
       LEFT JOIN users us ON us.id = c.sign_staff_id
       ${whereSql}
       ORDER BY c.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const types = (await pool.query(`SELECT id, name FROM case_types WHERE active = TRUE ORDER BY sort`)).rows;
    const statuses = (await pool.query(`SELECT id, name FROM statuses WHERE active = TRUE ORDER BY sort`)).rows;
    const staff = canViewAll(user)
      ? (await pool.query(`SELECT id, display_name FROM users WHERE active = TRUE ORDER BY display_name`)).rows
      : [];

    res.render('cases/list', {
      title: '案件管理',
      cases, types, statuses, staff,
      filters: { kw, type: typeId, status: statusId, assignee: assigneeId, date_from: dateFrom, date_to: dateTo, cat },
      page: cur, totalPages, total: count.rows[0].n,
    });
  } catch (e) { next(e); }
});

/* ---------- 回收站（软删除案件，仅删除权限用户） ---------- */
router.get('/cases/recycle', requirePermission('cases.delete'), async (req, res, next) => {
  try {
    const user = req.session.user;
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const per = 20;
    const kw = (req.query.kw || '').trim();

    const where = ['c.deleted_at IS NOT NULL'];
    const params = [];
    if (kw) { params.push(`%${kw}%`); where.push(kwCond(params)); }
    if (!canViewAll(user)) { params.push(user.id); where.push(`(c.assignee_id = $${params.length} OR c.sign_staff_id = $${params.length})`); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM cases c ${whereSql}`, params);
    const totalPages = Math.max(Math.ceil(count.rows[0].n / per), 1);
    const cur = Math.min(page, totalPages);
    const offset = (cur - 1) * per;

    params.push(per, offset);
    const { rows: deletedCases } = await pool.query(
      `SELECT c.id, c.case_no, c.title, c.client_name, c.deleted_at, c.updated_at,
              t.name AS type_name, t.color AS type_color,
              s.name AS status_name, s.color AS status_color,
              u.display_name AS assignee_name,
              du.display_name AS deleted_by_name
       FROM cases c
       LEFT JOIN case_types t ON t.id = c.case_type_id
       LEFT JOIN statuses s ON s.id = c.status_id
       LEFT JOIN users u ON u.id = c.assignee_id
       LEFT JOIN users du ON du.id = c.deleted_by
       ${whereSql}
       ORDER BY c.deleted_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.render('cases/recycle', {
      title: '回收站',
      deletedCases,
      page: cur, totalPages, total: count.rows[0].n,
      filters: { kw },
    });
  } catch (e) { next(e); }
});

/* ---------- 案件新增表单 ---------- */
router.get('/cases/new', async (req, res, next) => {
  try {
    const user = req.session.user;
    const types = (await pool.query(
      `SELECT t.*, (SELECT COUNT(*)::int FROM case_fields f WHERE f.case_type_id = t.id AND f.active = TRUE) AS field_count
       FROM case_types t WHERE t.active = TRUE ORDER BY t.sort`
    )).rows;
    const staff = hasPermission(user, 'cases.assign')
      ? (await pool.query(`SELECT id, display_name FROM users WHERE active = TRUE ORDER BY display_name`)).rows
      : [];
    const statuses = (await pool.query(`SELECT id, name, color FROM statuses WHERE active = TRUE ORDER BY sort`)).rows;

    const allFields = (await pool.query(
      `SELECT * FROM case_fields WHERE active = TRUE ORDER BY case_type_id, sort`
    )).rows;
    const fieldsByType = {};
    allFields.forEach((f) => {
      if (!fieldsByType[f.case_type_id]) fieldsByType[f.case_type_id] = [];
      fieldsByType[f.case_type_id].push(f);
    });

    res.render('cases/form', {
      title: '新增案件',
      mode: 'new',
      caseData: null,
      caseTypeId: parseInt(req.query.type, 10) || (types.length > 0 ? types[0].id : null),
      types, staff, statuses,
      staffAll: (await pool.query(`SELECT id, display_name FROM users WHERE active = TRUE ORDER BY display_name`)).rows,
      fieldsByType,
      values: {},
      errors: null,
    });
  } catch (e) { next(e); }
});

/* ---------- 案件编辑表单 ---------- */
router.get('/cases/:id/edit', async (req, res, next) => {
  try {
    const user = req.session.user;
    const id = parseInt(req.params.id, 10);
    const c = (await pool.query(`SELECT * FROM cases WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return res.status(404).render('error', { title: '案件不存在', message: '案件不存在或已被删除。', user });
    if (!canViewCase(user, c)) return res.status(403).render('error', { title: '无权访问', message: '您无权操作他人的案件。', user });

    const types = (await pool.query(
      `SELECT t.*, (SELECT COUNT(*)::int FROM case_fields f WHERE f.case_type_id = t.id AND f.active = TRUE) AS field_count
       FROM case_types t WHERE t.active = TRUE ORDER BY t.sort`
    )).rows;
    const staff = hasPermission(user, 'cases.assign')
      ? (await pool.query(`SELECT id, display_name FROM users WHERE active = TRUE ORDER BY display_name`)).rows
      : [];
    const statuses = (await pool.query(`SELECT id, name, color FROM statuses WHERE active = TRUE ORDER BY sort`)).rows;
    const fields = (await pool.query(
      `SELECT * FROM case_fields WHERE case_type_id = $1 AND active = TRUE ORDER BY sort`, [c.case_type_id]
    )).rows;
    const fieldVals = (await pool.query(
      `SELECT field_id, value FROM case_field_values WHERE case_id = $1`, [id]
    )).rows;
    const values = {};
    fieldVals.forEach((v) => { values[v.field_id] = v.value; });

    // sign_date 为 DATE 类型，格式化为 YYYY-MM-DD 便于表单回显
    if (c.sign_date) {
      const d = new Date(c.sign_date);
      c.sign_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    res.render('cases/form', {
      title: '编辑案件',
      mode: 'edit',
      caseData: c,
      caseTypeId: c.case_type_id,
      types, staff, statuses,
      staffAll: (await pool.query(`SELECT id, display_name FROM users WHERE active = TRUE ORDER BY display_name`)).rows,
      fieldsByType: { [c.case_type_id]: fields },
      values, errors: null,
    });
  } catch (e) { next(e); }
});

/* ---------- 案件详情 ---------- */
router.get('/cases/:id', async (req, res, next) => {
  try {
    const user = req.session.user;
    const id = parseInt(req.params.id, 10);
    const c = (await pool.query(
      `SELECT c.*, u.display_name AS assignee_name,
              us.display_name AS sign_staff_name,
              t.name AS type_name, t.color AS type_color, t.code AS type_code,
              s.name AS status_name, s.color AS status_color,
              cu.display_name AS creator_name
       FROM cases c
       LEFT JOIN users u ON u.id = c.assignee_id
       LEFT JOIN users us ON us.id = c.sign_staff_id
       LEFT JOIN case_types t ON t.id = c.case_type_id
       LEFT JOIN statuses s ON s.id = c.status_id
       LEFT JOIN users cu ON cu.id = c.created_by
       WHERE c.id = $1 AND c.deleted_at IS NULL`, [id]
    )).rows[0];
    if (!c) return res.status(404).render('error', { title: '案件不存在', message: '案件不存在或已被删除。', user });
    if (!canViewCase(user, c)) return res.status(403).render('error', { title: '无权访问', message: '您无权查看他人的案件。', user });

    const fields = (await pool.query(
      `SELECT * FROM case_fields WHERE case_type_id = $1 AND active = TRUE ORDER BY sort`, [c.case_type_id]
    )).rows;
    const fieldVals = (await pool.query(
      `SELECT field_id, value FROM case_field_values WHERE case_id = $1`, [id]
    )).rows;
    const values = {};
    fieldVals.forEach((v) => { values[v.field_id] = v.value; });

    const history = (await pool.query(
      `SELECT h.*, s.name AS status_name, s.color AS status_color,
              u.display_name AS operator_name
       FROM case_history h
       LEFT JOIN statuses s ON s.id = h.status_id
       LEFT JOIN users u ON u.id = h.operator_id
       WHERE h.case_id = $1
       ORDER BY h.created_at DESC, h.id DESC`, [id]
    )).rows;

    const attachments = (await pool.query(
      `SELECT a.*, u.display_name AS uploader_name
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE a.case_id = $1 ORDER BY a.created_at DESC`, [id]
    )).rows;

    const parties = (await pool.query(
      `SELECT * FROM case_parties WHERE case_id = $1 ORDER BY sort, id`, [id]
    )).rows;

    const contracts = (await pool.query(
      `SELECT c.*, ct.name AS template_name,
              (SELECT json_agg(json_build_object('id', cs.id, 'party_name', cs.party_name, 'party_role', cs.party_role, 'status', cs.status, 'signed_at', cs.signed_at, 'sign_token', cs.sign_token))
               FROM contract_signatures cs WHERE cs.contract_id = c.id) AS signatures
       FROM contracts c
       LEFT JOIN contract_templates ct ON ct.id = c.template_id
       WHERE c.case_id = $1 ORDER BY c.created_at DESC`, [id]
    )).rows;

    const statuses = (await pool.query(`SELECT id, name, color FROM statuses WHERE active = TRUE ORDER BY sort`)).rows;

    res.render('cases/detail', {
      title: c.case_no,
      caseData: c, fields, values, history, attachments, statuses, parties, contracts,
    });
  } catch (e) { next(e); }
});

/* ---------- 用户管理 ---------- */
router.get('/users', requirePermission('system.users'), async (req, res, next) => {
  try {
    const { rows: users } = await pool.query(
      `SELECT u.*, (SELECT COUNT(*)::int FROM cases c WHERE c.assignee_id = u.id AND c.deleted_at IS NULL) AS case_count
       FROM users u ORDER BY u.role, u.id`
    );
    const canManageRoles = hasPermission(req.session.user, 'system.roles');
    const rolePerms = {
      super_admin: { permissions: PERMISSIONS.map((p) => p.key), locked: true },
      admin: { permissions: permissionsOf('admin'), locked: false },
      staff: { permissions: permissionsOf('staff'), locked: false },
    };
    res.render('users/list', {
      title: '用户管理',
      users,
      canManageRoles,
      rolePerms,
      perms: PERMISSIONS,
      roles: ROLES,
    });
  } catch (e) { next(e); }
});

/* ---------- 系统设置 ---------- */
router.get('/settings', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const types = (await pool.query(`SELECT * FROM case_types ORDER BY sort`)).rows;
    const fields = (await pool.query(`SELECT * FROM case_fields ORDER BY case_type_id, sort`)).rows;
    const statuses = (await pool.query(`SELECT * FROM statuses ORDER BY sort`)).rows;

    const fieldsByType = {};
    fields.forEach((f) => {
      if (!fieldsByType[f.case_type_id]) fieldsByType[f.case_type_id] = [];
      fieldsByType[f.case_type_id].push(f);
    });

    const templates = (await pool.query(
      `SELECT ct.*, t.name AS type_name FROM contract_templates ct
       LEFT JOIN case_types t ON t.id = ct.case_type_id
       WHERE ct.active = TRUE ORDER BY ct.id`
    )).rows;

    res.render('settings/index', { title: '系统设置', types, fieldsByType, statuses, settings: res.locals.settings, templates });
  } catch (e) { next(e); }
});

// 可视化模板编辑器
router.get('/settings/templates/:id/edit', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const tpl = (await pool.query(`SELECT * FROM contract_templates WHERE id = $1 AND active = TRUE`, [id])).rows[0];
    if (!tpl) return res.status(404).render('error', { title: '模板不存在', message: '模板不存在或已停用。', user: req.session.user });
    const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
    let pdfB64 = '';
    if (tpl.pdf_path) {
      const fp = path.join(uploadDir, tpl.pdf_path);
      if (fs.existsSync(fp)) pdfB64 = fs.readFileSync(fp).toString('base64');
    }
    res.render('template-editor', { title: '模板编辑器', tpl, pdfB64 });
  } catch (e) { next(e); }
});

/* ---------- 备份与恢复（仅超级管理员） ---------- */
router.get('/settings/backup', async (req, res, next) => {
  try {
    if (!req.session.user || req.session.user.role !== 'super_admin') {
      return res.status(403).render('error', {
        title: '无权访问',
        message: '仅超级管理员可访问备份与恢复。',
        user: req.session.user
      });
    }
    const { listBackups, readBackupSettings } = require('../src/backup');
    const files = listBackups();
    const backupSettings = await readBackupSettings();
    res.render('settings/backup', { title: '备份与恢复', files, backupSettings });
  } catch (e) { next(e); }
});

/* ---------- 操作日志（仅超级管理员） ---------- */
router.get('/settings/audit', async (req, res, next) => {
  try {
    if (!req.session.user || req.session.user.role !== 'super_admin') {
      return res.status(403).render('error', {
        title: '无权访问',
        message: '仅超级管理员可查看操作日志。',
        user: req.session.user
      });
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const conds = [];
    const params = [];
    const { user_id, action, date_from, date_to, keyword } = req.query;
    if (user_id) { params.push(parseInt(user_id, 10)); conds.push(`user_id = $${params.length}`); }
    if (action) { params.push(String(action)); conds.push(`action = $${params.length}`); }
    if (date_from) { params.push(String(date_from)); conds.push(`created_at >= $${params.length}::date`); }
    if (date_to) { params.push(String(date_to)); conds.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    if (keyword) { params.push(`%${String(keyword)}%`); conds.push(`(detail ILIKE $${params.length} OR display_name ILIKE $${params.length})`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const countRow = (await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs ${where}`, params)).rows[0];
    const total = countRow.n;
    const rows = (await pool.query(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )).rows;
    const users = (await pool.query(`SELECT id, display_name, username FROM users ORDER BY display_name`)).rows;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const { readAuditSettings } = require('../src/audit');
    const auditCfg = await readAuditSettings();

    res.render('settings/audit', {
      title: '操作日志', logs: rows, users, total, page, limit, totalPages, auditCfg,
      q: { user_id: user_id || '', action: action || '', date_from: date_from || '', date_to: date_to || '', keyword: keyword || '' },
    });
  } catch (e) { next(e); }
});

/* ---------- 运行状态（仅超级管理员） ---------- */
router.get('/settings/status', async (req, res, next) => {
  try {
    if (!req.session.user || req.session.user.role !== 'super_admin') {
      return res.status(403).render('error', {
        title: '无权访问',
        message: '仅超级管理员可查看运行状态。',
        user: req.session.user
      });
    }
    const { execFileSync } = require('child_process');
    const os = require('os');

    const [dbVerRow, appRows, caseRow, notifyRow] = await Promise.all([
      pool.query(`SELECT version() AS v`),
      pool.query(`SELECT key, value FROM app_settings`),
      pool.query(`SELECT COUNT(*)::int AS n FROM cases WHERE deleted_at IS NULL`),
      pool.query(`SELECT COUNT(*)::int AS total,
                    COALESCE(SUM((status = 'fail')::int), 0)::int AS fails
                  FROM notify_logs WHERE created_at >= now() - INTERVAL '7 days'`),
    ]);

    const s = {};
    appRows.rows.forEach((r) => { s[r.key] = r.value; });

    const remindersSql = `SELECT COUNT(*)::int AS n FROM cases
      WHERE reminder_at IS NOT NULL AND next_action IS NOT NULL AND next_action <> ''
        AND reminder_ack_at IS NULL AND deleted_at IS NULL
        AND reminder_at <= now() + ($1 * interval '1 day')`;
    const adv = parseInt(s.reminder_advance_days, 10) || 3;
    const remRow = (await pool.query(remindersSql, [adv])).rows[0];

    let libreoffice = true;
    try { execFileSync('which', ['libreoffice'], { stdio: 'ignore' }); } catch (e) { libreoffice = false; }

    const mem = process.memoryUsage();
    const used = Math.round(process.uptime() / 60);

    const config = [
      {
        key: 'app_url',
        label: 'APP_URL（签署链接域名）',
        ok: !!s.app_url,
        tip: '未设置时签署/找回密码链接将使用请求主机名，部署在反向代理后时可能不正确',
      },
      {
        key: 'wecom_enabled',
        label: '企业微信推送',
        ok: s.wecom_enabled === '1',
        tip: '未启用，事件只在站内通知中可见',
      },
      {
        key: 'backup',
        label: '自动备份',
        ok: s.backup_enabled === '1',
        tip: '未启用自动备份，建议开启以防数据丢失（设置：' + (s.backup_time || '02:00') + '）',
      },
      {
        key: 'company_name',
        label: '机构名称',
        ok: !!s.company_name,
        tip: '未设置机构名称，界面将显示默认名',
      },
    ];

    if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'case-manager-session-secret')) {
      config.push({ key: 'session_secret', label: 'SESSION_SECRET 环境变量', ok: false, tip: '生产环境使用默认密钥，会话存在被伪造风险' });
    }

    res.render('settings/status', {
      title: '运行状态',
      proc: {
        uptimeMin: used,
        memoryMB: Math.round(mem.rss / 1024 / 1024),
        heapMB: Math.round(mem.heapUsed / 1024 / 1024),
        node: process.version,
        pid: process.pid,
        platform: process.platform + ' ' + os.release(),
        arch: process.arch,
        cpus: os.cpus().length,
        loadavg: os.loadavg(),
      },
      dbVersion: String(dbVerRow.rows[0].v).split(' on ')[0],
      libreoffice,
      config,
      notify: notifyRow.rows[0],
      caseCount: caseRow.rows[0].n,
      reminderCount: remRow.n,
      isProd: process.env.NODE_ENV === 'production',
      envHasAppUrl: !!process.env.APP_URL,
    });
  } catch (e) { next(e); }
});

router.get('/library', async (req, res, next) => {
  try {
    const { rows: items } = await pool.query(
      `SELECT l.*, u.display_name AS creator_name FROM library_items l LEFT JOIN users u ON u.id = l.created_by ORDER BY l.created_at DESC`
    );
    const { rows: catRows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'library_categories'`);
    let categories = [];
    try { categories = JSON.parse(catRows[0]?.value || '[]'); } catch (e) {}
    res.render('library', { title: '法律法规库', items, categories, canEdit: hasPermission(req.session.user, 'cases.edit') });
  } catch (e) { next(e); }
});

/* ---------- 费用/业绩报表 ---------- */
router.get('/reports/finance', async (req, res, next) => {
  try {
    const user = req.session.user;
    const viewAll = canViewAll(user);
    const dateFrom = (req.query.date_from || '').trim();
    const dateTo = (req.query.date_to || '').trim();
    const assigneeId = parseInt(req.query.assignee, 10) || null;
    const feeType = (req.query.fee_type || '').trim();

    // ---- 案件维度：业绩与收款率（按 sign_date 过滤） ----
    const cWhere = [];
    const cParams = [];
    let p = 0;
    if (dateFrom) { cParams.push(dateFrom); cWhere.push(`c.sign_date >= $${++p}`); }
    if (dateTo) { cParams.push(dateTo); cWhere.push(`c.sign_date <= $${++p}`); }
    if (assigneeId && viewAll) { cParams.push(assigneeId); cWhere.push(`c.assignee_id = $${++p}`); }
    if (!viewAll) { cParams.push(user.id); cWhere.push(`(c.assignee_id = $${++p} OR c.sign_staff_id = $${++p})`); }
    const cWhereSql = cWhere.length
      ? `WHERE ${cWhere.join(' AND ')} AND c.deleted_at IS NULL`
      : 'WHERE c.deleted_at IS NULL';
    const caseStats = (await pool.query(
      `SELECT
         COUNT(*)::int AS case_count,
         COUNT(*) FILTER (WHERE s.category IN ('closed','archived')) AS settled_case_count,
         COALESCE(SUM(c.target_amount), 0) AS target_total,
         COALESCE(SUM(c.received_amount), 0) AS received_total,
         COALESCE(SUM(CASE WHEN s.category IN ('closed','archived') THEN c.target_amount ELSE 0 END), 0) AS settled_target,
         COALESCE(SUM(CASE WHEN s.category IN ('closed','archived') THEN c.received_amount ELSE 0 END), 0) AS settled_received
       FROM cases c
       LEFT JOIN statuses s ON s.id = c.status_id
       ${cWhereSql}`, cParams
    )).rows[0];

    const byStaff = (await pool.query(
      `SELECT c.assignee_id, u.display_name AS assignee_name,
              COUNT(*)::int AS case_count,
              COALESCE(SUM(c.target_amount),0) AS target_total,
              COALESCE(SUM(c.received_amount),0) AS received_total
       FROM cases c
       LEFT JOIN users u ON u.id = c.assignee_id
       ${cWhereSql}
       GROUP BY c.assignee_id, u.display_name ORDER BY received_total DESC`, cParams
    )).rows;

    // ---- 费用维度（按费用创建时间过滤） ----
    const fWhere = [];
    const fParams = [];
    p = 0;
    if (dateFrom) { fParams.push(dateFrom); fWhere.push(`f.created_at >= $${++p}::date`); }
    if (dateTo) { fParams.push(dateTo); fWhere.push(`f.created_at < ($${++p}::date + INTERVAL '1 day')`); }
    if (feeType) { fParams.push(feeType); fWhere.push(`f.fee_type = $${++p}`); }
    let fScopeSql = '';
    if (!viewAll) { fParams.push(user.id); fScopeSql = ` AND (c.assignee_id = $${++p} OR c.sign_staff_id = $${++p})`; }
    else if (assigneeId) { fParams.push(assigneeId); fScopeSql = ` AND c.assignee_id = $${++p}`; }
    const fWhereSql = fWhere.length ? `WHERE ${fWhere.join(' AND ')}` : 'WHERE 1=1';

    const feeSummary = (await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN f.direction='income' THEN f.amount ELSE 0 END),0) AS income_total,
         COALESCE(SUM(CASE WHEN f.direction='expense' THEN f.amount ELSE 0 END),0) AS expense_total,
         COUNT(*)::int AS fee_count
       FROM case_fees f
       JOIN cases c ON c.id = f.case_id AND c.deleted_at IS NULL
       ${fWhereSql}${fScopeSql}`, fParams
    )).rows[0];

    const byFeeType = (await pool.query(
      `SELECT f.fee_type,
         COUNT(*)::int AS cnt,
         COALESCE(SUM(CASE WHEN f.direction='income' THEN f.amount ELSE 0 END),0) AS income,
         COALESCE(SUM(CASE WHEN f.direction='expense' THEN f.amount ELSE 0 END),0) AS expense
       FROM case_fees f
       JOIN cases c ON c.id = f.case_id AND c.deleted_at IS NULL
       ${fWhereSql}${fScopeSql}
       GROUP BY f.fee_type ORDER BY income DESC, expense DESC`, fParams
    )).rows;

    const byStaffFee = (await pool.query(
      `SELECT COALESCE(u.display_name,'未分配') AS assignee_name,
         COUNT(f.id)::int AS cnt,
         COALESCE(SUM(CASE WHEN f.direction='income' THEN f.amount ELSE 0 END),0) AS income,
         COALESCE(SUM(CASE WHEN f.direction='expense' THEN f.amount ELSE 0 END),0) AS expense
       FROM case_fees f
       JOIN cases c ON c.id = f.case_id AND c.deleted_at IS NULL
       LEFT JOIN users u ON u.id = c.assignee_id
       ${fWhereSql}${fScopeSql}
       GROUP BY u.display_name ORDER BY income DESC`, fParams
    )).rows;

    const feeRows = (await pool.query(
      `SELECT f.id, f.case_id, f.fee_type, f.direction, f.amount, f.payer, f.status, f.note,
              TO_CHAR(f.paid_at, 'YYYY-MM-DD') AS paid_at, f.created_at,
              c.case_no, c.title, c.assignee_id,
              u.display_name AS assignee_name
       FROM case_fees f
       JOIN cases c ON c.id = f.case_id AND c.deleted_at IS NULL
       LEFT JOIN users u ON u.id = c.assignee_id
       ${fWhereSql}${fScopeSql}
       ORDER BY f.created_at DESC LIMIT 500`, fParams
    )).rows;

    const freqFeeTypes = (await pool.query(`SELECT DISTINCT fee_type FROM case_fees ORDER BY fee_type`)).rows.map(r => r.fee_type);
    const staff = viewAll ? (await pool.query(`SELECT id, display_name FROM users WHERE active = TRUE ORDER BY display_name`)).rows : [];
    const FEE_TYPE_NAMES = ['保全费', '鉴定费', '一审诉讼费', '二审诉讼费', '律师费', '差旅费', '茶水费', '公证费', '其他'];

    const fmt = (n) => { const v = parseFloat(n) || 0; return '¥' + v.toLocaleString('zh-CN', { minimumFractionDigits: 2 }); };
    const rate = (received, target) => target > 0 ? ((received / target) * 100).toFixed(1) + '%' : '—';

    res.render('reports/finance', {
      title: '费用报表',
      filters: { date_from: dateFrom, date_to: dateTo, assignee: assigneeId, fee_type: feeType },
      caseStats, byStaff, feeSummary, byFeeType, byStaffFee, feeRows,
      staff, freqFeeTypes, FEE_TYPE_NAMES, canViewAll: viewAll,
      fmt, rate,
    });
  } catch (e) { next(e); }
});

module.exports = router;
