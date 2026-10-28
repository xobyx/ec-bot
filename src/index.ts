import type { Env, TelegramUpdate, PendingAction } from './types';
import { sendMessage, editMessageText, answerCallbackQuery, getFile, downloadTelegramFile } from './telegram';
import { analyzeSiteUpdate } from './ai';
import { savePendingAction, getPendingAction, deletePendingAction, uploadSitePhoto, applyUpdateToRoom } from './supabase';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. Health check endpoint
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(JSON.stringify({
        status: 'online',
        service: 'ECIT Site Tracker Telegram Bot Worker',
        time: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. Setup Webhook helper endpoint: visit /setup-webhook to register automatically
    if (request.method === 'GET' && url.pathname === '/setup-webhook') {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return new Response('TELEGRAM_BOT_TOKEN secret is not set', { status: 400 });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const tgRes = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
      );
      const tgData: any = await tgRes.json();
      return new Response(JSON.stringify(tgData, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Webhook handler: POST / or POST /webhook
    if (request.method === 'POST') {
      // Optional webhook secret validation
      if (env.WEBHOOK_SECRET) {
        const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (headerSecret !== env.WEBHOOK_SECRET) {
          return new Response('Unauthorized', { status: 403 });
        }
      }

      try {
        const update: TelegramUpdate = await request.json();
        ctx.waitUntil(handleTelegramUpdate(update, env));
        return new Response('OK', { status: 200 });
      } catch (err: any) {
        console.error('Error handling webhook update:', err);
        return new Response('Error', { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function handleTelegramUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Missing TELEGRAM_BOT_TOKEN');
    return;
  }

  // Handle Button Clicks (Confirm / Cancel)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  // Handle incoming messages
  if (update.message) {
    await handleMessage(update.message, env);
    return;
  }
}

async function handleMessage(message: any, env: Env): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = message.chat.id;
  const text = message.text || message.caption || '';

  // Command: /start
  if (text.startsWith('/start')) {
    const welcome =
      `🏗️ *Welcome to ECIT Site Tracker Bot!*\n\n` +
      `You can send me site updates, finish progress, or snag reports.\n\n` +
      `*How to use:*\n` +
      `• Send a message like: \`Level 2 Room 204 screed complete\`\n` +
      `• Or attach a *Photo* with a caption: \`L1 Room 105 - Ceiling grid done, crack on wall\`\n\n` +
      `I will analyze your update and ask for your *confirmation* before saving to the database.`;
    await sendMessage(token, chatId, welcome);
    return;
  }

  // Command: /help
  if (text.startsWith('/help')) {
    const help =
      `📖 *ECIT Bot Tips*\n\n` +
      `• *Room Format:* Mention Level and Space, e.g. \`L2 R204\`, \`Level 0 Pod Toilet\`, \`Space 312\`\n` +
      `• *Finish Progress:* e.g. \`screed done\`, \`plaster ongoing\`, \`tiles completed\`\n` +
      `• *Snags:* e.g. \`snag: painting scratch near window\`\n` +
      `• *Photos:* Attach a photo and include your notes in the caption.`;
    await sendMessage(token, chatId, help);
    return;
  }

  if (!text && (!message.photo || message.photo.length === 0)) {
    return;
  }

  // Send temporary processing message
  const statusMsg = await sendMessage(token, chatId, '⏳ *Analyzing site update...*', {
    reply_to_message_id: message.message_id
  });
  const statusMsgId = statusMsg?.result?.message_id;

  try {
    let photoBytes: Uint8Array | undefined = undefined;
    let photoFileId: string | undefined = undefined;

    if (message.photo && message.photo.length > 0) {
      // Telegram provides multiple photo sizes; pick largest
      const largestPhoto = message.photo[message.photo.length - 1];
      photoFileId = largestPhoto.file_id;

      if (photoFileId) {
        const fileInfo = await getFile(token, photoFileId);
        if (fileInfo.file_path) {
          photoBytes = await downloadTelegramFile(token, fileInfo.file_path);
        }
      }
    }

    // Run AI Multimodal analysis
    const parsed = await analyzeSiteUpdate(env, text, photoBytes);

    // Generate unique ID for this pending confirmation
    const actionId = Math.random().toString(36).substring(2, 10);
    const pendingAction: PendingAction = {
      id: actionId,
      chatId,
      telegramUserId: message.from?.id || 0,
      telegramUsername: message.from?.username || message.from?.first_name,
      parsed,
      photoFileId,
      createdAt: new Date().toISOString()
    };

    // Save action into Supabase KV table
    await savePendingAction(env, pendingAction);

    // Build human-friendly Confirmation Card
    const levelStr = typeof parsed.level === 'number' ? `Level ${parsed.level}` : 'Unspecified Level';
    const zoneStr = typeof parsed.zone === 'number' && parsed.zone > 0 ? `Zone ${parsed.zone}` : (parsed.zone === 0 ? 'All Zones' : '');
    const spaceName = parsed.space && parsed.space !== 'SITE' ? parsed.space : '';
    const roomNumber = (parsed.spaceNo && !spaceName.includes(parsed.spaceNo)) ? `Room ${parsed.spaceNo}` : '';

    // Build clear location string: e.g. "Level 1 | Zone 2 | GARBAGE ROOM"
    const locationParts = [levelStr, zoneStr, spaceName, roomNumber].filter(Boolean);
    const locationText = locationParts.join(' | ');

    const finishStr = parsed.finishCode
      ? `• *Finish:* \`${parsed.finishCode}\` ➔ *${(parsed.status || 'updated').toUpperCase()}*\n`
      : (parsed.status ? `• *Status:* *${parsed.status.toUpperCase()}*\n` : '');
    const snagStr = parsed.snag
      ? `• *Snag Detected:* "${parsed.snag.text}" (Trade: ${parsed.snag.trade})\n`
      : '';
    const photoStr = photoFileId ? `• *Photo:* Attached (1 photo)\n` : '';
    const notesStr = parsed.notes ? `• *Notes:* _${parsed.notes}_\n` : '';

    const confirmationText =
      `📋 *Proposed Room Update*\n\n` +
      `• *Location:* *${locationText}*\n` +
      finishStr +
      snagStr +
      photoStr +
      notesStr +
      `\n*Please confirm to apply to the database:*`;

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '✅ Confirm & Save', callback_data: `confirm:${actionId}` },
          { text: '❌ Cancel', callback_data: `cancel:${actionId}` }
        ]
      ]
    };

    if (statusMsgId) {
      await editMessageText(token, chatId, statusMsgId, confirmationText, {
        reply_markup: inlineKeyboard
      });
    } else {
      await sendMessage(token, chatId, confirmationText, {
        reply_markup: inlineKeyboard
      });
    }
  } catch (err: any) {
    console.error('Error analyzing update:', err);
    const errorText = `⚠️ *Could not analyze message:* ${err?.message || 'Unknown error'}\nPlease try again.`;
    if (statusMsgId) {
      await editMessageText(token, chatId, statusMsgId, errorText);
    } else {
      await sendMessage(token, chatId, errorText);
    }
  }
}

async function handleCallbackQuery(query: any, env: Env): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const data = query.data || '';
  const message = query.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;

  if (!data.includes(':')) {
    await answerCallbackQuery(token, query.id);
    return;
  }

  const [actionType, actionId] = data.split(':');

  if (actionType === 'cancel') {
    await answerCallbackQuery(token, query.id, 'Cancelled');
    await deletePendingAction(env, actionId).catch(() => {});
    if (chatId && messageId) {
      await editMessageText(token, chatId, messageId, '❌ *Update cancelled.* No changes were made to the database.');
    }
    return;
  }

  if (actionType === 'confirm') {
    await answerCallbackQuery(token, query.id, 'Applying changes to database...');

    try {
      const pending = await getPendingAction(env, actionId);
      if (!pending) {
        if (chatId && messageId) {
          await editMessageText(
            token,
            chatId,
            messageId,
            '⚠️ *Expired or Already Applied:*\nThis update could not be found. Please submit again.'
          );
        }
        return;
      }

      let photoUrl: string | undefined = undefined;

      // If a photo was attached, download and upload to Supabase Storage
      if (pending.photoFileId) {
        try {
          const fileInfo = await getFile(token, pending.photoFileId);
          if (fileInfo.file_path) {
            const photoBytes = await downloadTelegramFile(token, fileInfo.file_path);
            const ext = fileInfo.file_path.split('.').pop() || 'jpg';
            photoUrl = await uploadSitePhoto(env, photoBytes, `${actionId}.${ext}`);
          }
        } catch (uploadErr) {
          console.error('Failed to upload photo to storage:', uploadErr);
        }
      }

      // Apply changes to rooms table in Supabase
      const result = await applyUpdateToRoom(env, pending, photoUrl);

      // Clean up pending action
      await deletePendingAction(env, actionId).catch(() => {});

      // Notify success
      const successText =
        `✅ *Success! Database Updated*\n\n` +
        `• *Room:* *${result.roomTitle}*\n` +
        `• *Summary:* ${pending.parsed.summary}\n` +
        (photoUrl ? `• *Photo:* Saved to project storage\n` : '') +
        `\n_The update has been saved to Supabase and synced live to ECIT Tracker._`;

      if (chatId && messageId) {
        await editMessageText(token, chatId, messageId, successText);
      }
    } catch (err: any) {
      console.error('Failed to apply update:', err);
      if (chatId && messageId) {
        await editMessageText(
          token,
          chatId,
          messageId,
          `⚠️ *Failed to update database:* ${err?.message || 'Database error'}`
        );
      }
    }
  }
}
