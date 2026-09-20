const { pool } = require('./db');

let cachedToken = null;
let tokenExpiresAt = 0;

async function getSettings() {
  const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key LIKE 'wecom_%'`);
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

async function sendWebhook(webhookUrl, content) {
  if (!webhookUrl) return { ok: false, error: '未配置 Webhook 地址' };
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content } }),
  });
  const data = await resp.json();
  if (data.errcode !== 0) {
    console.error('[WeCom] webhook error:', data);
    return { ok: false, error: data.errmsg || '发送失败' };
  }
  return { ok: true };
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;
  const s = await getSettings();
  if (!s.wecom_corpid || !s.wecom_secret) return null;
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(s.wecom_corpid)}&corpsecret=${encodeURIComponent(s.wecom_secret)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.errcode) {
    console.error('[WeCom] gettoken error:', data);
    return null;
  }
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in - 300) * 1000;
  return cachedToken;
}

async function sendText(wecomUserid, content) {
  const token = await getAccessToken();
  if (!token) return { ok: false, error: '未配置企业微信或 token 获取失败' };
  const s = await getSettings();
  if (!s.wecom_agentid) return { ok: false, error: '未配置 AgentID' };
  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: wecomUserid,
      msgtype: 'text',
      agentid: parseInt(s.wecom_agentid, 10),
      text: { content },
    }),
  });
  const data = await resp.json();
  if (data.errcode !== 0) {
    console.error('[WeCom] send error:', data);
    return { ok: false, error: data.errmsg || '发送失败' };
  }
  return { ok: true };
}

function isEventEnabled(events, eventKey) {
  try {
    const ev = typeof events === 'string' ? JSON.parse(events || '{}') : (events || {});
    return ev[eventKey] === '1' || ev[eventKey] === true;
  } catch { return false; }
}

const EVENT_TITLES = {
  case_assigned: '案件分配',
  status_changed: '状态变更',
  reminder_due: '流程提醒',
  new_attachment: '新附件',
  contract_signed: '合同签署',
  fee_changed: '费用变更',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function addInAppNotification(userId, eventKey, title, content, link) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, event_key, title, content, link) VALUES ($1,$2,$3,$4,$5)`,
      [userId, eventKey, title, content || '', link || null]
    );
  } catch (e) {
    console.error('[WeCom] addInAppNotification error:', e.message);
  }
}

async function logNotify(channel, userId, eventKey, content, status, error, retries) {
  try {
    await pool.query(
      `INSERT INTO notify_logs (channel, target_user_id, event_key, content, status, error, retries) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [channel, userId || null, eventKey || null, content || '', status, error || null, retries || 0]
    );
  } catch (e) {
    console.error('[WeCom] logNotify error:', e.message);
  }
}

// 带重试的投递（最多 3 次，退避 600ms/1200ms）
async function notifyWithRetry(fn) {
  let lastErr = 'unknown';
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fn();
      if (r && r.ok) return { ok: true, retries: i, error: null };
      lastErr = (r && r.error) || 'unknown';
    } catch (e) {
      lastErr = e.message;
    }
    if (i < 2) await sleep(600 * (i + 1));
  }
  return { ok: false, retries: 2, error: lastErr };
}

async function pushEvent(eventKey, userId, content, opts = {}) {
  if (!userId) return;
  const title = opts.title || EVENT_TITLES[eventKey] || '系统通知';
  const link = opts.link || null;

  // 站内通知（红点）始终落库
  await addInAppNotification(userId, eventKey, title, content, link);
  await logNotify('inapp', userId, eventKey, content, 'success', null, 0);

  try {
    const s = await getSettings();
    if (s.wecom_enabled !== '1') return;
    if (!isEventEnabled(s.wecom_push_events, eventKey)) return;

    let deliver;
    if (s.wecom_webhook) {
      deliver = await notifyWithRetry(() => sendWebhook(s.wecom_webhook, content));
    } else if (s.wecom_corpid && s.wecom_secret) {
      const q = await pool.query(`SELECT wecom_userid FROM users WHERE id = $1`, [userId]);
      const wid = q.rows[0]?.wecom_userid?.trim();
      if (!wid) {
        await logNotify('wecom', userId, eventKey, content, 'fail', '用户未配置企业微信 UserID', 0);
        return;
      }
      deliver = await notifyWithRetry(() => sendText(wid, content));
    } else {
      await logNotify('wecom', userId, eventKey, content, 'fail', '未配置 Webhook 或企业微信应用', 0);
      return;
    }

    await logNotify('wecom', userId, eventKey, content, deliver.ok ? 'success' : 'fail', deliver.error, deliver.retries);
    if (!deliver.ok) console.error('[WeCom] pushEvent final fail:', deliver.error);
  } catch (e) {
    console.error('[WeCom] pushEvent error:', e.message);
    await logNotify('wecom', userId, eventKey, content, 'fail', e.message, 0).catch(() => {});
  }
}

// ====== 定时提醒推送调度器（每 5 分钟扫描到期提醒） ======
let reminderTimer = null;

async function tickReminders() {
  try {
    const { rows: cases } = await pool.query(
      `SELECT c.id, c.case_no, c.title, c.client_name, c.next_action, c.reminder_at,
              c.assignee_id, u.username AS assignee_name
       FROM cases c
       LEFT JOIN users u ON u.id = c.assignee_id
       WHERE c.reminder_at IS NOT NULL
         AND c.next_action IS NOT NULL AND c.next_action <> ''
         AND c.reminder_ack_at IS NULL
         AND c.reminder_notified_at IS NULL
         AND c.deleted_at IS NULL
         AND c.reminder_at <= now()`
    );
    if (cases.length === 0) return;

    const s = await getSettings();
    if (s.wecom_enabled !== '1') return;
    if (!isEventEnabled(s.wecom_push_events, 'reminder_notify')) return;

    for (const c of cases) {
      const dateStr = c.reminder_at ? fmtDateTime(c.reminder_at) : '';
      const content = '⏰ 案件 ' + c.case_no + '「' + c.title + '」进度提醒已到期\n'
        + (c.client_name ? '👤 当事人：' + c.client_name + '\n' : '')
        + '📝 下一步：' + c.next_action + '\n'
        + '⏰ 提醒时间：' + dateStr + '\n'
        + (c.assignee_name ? '👤 负责人：' + c.assignee_name : '');

      let delivered = false;
      try {
        if (s.wecom_webhook) {
          const r = await notifyWithRetry(() => sendWebhook(s.wecom_webhook, content));
          delivered = r.ok;
          await logNotify('wecom', c.assignee_id, 'reminder_notify', content, r.ok ? 'success' : 'fail', r.error, r.retries);
        } else if (s.wecom_corpid && s.wecom_secret && c.assignee_id) {
          const q = await pool.query(`SELECT wecom_userid FROM users WHERE id = $1`, [c.assignee_id]);
          const wid = q.rows[0]?.wecom_userid?.trim();
          if (wid) {
            const r = await notifyWithRetry(() => sendText(wid, content));
            delivered = r.ok;
            await logNotify('wecom', c.assignee_id, 'reminder_notify', content, r.ok ? 'success' : 'fail', r.error, r.retries);
          }
        }
      } catch (e) {
        console.error('[WeCom] reminder push error:', e.message);
      }

      // 无论推送是否成功都标记已通知，避免反复推送
      await pool.query(`UPDATE cases SET reminder_notified_at = now() WHERE id = $1`, [c.id]);
      if (delivered) console.log('[WeCom] 提醒推送成功: ' + c.case_no);
    }
  } catch (e) {
    console.error('[WeCom] tickReminders error:', e.message);
  }
}

function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.getFullYear() + '年' + (dt.getMonth() + 1) + '月' + dt.getDate() + '日 '
    + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
}

function startReminderScheduler() {
  if (reminderTimer) return reminderTimer;
  const tick = () => tickReminders();
  tick(); // 启动后立即跑一次
  reminderTimer = setInterval(tick, 5 * 60 * 1000); // 每 5 分钟
  if (typeof reminderTimer.unref === 'function') reminderTimer.unref();
  console.log('[WeCom] 提醒推送调度器已启动（每 5 分钟）');
  return reminderTimer;
}

module.exports = { getSettings, getAccessToken, sendText, sendWebhook, pushEvent, isEventEnabled, startReminderScheduler };
