const { pool } = require('./db');

let cachedToken = null;
let tokenExpiresAt = 0;

async function getSettings() {
  const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key LIKE 'wecom_%'`);
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
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

async function getWecomUserid(userId) {
  if (!userId) return null;
  const { rows } = await pool.query(`SELECT wecom_userid FROM users WHERE id = $1`, [userId]);
  return rows[0] && rows[0].wecom_userid ? rows[0].wecom_userid.trim() : null;
}

async function pushNotify(userId, content) {
  try {
    const s = await getSettings();
    if (s.wecom_enabled !== '1') return;
    const wid = await getWecomUserid(userId);
    if (!wid) return;
    const result = await sendText(wid, content);
    if (!result.ok) console.warn('[WeCom] push failed:', result.error);
  } catch (e) {
    console.error('[WeCom] pushNotify error:', e.message);
  }
}

async function pushEvent(eventKey, userId, content) {
  try {
    const s = await getSettings();
    if (s.wecom_enabled !== '1') return;
    if (!isEventEnabled(s.wecom_push_events, eventKey)) return;
    await pushNotify(userId, content);
  } catch (e) {
    console.error('[WeCom] pushEvent error:', e.message);
  }
}

module.exports = { getSettings, getAccessToken, sendText, pushNotify, pushEvent, isEventEnabled, getWecomUserid };
