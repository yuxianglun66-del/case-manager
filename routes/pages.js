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

/* ---------- 看板 ---------- */
router.get('/dashboard', async (req, res, next) => {
  try {
    const sc = scopeClause(req.session.user);

    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM cases c WHERE 1=1${sc.where}`, sc.params);
    const byType = await pool.query(
      `SELECT t.id, t.name, t.color, COUNT(c.id)::int AS n
       FROM case_types t
       LEFT JOIN cases c ON c.case_type_id = t.id
       WHERE t.active = TRUE${sc.where.replace(/c\.assignee_id/g, 'c.assignee_id')}
       GROUP BY t.id ORDER BY t.sort`,
      sc.params
    );
    const byStatus = await pool.query(
      `SELECT s.id, s.name, s.color, s.category, COUNT(c.id)::int AS n
       FROM statuses s
       LEFT JOIN cases c ON c.status_id = s.id
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
       WHERE 1=1${sc.where}
       ORDER BY c.updated_at DESC LIMIT 8`,
      sc.params
    );

    const workload = canViewAll(req.session.user)
      ? (await pool.query(
          `SELECT u.id, u.display_name, COUNT(c.id)::int AS n
           FROM users u LEFT JOIN cases c ON c.assignee_id = u.id
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

    const where = [];
    const params = [];
    if (kw) { params.push(`%${kw}%`); where.push(`(c.case_no ILIKE $${params.length} OR c.title ILIKE $${params.length} OR c.client_name ILIKE $${params.length})`); }
    if (typeId) { params.push(typeId); where.push(`c.case_type_id = $${params.length}`); }
    if (statusId) { params.push(statusId); where.push(`c.status_id = $${params.length}`); }
    if (assigneeId && canViewAll(user)) { params.push(assigneeId); where.push(`c.assignee_id = $${params.length}`); }
    if (!canViewAll(user)) { params.push(user.id); where.push(`c.assignee_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM cases c ${whereSql}`, params);
    const totalPages = Math.max(Math.ceil(count.rows[0].n / per), 1);
    const cur = Math.min(page, totalPages);
    const offset = (cur - 1) * per;

    params.push(per, offset);
    const { rows: cases } = await pool.query(
      `SELECT c.id, c.case_no, c.title, c.client_name, c.updated_at, c.next_action, c.reminder_at, c.fee_agreement, c.fee_details,
              t.name AS type_name, t.color AS type_color, t.code AS type_code,
              s.name AS status_name, s.color AS status_color,
              u.display_name AS assignee_name,
              (SELECT COUNT(*)::int FROM attachments a WHERE a.case_id = c.id) AS file_count
       FROM cases c
       LEFT JOIN case_types t ON t.id = c.case_type_id
       LEFT JOIN statuses s ON s.id = c.status_id
       LEFT JOIN users u ON u.id = c.assignee_id
       ${whereSql}
       ORDER BY c.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const types = (await pool.query(`SELECT id, name FROM case_types WHERE active = TRUE ORDER BY sort`)).rows;
    const statuses = (await pool.query(`SELECT id, name FROM statuses WHERE active = TRUE ORDER BY sort`)).rows;
    const staff = canViewAll(user)
      ? (await pool.query(`SELECT id, display_name FROM users WHERE active = TRUE AND role='staff' ORDER BY display_name`)).rows
      : [];

    res.render('cases/list', {
      title: '案件管理',
      cases, types, statuses, staff,
      filters: { kw, type: typeId, status: statusId, assignee: assigneeId },
      page: cur, totalPages, total: count.rows[0].n,
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
    const c = (await pool.query(`SELECT * FROM cases WHERE id = $1`, [id])).rows[0];
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

    res.render('cases/form', {
      title: '编辑案件',
      mode: 'edit',
      caseData: c,
      caseTypeId: c.case_type_id,
      types, staff, statuses,
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
              t.name AS type_name, t.color AS type_color, t.code AS type_code,
              s.name AS status_name, s.color AS status_color,
              cu.display_name AS creator_name
       FROM cases c
       LEFT JOIN users u ON u.id = c.assignee_id
       LEFT JOIN case_types t ON t.id = c.case_type_id
       LEFT JOIN statuses s ON s.id = c.status_id
       LEFT JOIN users cu ON cu.id = c.created_by
       WHERE c.id = $1`, [id]
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
              (SELECT json_agg(json_build_object('id', cs.id, 'party_name', cs.party_name, 'party_role', cs.party_role, 'status', cs.status, 'signed_at', cs.signed_at))
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
      `SELECT u.*, (SELECT COUNT(*)::int FROM cases c WHERE c.assignee_id = u.id) AS case_count
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

module.exports = router;
