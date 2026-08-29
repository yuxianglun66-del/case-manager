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

module.exports = { getSettings, getAccessToken, sendText, sendWebhook, pushEvent, isEventEnabled };
