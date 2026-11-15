import type { TelegramInlineKeyboardMarkup } from './types';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

export async function sendMessage(
  botToken: string,
  chatId: number | string,
  text: string,
  options: {
    parse_mode?: 'Markdown' | 'HTML';
    reply_markup?: TelegramInlineKeyboardMarkup;
    reply_to_message_id?: number;
    disable_web_page_preview?: boolean;
  } = {}
): Promise<any> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: options.parse_mode ?? 'Markdown',
      reply_markup: options.reply_markup,
      reply_to_message_id: options.reply_to_message_id,
      disable_web_page_preview: options.disable_web_page_preview ?? true
    })
  });
  const data: any = await res.json();
  if (!data.ok && options.parse_mode !== undefined) {
    const fallbackRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.replace(/[*_`]/g, ''),
        reply_markup: options.reply_markup,
        reply_to_message_id: options.reply_to_message_id,
        disable_web_page_preview: options.disable_web_page_preview ?? true
      })
    });
    return await fallbackRes.json();
  }
  return data;
}

export async function editMessageText(
  botToken: string,
  chatId: number | string,
  messageId: number,
  text: string,
  options: {
    parse_mode?: 'Markdown' | 'HTML';
    reply_markup?: TelegramInlineKeyboardMarkup;
    disable_web_page_preview?: boolean;
  } = {}
): Promise<any> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/editMessageText`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: options.parse_mode ?? 'Markdown',
      reply_markup: options.reply_markup,
      disable_web_page_preview: options.disable_web_page_preview ?? true
    })
  });
  const data: any = await res.json();
  if (!data.ok && data.description?.includes("can't parse entities")) {
    const fallbackRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text.replace(/[*_`]/g, ''),
        reply_markup: options.reply_markup,
        disable_web_page_preview: options.disable_web_page_preview ?? true
      })
    });
    return await fallbackRes.json();
  }
  return data;
}

export async function sendPhoto(
  botToken: string,
  chatId: number | string,
  photo: string,
  caption?: string,
  options: {
    parse_mode?: 'Markdown' | 'HTML';
    reply_markup?: TelegramInlineKeyboardMarkup;
  } = {}
): Promise<any> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendPhoto`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      photo,
      caption,
      parse_mode: options.parse_mode ?? 'Markdown',
      reply_markup: options.reply_markup
    })
  });
  const data: any = await res.json();
  if (!data.ok && caption) {
    const fallbackRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo,
        caption: caption.replace(/[*_`]/g, ''),
        reply_markup: options.reply_markup
      })
    });
    return await fallbackRes.json();
  }
  return data;
}

export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string,
  showAlert = false
) {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert
    })
  });
}

export async function sendWidget(
  botToken: string,
  chatId: number | string,
  html: string,
  options: {
    caption?: string;
    parse_mode?: 'Markdown' | 'HTML';
    public_data?: string;
    chat_data?: string;
    allow_queries?: boolean;
    is_shared?: boolean;
    width?: number;
    height?: number;
    show_caption_above_media?: boolean;
    reply_markup?: TelegramInlineKeyboardMarkup;
  } = {}
): Promise<any> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendWidget`;
  const payload: Record<string, any> = {
    chat_id: chatId,
    html,
    allow_queries: options.allow_queries ?? true
  };
  if (options.caption) {
    payload.caption = options.caption;
    payload.parse_mode = options.parse_mode ?? 'Markdown';
  }
  if (options.public_data !== undefined) payload.public_data = options.public_data;
  if (options.chat_data !== undefined) payload.chat_data = options.chat_data;
  if (options.is_shared !== undefined) payload.is_shared = options.is_shared;
  if (options.width !== undefined) payload.width = options.width;
  if (options.height !== undefined) payload.height = options.height;
  if (options.show_caption_above_media !== undefined) {
    payload.show_caption_above_media = options.show_caption_above_media;
  }
  if (options.reply_markup) payload.reply_markup = options.reply_markup;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data: any = await res.json();
  if (!data.ok && payload.caption && payload.parse_mode) {
    delete payload.parse_mode;
    payload.caption = String(payload.caption).replace(/[*_`]/g, '');
    const retryRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await retryRes.json();
  }
  return data;
}

export async function editMessageWidgetData(
  botToken: string,
  params: {
    chat_id?: number | string;
    message_id?: number;
    inline_message_id?: string;
    public_data?: string;
    chat_data?: string;
  }
): Promise<any> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/editMessageWidgetData`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return await res.json();
}

export async function answerWidgetQuery(
  botToken: string,
  widgetQueryId: string,
  data?: string
): Promise<any> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/answerWidgetQuery`;
  const body: Record<string, any> = {
    widget_query_id: widgetQueryId
  };
  if (data !== undefined) {
    body.data = data.slice(0, 1024);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await res.json();
}

export async function deleteMessage(
  botToken: string,
  chatId: number | string,
  messageId: number
): Promise<boolean> {
  try {
    const url = `${TELEGRAM_API_BASE}/bot${botToken}/deleteMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId
      })
    });
    const data: any = await res.json();
    return !!data?.ok;
  } catch {
    return false;
  }
}

export async function setMyCommands(botToken: string): Promise<any> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/setMyCommands`;
  const commands = [
    { command: 'browse', description: '🧭 Browse levels, zones & rooms interactively' },
    { command: 'status', description: '📊 Live project progress & KPI widget' },
    { command: 'widget', description: '🧩 Open interactive HTML widget (KPIs or /widget F1-021)' },
    { command: 'snags', description: '⚠️ View & resolve open snags across site' },
    { command: 'room', description: '🚪 Inspect a room by code (e.g. /room F1-021)' },
    { command: 'photos', description: '🖼️ View stored photos for a room' },
    { command: 'notify', description: '🔔 Toggle live site change notifications ON/OFF' },
    { command: 'auth', description: '🔐 Authenticate with Link Code or Invite Code' },
    { command: 'login', description: '🔑 Sign in with Web App email & password' },
    { command: 'whoami', description: '👤 View linked account & role' },
    { command: 'users', description: '🛡️ Manage authorized Telegram users (Admin)' },
    { command: 'help', description: '📖 Bot usage guide & examples' }
  ];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands })
  });
  return await res.json();
}

export async function setChatMenuButton(
  botToken: string,
  webAppUrl: string,
  text = '🏗️ Site Tracker',
  chatId?: number | string
): Promise<any> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/setChatMenuButton`;
  const body: Record<string, any> = {
    menu_button: {
      type: 'web_app',
      text,
      web_app: { url: webAppUrl }
    }
  };
  if (chatId !== undefined) {
    body.chat_id = chatId;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await res.json();
}

export async function verifyTelegramWebAppInitData(
  botToken: string,
  initDataRaw: string
): Promise<{
  ok: boolean;
  user?: {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
  startParam?: string;
}> {
  try {
    if (!initDataRaw || !botToken) return { ok: false };
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');
    if (!hash) return { ok: false };

    const pairs: string[] = [];
    params.forEach((val, key) => {
      if (key !== 'hash') {
        pairs.push(`${key}=${val}`);
      }
    });
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const enc = new TextEncoder();
    const webAppKey = await crypto.subtle.importKey(
      'raw',
      enc.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const secretBytes = await crypto.subtle.sign('HMAC', webAppKey, enc.encode(botToken));
    const secretKey = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign('HMAC', secretKey, enc.encode(dataCheckString))
    );
    const computedHex = Array.from(sigBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (computedHex.toLowerCase() !== hash.toLowerCase()) {
      return { ok: false };
    }

    const userStr = params.get('user');
    const user = userStr ? JSON.parse(userStr) : undefined;
    if (!user || !user.id) return { ok: false };

    return {
      ok: true,
      user,
      startParam: params.get('start_param') || undefined
    };
  } catch {
    return { ok: false };
  }
}

export async function getFile(botToken: string, fileId: string): Promise<{ file_path?: string }> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const res = await fetch(url);
  const data: any = await res.json();
  if (!data.ok || !data.result) {
    throw new Error(`Failed to get file from Telegram: ${JSON.stringify(data)}`);
  }
  return data.result;
}

export async function downloadTelegramFile(botToken: string, filePath: string): Promise<Uint8Array> {
  const url = `${TELEGRAM_API_BASE}/file/bot${botToken}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download file from Telegram: ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
