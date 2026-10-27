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
      reply_to_message_id: options.reply_to_message_id
    })
  });
  return await res.json();
}

export async function editMessageText(
  botToken: string,
  chatId: number | string,
  messageId: number,
  text: string,
  options: {
    parse_mode?: 'Markdown' | 'HTML';
    reply_markup?: TelegramInlineKeyboardMarkup;
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
      reply_markup: options.reply_markup
    })
  });
  return await res.json();
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
