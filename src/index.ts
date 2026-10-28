import type {
  Env,
  TelegramUpdate,
  PendingAction,
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
  Room,
  Status
} from './types';
import {
  sendMessage,
  editMessageText,
  sendPhoto,
  answerCallbackQuery,
  getFile,
  downloadTelegramFile
} from './telegram';
import { analyzeSiteUpdate } from './ai';
import {
  savePendingAction,
  getPendingAction,
  deletePendingAction,
  uploadSitePhoto,
  deleteSitePhoto,
  getPhotoPublicUrl,
  getRoomByIdOrCode,
  getRoomsForLevelZone,
  resolveRoomCandidates,
  resolveFinishCodeForRoom,
  applyUpdateToRoom
} from './supabase';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. Health check endpoint
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(
        JSON.stringify({
          status: 'online',
          service: 'ECIT Site Tracker Telegram Bot Worker',
          time: new Date().toISOString()
        }),
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );
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

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  if (update.message) {
    await handleMessage(update.message, env);
    return;
  }
}

async function handleMessage(message: any, env: Env): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = message.chat.id;
  const text = (message.text || message.caption || '').trim();

  // Command: /start
  if (text.startsWith('/start')) {
    const welcome =
      `🏗️ *Welcome to ECIT Site Tracker Bot!*\n\n` +
      `Send site progress updates, photos, or snag reports:\n` +
      `• \`F1-021 screed done\`\n` +
      `• \`Level 1 Zone 2 Garbage Room plaster ongoing\`\n` +
      `• Or send a *Photo* with a caption (even without level/zone — I will show buttons to pick them!)\n\n` +
      `*Commands:*\n` +
      `• \`/room <code or level>\` — Inspect room status & stored photos\n` +
      `• \`/photos <room code>\` — View saved site photos from storage\n` +
      `• \`/help\` — Show usage guide`;
    await sendMessage(token, chatId, welcome);
    return;
  }

  // Command: /help
  if (text.startsWith('/help')) {
    const help =
      `📖 *ECIT Bot Guide*\n\n` +
      `1️⃣ *Quick Update:* Send text or photo like \`GF-008 tiles done\` or \`screed done\`. If Level, Zone, or Room is missing, interactive buttons will appear automatically.\n` +
      `2️⃣ *Interactive Controls:* Tap Finish codes (\`F02\`, \`W04\`, etc.) and Status buttons (\`Pending\`, \`Ongoing\`, \`Done\`) right on the confirmation card.\n` +
      `3️⃣ *Storage Integration:* Photos are saved directly to Supabase Storage (\`photos\` bucket + \`photo_meta\`) so they open immediately in the ECIT Web App.\n` +
      `4️⃣ *Inspect Stored Photos:* Use \`/photos F1-021\` or tap *🖼️ Room Photos* on any room card to fetch stored photos back into Telegram.`;
    await sendMessage(token, chatId, help);
    return;
  }

  // Command: /room or /photos
  if (text.startsWith('/room') || text.startsWith('/photos')) {
    const arg = text.replace(/^\/(room|photos)\s*/i, '').trim();
    if (!arg) {
      await sendMessage(
        token,
        chatId,
        `🔎 Usage: \`/room F1-021\` or \`/photos GF-008\` (or send any update to use the interactive level/zone picker).`
      );
      return;
    }
    const room = await getRoomByIdOrCode(env, arg);
    if (!room) {
      await sendMessage(token, chatId, `⚠️ Room \`${arg}\` not found. Try a schedule code like \`GF-008\` or \`F1-021\`.`);
      return;
    }
    await sendRoomInspectionAndPhotos(env, chatId, room, text.startsWith('/photos'));
    return;
  }

  if (!text && (!message.photo || message.photo.length === 0)) {
    return;
  }

  const statusMsg = await sendMessage(token, chatId, '⏳ *Analyzing site update...*', {
    reply_to_message_id: message.message_id
  });
  const statusMsgId = statusMsg?.result?.message_id;

  try {
    let photoBytes: Uint8Array | undefined = undefined;
    let photoFileId: string | undefined = undefined;
    let uploadedPhotoId: string | undefined = undefined;

    if (message.photo && message.photo.length > 0) {
      const largestPhoto = message.photo[message.photo.length - 1];
      photoFileId = largestPhoto.file_id;

      if (photoFileId) {
        const fileInfo = await getFile(token, photoFileId);
        if (fileInfo.file_path) {
          photoBytes = await downloadTelegramFile(token, fileInfo.file_path);
          // Upload immediately to Supabase Storage as `${photoId}.jpg` for instant web app compatibility
          try {
            const uploaded = await uploadSitePhoto(env, photoBytes);
            uploadedPhotoId = uploaded.photoId;
          } catch (upErr) {
            console.error('Initial photo storage upload warning:', upErr);
          }
        }
      }
    }

    const parsed = await analyzeSiteUpdate(env, text, photoBytes);

    const actionId = Math.random().toString(36).substring(2, 10);
    const pendingAction: PendingAction = {
      id: actionId,
      chatId,
      telegramUserId: message.from?.id || 0,
      telegramUsername: message.from?.username || message.from?.first_name,
      parsed,
      uiMode: 'auto',
      roomPage: 0,
      photoFileId,
      uploadedPhotoId,
      createdAt: new Date().toISOString()
    };

    const card = await buildInteractivePrompt(env, pendingAction);
    await savePendingAction(env, pendingAction);

    if (statusMsgId) {
      await editMessageText(token, chatId, statusMsgId, card.text, {
        reply_markup: card.keyboard
      });
    } else {
      await sendMessage(token, chatId, card.text, {
        reply_markup: card.keyboard
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

/**
 * Builds the interactive message text and inline keyboard depending on what information
 * is already detected vs missing (Level -> Zone -> Room -> Finish/Status -> Confirm).
 */
async function buildInteractivePrompt(
  env: Env,
  action: PendingAction
): Promise<{ text: string; keyboard: TelegramInlineKeyboardMarkup }> {
  const { parsed } = action;
  const resolved = await resolveRoomCandidates(env, action);

  if (resolved.exact && !action.selectedRoomId) {
    action.selectedRoomId = resolved.exact.id;
  }

  const levelStr =
    typeof parsed.level === 'number'
      ? parsed.level === 0
        ? 'Ground Floor (GF)'
        : `Level ${parsed.level}`
      : '❓ Not selected';
  const zoneStr =
    typeof parsed.zone === 'number'
      ? parsed.zone === 0
        ? 'All Zones'
        : `Zone ${parsed.zone}`
      : '❓ Not selected';

  const photoLine = action.uploadedPhotoId || action.photoFileId
    ? `• *Photo:* 📸 Attached ${action.uploadedPhotoId ? `(\`${action.uploadedPhotoId}.jpg\`)` : ''}\n`
    : '';
  const snagLine = parsed.snag
    ? `• *Snag:* ⚠️ "${parsed.snag.text}" (${parsed.snag.trade})\n`
    : '';
  const notesLine = parsed.notes ? `• *Note:* _${parsed.notes}_\n` : '';

  // 1. Determine active step if in 'auto' mode
  let mode = action.uiMode || 'auto';
  if (mode === 'auto') {
    if (typeof parsed.level !== 'number' && !resolved.exact) {
      mode = 'pick_level';
    } else if (typeof parsed.zone !== 'number' && !resolved.exact) {
      mode = 'pick_zone';
    } else if (!resolved.exact) {
      mode = 'pick_room';
    } else {
      mode = 'confirm';
    }
  }

  // ================= STEP 1: PICK LEVEL =================
  if (mode === 'pick_level') {
    const text =
      `🏢 *Select Level (Floor)*\n\n` +
      `• *Detected Space:* ${parsed.spaceCode || parsed.space || 'Unspecified'}\n` +
      (parsed.finishCode ? `• *Finish:* \`${parsed.finishCode}\` ${parsed.status ? `➔ *${parsed.status.toUpperCase()}*` : ''}\n` : '') +
      snagLine +
      photoLine +
      notesLine +
      `\n👇 *Level was not detected. Tap the floor level:*`;

    const row1: TelegramInlineKeyboardButton[] = [0, 1, 2, 3, 4].map(lvl => ({
      text: lvl === 0 ? 'GF (0)' : `L${lvl}`,
      callback_data: `slvl:${action.id}:${lvl}`
    }));
    const row2: TelegramInlineKeyboardButton[] = [5, 6, 7, 8].map(lvl => ({
      text: `L${lvl}`,
      callback_data: `slvl:${action.id}:${lvl}`
    }));

    return {
      text,
      keyboard: {
        inline_keyboard: [
          row1,
          row2,
          [{ text: '❌ Cancel', callback_data: `cancel:${action.id}` }]
        ]
      }
    };
  }

  // ================= STEP 2: PICK ZONE =================
  if (mode === 'pick_zone') {
    const text =
      `🗺️ *Select Zone on ${levelStr}*\n\n` +
      `• *Level:* *${levelStr}*\n` +
      `• *Detected Space:* ${parsed.spaceCode || parsed.space || 'Unspecified'}\n` +
      (parsed.finishCode ? `• *Finish:* \`${parsed.finishCode}\` ${parsed.status ? `➔ *${parsed.status.toUpperCase()}*` : ''}\n` : '') +
      snagLine +
      photoLine +
      notesLine +
      `\n👇 *Zone was not detected. Tap the zone:*`;

    const zRow: TelegramInlineKeyboardButton[] = [1, 2, 3, 4].map(z => ({
      text: `Zone ${z}`,
      callback_data: `szone:${action.id}:${z}`
    }));

    return {
      text,
      keyboard: {
        inline_keyboard: [
          zRow,
          [
            { text: '🌐 All Zones', callback_data: `szone:${action.id}:0` },
            { text: '🏢 Change Level', callback_data: `mode:${action.id}:pick_level` }
          ],
          [{ text: '❌ Cancel', callback_data: `cancel:${action.id}` }]
        ]
      }
    };
  }

  // ================= STEP 3: PICK ROOM =================
  if (mode === 'pick_room' || !resolved.exact) {
    const lvl = typeof parsed.level === 'number' ? parsed.level : 0;
    const candidates =
      resolved.candidates.length > 0
        ? resolved.candidates
        : await getRoomsForLevelZone(env, lvl, parsed.zone);

    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(candidates.length / pageSize));
    const page = Math.min(Math.max(0, action.roomPage || 0), totalPages - 1);
    const pageItems = candidates.slice(page * pageSize, (page + 1) * pageSize);

    const text =
      `🚪 *Select Room (${levelStr} · ${zoneStr})*\n\n` +
      (parsed.space ? `• *Searched Space:* \`${parsed.space}\`\n` : '') +
      (parsed.finishCode ? `• *Finish:* \`${parsed.finishCode}\` ${parsed.status ? `➔ *${parsed.status.toUpperCase()}*` : ''}\n` : '') +
      snagLine +
      photoLine +
      `\n👇 *Choose the room from Supabase (${candidates.length} found, page ${page + 1}/${totalPages}):*`;

    const rows: TelegramInlineKeyboardButton[][] = pageItems.map(rm => {
      const code = rm.spaceCode || rm.spaceNo || '';
      const zTag = rm.zone ? `Z${rm.zone}` : 'All';
      const label = `${code ? code + ' · ' : ''}${rm.space} (${zTag})`;
      return [
        {
          text: label.slice(0, 48),
          callback_data: `sroom:${action.id}:${rm.id}`
        }
      ];
    });

    if (totalPages > 1) {
      const navRow: TelegramInlineKeyboardButton[] = [];
      if (page > 0) {
        navRow.push({ text: '⬅️ Prev', callback_data: `rpage:${action.id}:${page - 1}` });
      }
      if (page < totalPages - 1) {
        navRow.push({ text: 'Next ➡️', callback_data: `rpage:${action.id}:${page + 1}` });
      }
      if (navRow.length) rows.push(navRow);
    }

    rows.push([
      { text: '🏢 Level', callback_data: `mode:${action.id}:pick_level` },
      { text: '🗺️ Zone', callback_data: `mode:${action.id}:pick_zone` },
      { text: '❌ Cancel', callback_data: `cancel:${action.id}` }
    ]);

    return {
      text,
      keyboard: { inline_keyboard: rows }
    };
  }

  // ================= STEP 4: CONFIRMATION & FINISH/STATUS CONTROLS =================
  const room = resolved.exact;
  const alignedFinish = resolveFinishCodeForRoom(room, parsed.finishCode, parsed.finishKind);
  if (alignedFinish) {
    parsed.finishCode = alignedFinish;
  }

  const roomCode = room.spaceCode || room.spaceNo || '';
  const roomLabel = `${room.level === 0 ? 'GF' : 'L' + room.level} ${room.zone ? 'Z' + room.zone : 'All'} · ${roomCode ? roomCode + ' — ' : ''}${room.space}`;

  const roomCheckEntries = Object.entries(room.checks || {});
  const checksSummary = roomCheckEntries.length
    ? roomCheckEntries.map(([c, st]) => `${c}:${st}`).join(', ')
    : 'No finishes linked';

  const finishDisplay = parsed.finishCode
    ? `\`${parsed.finishCode}\` ➔ *${(parsed.status || 'select status below').toUpperCase()}*${parsed.status === 'done' ? ' _(auto-completes micro-tasks)_' : ''}`
    : '_Tap a finish code below (optional)_';

  const text =
    `📋 *Confirm Room Update*\n\n` +
    `• *Room:* *${roomLabel}*\n` +
    `• *Room Finishes:* \`${checksSummary}\`\n` +
    `• *Finish Update:* ${finishDisplay}\n` +
    snagLine +
    photoLine +
    notesLine +
    `\n*Tap buttons below to adjust or confirm:*`;

  const keyboardRows: TelegramInlineKeyboardButton[][] = [];

  // Finish code selector rows from the room's actual checks
  const finishCodes = Object.keys(room.checks || {});
  if (finishCodes.length > 0) {
    const codeButtons: TelegramInlineKeyboardButton[] = finishCodes.slice(0, 7).map(c => ({
      text: parsed.finishCode === c ? `🎯 ${c}` : c,
      callback_data: `sfin:${action.id}:${c}`
    }));
    codeButtons.push({
      text: parsed.finishCode === 'ALL' ? '🎯 ALL' : 'ALL',
      callback_data: `sfin:${action.id}:ALL`
    });
    for (let i = 0; i < codeButtons.length; i += 4) {
      keyboardRows.push(codeButtons.slice(i, i + 4));
    }
  }

  // Status selector row
  const statuses: Array<{ key: Status; label: string }> = [
    { key: 'pending', label: '⏳ Pending' },
    { key: 'ongoing', label: '🔨 Ongoing' },
    { key: 'done', label: '✅ Done' }
  ];
  keyboardRows.push(
    statuses.map(st => ({
      text: parsed.status === st.key ? `● ${st.label}` : st.label,
      callback_data: `sstat:${action.id}:${st.key}`
    }))
  );

  // Location & Stored Photos row
  const storedPhotosCount = (room.photos || []).length;
  const metaRow: TelegramInlineKeyboardButton[] = [
    { text: '🏢 Level', callback_data: `mode:${action.id}:pick_level` },
    { text: '🗺️ Zone', callback_data: `mode:${action.id}:pick_zone` },
    { text: '🚪 Room', callback_data: `mode:${action.id}:pick_room` }
  ];
  if (storedPhotosCount > 0) {
    metaRow.push({
      text: `🖼️ Photos (${storedPhotosCount})`,
      callback_data: `rphotos:${action.id}:${room.id}`
    });
  }
  keyboardRows.push(metaRow);

  // Confirm & Cancel row
  keyboardRows.push([
    { text: '✅ Confirm & Save', callback_data: `confirm:${action.id}` },
    { text: '❌ Cancel', callback_data: `cancel:${action.id}` }
  ]);

  return {
    text,
    keyboard: { inline_keyboard: keyboardRows }
  };
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

  const parts = data.split(':');
  const actionType = parts[0];
  const actionId = parts[1];
  const value = parts.slice(2).join(':');

  // View stored photos for a room directly from a completed card
  if (actionType === 'vroom') {
    await answerCallbackQuery(token, query.id, 'Fetching room photos from storage...');
    const room = await getRoomByIdOrCode(env, value);
    if (room && chatId) {
      await sendRoomInspectionAndPhotos(env, chatId, room, true);
    }
    return;
  }

  if (actionType === 'cancel') {
    await answerCallbackQuery(token, query.id, 'Cancelled');
    const pending = await getPendingAction(env, actionId);
    if (pending?.uploadedPhotoId) {
      await deleteSitePhoto(env, pending.uploadedPhotoId).catch(() => {});
    }
    await deletePendingAction(env, actionId).catch(() => {});
    if (chatId && messageId) {
      await editMessageText(token, chatId, messageId, '❌ *Update cancelled.* No changes were made to the database.');
    }
    return;
  }

  const pending = await getPendingAction(env, actionId);
  if (!pending) {
    await answerCallbackQuery(token, query.id, 'Session expired', true);
    if (chatId && messageId) {
      await editMessageText(
        token,
        chatId,
        messageId,
        '⚠️ *Expired or Already Applied:*\nThis update could not be found. Please send a new message.'
      );
    }
    return;
  }

  // Interactive mutations on pending action
  if (actionType === 'slvl') {
    pending.parsed.level = parseInt(value, 10);
    pending.selectedRoomId = undefined;
    pending.roomPage = 0;
    pending.uiMode = 'auto';
    await answerCallbackQuery(token, query.id, `Level ${value} selected`);
    await updateCardMessage(env, chatId, messageId, pending);
    return;
  }

  if (actionType === 'szone') {
    pending.parsed.zone = parseInt(value, 10);
    pending.selectedRoomId = undefined;
    pending.roomPage = 0;
    pending.uiMode = 'auto';
    await answerCallbackQuery(token, query.id, value === '0' ? 'All Zones' : `Zone ${value} selected`);
    await updateCardMessage(env, chatId, messageId, pending);
    return;
  }

  if (actionType === 'sroom') {
    pending.selectedRoomId = value;
    pending.uiMode = 'confirm';
    await answerCallbackQuery(token, query.id, 'Room selected');
    await updateCardMessage(env, chatId, messageId, pending);
    return;
  }

  if (actionType === 'rpage') {
    pending.roomPage = parseInt(value, 10) || 0;
    pending.uiMode = 'pick_room';
    await answerCallbackQuery(token, query.id);
    await updateCardMessage(env, chatId, messageId, pending);
    return;
  }

  if (actionType === 'mode') {
    if (value === 'pick_level' || value === 'pick_zone' || value === 'pick_room') {
      pending.selectedRoomId = undefined;
    }
    pending.uiMode = value as any;
    await answerCallbackQuery(token, query.id);
    await updateCardMessage(env, chatId, messageId, pending);
    return;
  }

  if (actionType === 'sfin') {
    pending.parsed.finishCode = value;
    if (!pending.parsed.status) {
      pending.parsed.status = 'done';
    }
    pending.uiMode = 'confirm';
    await answerCallbackQuery(token, query.id, `Finish ${value}`);
    await updateCardMessage(env, chatId, messageId, pending);
    return;
  }

  if (actionType === 'sstat') {
    pending.parsed.status = value as Status;
    pending.uiMode = 'confirm';
    await answerCallbackQuery(token, query.id, `Status: ${value.toUpperCase()}`);
    await updateCardMessage(env, chatId, messageId, pending);
    return;
  }

  if (actionType === 'rphotos') {
    await answerCallbackQuery(token, query.id, 'Loading photos from Supabase Storage...');
    const room = await getRoomByIdOrCode(env, value);
    if (room && chatId) {
      await sendRoomInspectionAndPhotos(env, chatId, room, true);
    }
    return;
  }

  if (actionType === 'confirm') {
    await answerCallbackQuery(token, query.id, 'Saving to Supabase...');

    try {
      let photoId = pending.uploadedPhotoId;

      // Fallback upload if photoFileId exists but wasn't uploaded yet
      if (!photoId && pending.photoFileId) {
        try {
          const fileInfo = await getFile(token, pending.photoFileId);
          if (fileInfo.file_path) {
            const photoBytes = await downloadTelegramFile(token, fileInfo.file_path);
            const uploaded = await uploadSitePhoto(env, photoBytes);
            photoId = uploaded.photoId;
          }
        } catch (uploadErr) {
          console.error('Failed to upload photo to storage:', uploadErr);
        }
      }

      const result = await applyUpdateToRoom(env, pending, photoId);
      await deletePendingAction(env, actionId).catch(() => {});

      const finishLine =
        result.appliedFinish && pending.parsed.status
          ? `• *Finish:* \`${result.appliedFinish}\` ➔ *${pending.parsed.status.toUpperCase()}*\n`
          : '';
      const snagLine = pending.parsed.snag
        ? `• *Snag Logged:* "${pending.parsed.snag.text}" (${pending.parsed.snag.trade})\n`
        : '';
      const photoLine = photoId ? `• *Storage Photo ID:* \`${photoId}\` (synced to web app)\n` : '';

      const successText =
        `✅ *Saved to ECIT Site Tracker!*\n\n` +
        `• *Room:* *${result.roomTitle}*\n` +
        finishLine +
        snagLine +
        photoLine +
        `\n_Live synced with Supabase & ECIT Web App._`;

      const postConfirmKeyboard: TelegramInlineKeyboardMarkup | undefined =
        (result.room.photos || []).length > 0
          ? {
              inline_keyboard: [
                [
                  {
                    text: `🖼️ View Room Photos (${result.room.photos.length})`,
                    callback_data: `vroom:${actionId}:${result.room.id}`
                  }
                ]
              ]
            }
          : undefined;

      if (chatId && messageId) {
        await editMessageText(token, chatId, messageId, successText, {
          reply_markup: postConfirmKeyboard
        });
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

async function updateCardMessage(
  env: Env,
  chatId: number | undefined,
  messageId: number | undefined,
  pending: PendingAction
) {
  const card = await buildInteractivePrompt(env, pending);
  await savePendingAction(env, pending);
  if (chatId && messageId) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, chatId, messageId, card.text, {
      reply_markup: card.keyboard
    });
  }
}

/**
 * Sends room status summary and up to 5 latest stored photos from Supabase Storage (`photos` bucket).
 */
async function sendRoomInspectionAndPhotos(
  env: Env,
  chatId: number | string,
  room: Room,
  photosOnly = false
) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const code = room.spaceCode || room.spaceNo || '';
  const title = `${room.level === 0 ? 'GF' : 'L' + room.level} Z${room.zone || 'All'} · ${code ? code + ' — ' : ''}${room.space}`;

  if (!photosOnly) {
    const checks = Object.entries(room.checks || {})
      .map(([c, st]) => `\`${c}\`: *${st.toUpperCase()}*`)
      .join(' · ');
    const openSnags = (room.snags || []).filter(s => s.status === 'open');
    const snagsText = openSnags.length
      ? openSnags.map(s => `  - [${s.trade || 'General'}] ${s.text}`).join('\n')
      : 'None';

    const summary =
      `🏠 *${title}*\n\n` +
      `• *Finishes:* ${checks || 'None'}\n` +
      `• *Open Snags (${openSnags.length}):*\n${snagsText}\n` +
      `• *Stored Photos:* ${(room.photos || []).length}`;
    await sendMessage(token, chatId, summary);
  }

  const photos = (room.photos || []).slice(0, 5);
  if (!photos.length) {
    await sendMessage(token, chatId, `📭 No stored photos found for *${title}*.`);
    return;
  }

  for (const p of photos) {
    const publicUrl = getPhotoPublicUrl(env, p.id);
    const caption = `📸 *${title}*\n${p.code ? `Finish: \`${p.code}\` · ` : ''}${p.caption || 'Site photo'}\nID: \`${p.id}\``;
    await sendPhoto(token, chatId, publicUrl, caption);
  }
}
