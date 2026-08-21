// telegram.js
//
// Thin wrapper over the Telegram Bot API. Deliberately the ONLY module
// in the app that knows the wire format, so notify.js can be tested
// end-to-end without a network by injecting a fake sender.
//
// Design notes:
//
//  * HTML parse_mode, not MarkdownV2. MarkdownV2 requires escaping
//    roughly eighteen characters (including '.', '-', '(' and '!'),
//    which appear constantly in rupee amounts, dates and table labels;
//    a single missed escape makes Telegram reject the whole message
//    with a 400. HTML needs exactly three escapes (& < >) and fails
//    safe.
//
//  * Messages are split at 4096 characters (Telegram's hard limit) on
//    line boundaries. A digest listing every overdue reminder for a
//    large family can genuinely exceed one message.
//
//  * Errors are classified rather than thrown raw, because the two the
//    user will actually hit — a bad token and a chat the bot was never
//    added to — are indistinguishable from "network down" unless you
//    read the response body. The Admin page shows these verbatim.

const MAX_MESSAGE_CHARS = 4096;
const API_BASE = 'https://api.telegram.org';

// Telegram's HTML mode only recognises a small tag set; everything else
// must be escaped or the API rejects the message.
function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Split on newlines so we never cut a line (or worse, an HTML tag) in
// half. A single line longer than the limit is hard-split as a last
// resort — that shouldn't happen with our formatting, but silently
// dropping content would be worse than an ugly break.
function splitMessage(text, limit) {
  const max = limit || MAX_MESSAGE_CHARS;
  const out = [];
  let current = '';
  String(text).split('\n').forEach(line => {
    while (line.length > max) {
      if (current) { out.push(current); current = ''; }
      out.push(line.slice(0, max));
      line = line.slice(max);
    }
    const candidate = current ? current + '\n' + line : line;
    if (candidate.length > max) {
      if (current) out.push(current);
      current = line;
    } else {
      current = candidate;
    }
  });
  if (current) out.push(current);
  return out.length ? out : [''];
}

function classifyError(status, body) {
  const desc = (body && body.description) || '';
  // Every genuine Telegram API response — including its errors — is JSON
  // carrying `ok` and usually `description`. A 4xx/5xx WITHOUT that shape
  // did not come from Telegram at all: it came from something in between
  // (an egress proxy, a corporate firewall, a captive portal, a DNS
  // hijack). Classifying such a response with Telegram's own semantics
  // is actively harmful — a proxy's blanket 403 would be reported as
  // "the bot was removed from that chat", sending the user to re-add a
  // bot when their real problem is outbound network access. Verified
  // against a real egress proxy that returns exactly this.
  const looksLikeTelegram = !!(body && typeof body === 'object' && ('ok' in body || 'description' in body));
  if (!looksLikeTelegram && status >= 400) {
    return {
      kind: 'network-blocked',
      message: `HTTP ${status} with no Telegram response body — something between this server and api.telegram.org is blocking the request (proxy, firewall, or DNS). Check outbound network access from the host.`,
    };
  }
  if (status === 401) return { kind: 'bad-token', message: 'Telegram rejected the bot token (401). Check the token in Admin \u2192 Notifications.' };
  if (status === 429) {
    const retry = body && body.parameters && body.parameters.retry_after;
    return { kind: 'rate-limited', message: `Telegram rate limit hit; retry after ${retry || '?'}s.`, retryAfter: retry };
  }
  if (status === 400 && /chat not found/i.test(desc)) {
    return { kind: 'bad-chat', message: 'Chat not found. Check the chat ID, and make sure the bot has been added to that chat (and, for groups, that it can post).' };
  }
  if (status === 403) {
    return { kind: 'blocked', message: 'The bot is blocked or was removed from that chat (403). Re-add the bot, then send a test message.' };
  }
  if (status === 400) return { kind: 'bad-request', message: `Telegram rejected the request (400): ${desc || 'no detail'}` };
  return { kind: 'http-error', message: `Telegram returned HTTP ${status}${desc ? ': ' + desc : ''}` };
}

// One API call. Returns { ok: true, result } or { ok: false, error }.
// Never throws — callers are schedulers and route handlers that must
// keep going and log rather than crash the process.
async function callApi(token, method, payload, deps) {
  const fetchFn = (deps && deps.fetch) || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, error: { kind: 'no-fetch', message: 'This Node runtime has no global fetch (needs Node 18+).' } };
  }
  const url = `${API_BASE}/bot${token}/${method}`;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok || !body || body.ok !== true) {
      return { ok: false, error: classifyError(res.status, body) };
    }
    return { ok: true, result: body.result };
  } catch (err) {
    // DNS failure, TLS failure, offline, egress proxy block — all land
    // here. Keep the raw message: on a locked-down host the proxy's
    // deny reason is the single most useful clue.
    return { ok: false, error: { kind: 'network', message: `Could not reach Telegram: ${err && err.message ? err.message : err}` } };
  }
}

// Sends one logical message, transparently splitting oversize text.
// Resolves { ok, parts } or { ok: false, error } on the FIRST failing
// part — a partially delivered digest is reported as failed so the
// dedup log doesn't record it as sent.
async function sendMessage(token, chatId, text, deps) {
  const parts = splitMessage(text);
  const sent = [];
  for (let i = 0; i < parts.length; i++) {
    const r = await callApi(token, 'sendMessage', {
      chat_id: chatId,
      text: parts[i],
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, deps);
    if (!r.ok) return { ok: false, error: r.error, partsSent: sent.length };
    sent.push(r.result);
    // Telegram's documented ceiling is ~20 messages/minute to one group.
    // A short gap between parts of a split message keeps a long digest
    // from tripping it; single-part messages never pay this cost.
    if (parts.length > 1 && i < parts.length - 1) await new Promise(r2 => setTimeout(r2, 1200));
  }
  return { ok: true, parts: sent.length };
}

// Used by the Admin page's "Check connection" — confirms the token is
// valid and tells the user which bot it belongs to, without needing a
// chat ID configured yet.
async function getMe(token, deps) {
  return callApi(token, 'getMe', {}, deps);
}

module.exports = { sendMessage, getMe, callApi, splitMessage, escapeHtml, classifyError, MAX_MESSAGE_CHARS };
