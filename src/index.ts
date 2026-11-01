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
  setMyCommands,
  getFile,
  downloadTelegramFile
} from './telegram';
import { analyzeSiteUpdate, normalizeScheduleCodeInput } from './ai';
import {
  savePendingAction,
  getPendingAction,
  deletePendingAction,
  applyUndoSnapshot,
  uploadSitePhoto,
  deleteSitePhoto,
  getPhotoPublicUrl,
  getRoomByIdOrCode,
  getRoomsForLevelZone,
  resolveRoomCandidates,
  resolveFinishCodeForRoom,
  applyUpdateToRoom,
  quickCycleRoomFinish,
  closeRoomSnag,
  getProjectStats,
  getRoomsWithOpenSnags,
  formatRoomTitle,
  finishCompactName,
  finishShortDesc,
  formatFinishButton,
  formatFinishLine
} from './supabase';

const WEB_APP_BASE = 'https://ecit-tracker.pages.dev';

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

    // 2. Setup Webhook & Commands helper endpoint
    if (request.method === 'GET' && url.pathname === '/setup-webhook') {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return new Response('TELEGRAM_BOT_TOKEN secret is not set', { status: 400 });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const tgRes = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
      );
      const tgData: any = await tgRes.json();
      const cmdData = await setMyCommands(env.TELEGRAM_BOT_TOKEN).catch(e => ({ error: String(e) }));
      return new Response(JSON.stringify({ webhook: tgData, commands: cmdData }, null, 2), {
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

function statusEmoji(st?: Status | string | null): string {
  if (st === 'done') return '✅';
  if (st === 'ongoing') return '🔨';
  if (st === 'pending') return '⏳';
  return '⚪';
}

function roomOverallEmoji(room: Room): string {
  const vals = Object.values(room.checks || {});
  if (!vals.length) return '⚪';
  if (vals.every(v => v === 'done')) return '✅';
  if (vals.some(v => v === 'done' || v === 'ongoing')) return '🔨';
  if (vals.some(v => v === 'pending')) return '⏳';
  return '⚪';
}

function mainMenuKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '🧭 Browse Rooms', callback_data: 'b_lvl:all' },
        { text: '📊 Project Status', callback_data: 'b_stats:main' }
      ],
      [
        { text: '⚠️ Open Snags', callback_data: 'b_snags:0' },
        { text: '🌐 Open Web App', url: WEB_APP_BASE }
      ]
    ]
  };
}

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

  // Command: /start or /menu
  if (text.startsWith('/start') || text.startsWith('/menu')) {
    await setMyCommands(token).catch(() => {});
    const welcome =
      `🏗️ *ECIT Site Tracker Assistant*\n\n` +
      `Send site progress updates, photos, or snag reports naturally:\n` +
      `• \`F1-021 screed done\`\n` +
      `• \`GF-008 tiles ongoing\`\n` +
      `• \`Snag: F1-040C wall tile cracked\`\n` +
      `• Or send a *Photo* (even without room/level — interactive buttons will guide you!)\n\n` +
      `*Quick Commands:*\n` +
      `• \`/browse\` — Browse Levels ➔ Zones ➔ Rooms interactively\n` +
      `• \`/status\` — Live project KPIs & floor progress\n` +
      `• \`/snags\` — View & resolve open snags across the site\n` +
      `• \`/room <code>\` — Open interactive room dashboard\n` +
      `• \`/photos <code>\` — View stored room photos`;
    await sendMessage(token, chatId, welcome, { reply_markup: mainMenuKeyboard() });
    return;
  }

  // Command: /help
  if (text.startsWith('/help')) {
    const help =
      `📖 *ECIT Bot Guide*\n\n` +
      `1️⃣ *Smart Updates:* Send text or photo like \`GF-008 tiles done\` or just a photo. If Level, Zone, or Room is missing, tap the buttons to select them.\n` +
      `2️⃣ *Snag Mode & Trades:* On any confirmation card, tap *⚠️ Log as Snag* to convert a photo/note into a Snag and choose its trade (\`Tile\`, \`Paint\`, \`MEP\`, etc.).\n` +
      `3️⃣ *Interactive Room Dashboard (\`/browse\` or \`/room\`):* Tap any finish button on a room card to cycle its status (\`Pending ➔ Ongoing ➔ Done\`) or close open snags with 1 tap.\n` +
      `4️⃣ *Undo Support:* Made a mistake? Tap *↩️ Undo Change* right after saving.\n` +
      `5️⃣ *Reply Shortcut:* Reply directly to any Room card with a photo or note and the bot will automatically attach it to that room!`;
    await sendMessage(token, chatId, help, { reply_markup: mainMenuKeyboard() });
    return;
  }

  // Command: /status or /stats
  if (text.startsWith('/status') || text.startsWith('/stats')) {
    const card = await buildStatsCard(env);
    await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
    return;
  }

  // Command: /snags
  if (text.startsWith('/snags')) {
    const card = await buildOpenSnagsCard(env, 0);
    await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
    return;
  }

  // Command: /browse
  if (text.startsWith('/browse')) {
    const card = buildBrowseLevelsCard();
    await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
    return;
  }

  // Command: /room or /photos
  if (text.startsWith('/room') || text.startsWith('/photos')) {
    const isPhotosOnly = text.startsWith('/photos');
    const arg = text.replace(/^\/(room|photos)(?:@\w+)?\s*/i, '').trim();
    if (!arg) {
      const card = buildBrowseLevelsCard();
      await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
      return;
    }
    const room = await getRoomByIdOrCode(env, arg);
    if (!room) {
      await sendMessage(
        token,
        chatId,
        `⚠️ Room \`${arg}\` not found. Tap below to browse by Level & Zone:`,
        { reply_markup: buildBrowseLevelsCard().keyboard }
      );
      return;
    }
    if (isPhotosOnly) {
      await sendRoomInspectionAndPhotos(env, chatId, room, true);
    } else {
      const card = buildRoomDashboardCard(room);
      await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  if (!text && (!message.photo || message.photo.length === 0)) {
    return;
  }

  // Check if user replied to a previous bot message mentioning a room code (e.g., GF-008, F1-040C)
  let replyContextCode: string | null = null;
  const replyText = message.reply_to_message?.text || message.reply_to_message?.caption || '';
  if (replyText) {
    const m = replyText.match(/\b(GF-\d{2,4}[A-Z]?|F[1-8]-\d{2,4}[A-Z]?)\b/i);
    if (m) {
      replyContextCode = normalizeScheduleCodeInput(m[1]);
    }
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
          try {
            const uploaded = await uploadSitePhoto(env, photoBytes);
            uploadedPhotoId = uploaded.photoId;
          } catch (upErr) {
            console.error('Initial photo storage upload warning:', upErr);
          }
        }
      }
    }

    const effectiveText =
      replyContextCode && !text.toUpperCase().includes(replyContextCode)
        ? `${replyContextCode} ${text}`.trim()
        : text;

    const parsed = await analyzeSiteUpdate(env, effectiveText, photoBytes);

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

// ============================================================================
// INTERACTIVE BROWSER, STATS & ROOM DASHBOARD BUILDERS
// ============================================================================

function buildBrowseLevelsCard(): { text: string; keyboard: TelegramInlineKeyboardMarkup } {
  const text =
    `🧭 *Interactive Room Browser*\n\n` +
    `Select a *Floor Level* below to browse zones, inspect rooms, toggle finish statuses, or view photos:`;

  const row1: TelegramInlineKeyboardButton[] = [0, 1, 2, 3, 4].map(lvl => ({
    text: lvl === 0 ? '🏢 GF' : `🏢 L${lvl}`,
    callback_data: `b_zn:${lvl}`
  }));
  const row2: TelegramInlineKeyboardButton[] = [5, 6, 7, 8].map(lvl => ({
    text: `🏢 L${lvl}`,
    callback_data: `b_zn:${lvl}`
  }));

  return {
    text,
    keyboard: {
      inline_keyboard: [
        row1,
        row2,
        [
          { text: '📊 Project Status', callback_data: 'b_stats:main' },
          { text: '⚠️ Open Snags', callback_data: 'b_snags:0' }
        ]
      ]
    }
  };
}

function buildBrowseZonesCard(level: number): { text: string; keyboard: TelegramInlineKeyboardMarkup } {
  const lvlName = level === 0 ? 'Ground Floor (GF)' : `Level ${level}`;
  const text =
    `🗺️ *${lvlName} — Select Zone*\n\n` +
    `Choose a zone on *${lvlName}* to list rooms:`;

  const zRow: TelegramInlineKeyboardButton[] = [1, 2, 3, 4].map(z => ({
    text: `Zone ${z}`,
    callback_data: `b_rms:${level}:${z}:0`
  }));

  return {
    text,
    keyboard: {
      inline_keyboard: [
        zRow,
        [
          { text: '🌐 All Zones on Floor', callback_data: `b_rms:${level}:0:0` },
          { text: '⬅️ All Levels', callback_data: 'b_lvl:all' }
        ]
      ]
    }
  };
}

async function buildBrowseRoomsListCard(
  env: Env,
  level: number,
  zone: number,
  page: number
): Promise<{ text: string; keyboard: TelegramInlineKeyboardMarkup }> {
  const rooms = await getRoomsForLevelZone(env, level, zone);
  const lvlName = level === 0 ? 'GF' : `L${level}`;
  const znName = zone === 0 ? 'All Zones' : `Zone ${zone}`;

  const pageSize = 7;
  const totalPages = Math.max(1, Math.ceil(rooms.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = rooms.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const doneCount = rooms.filter(r => {
    const vals = Object.values(r.checks || {});
    return vals.length > 0 && vals.every(v => v === 'done');
  }).length;

  const text =
    `🚪 *Rooms in ${lvlName} · ${znName}*\n` +
    `• *Rooms Complete:* *${doneCount} / ${rooms.length}*\n` +
    `• *Page:* ${safePage + 1} of ${totalPages}\n\n` +
    `👇 *Tap any room to open its live inspection dashboard:*`;

  const rows: TelegramInlineKeyboardButton[][] = slice.map(rm => {
    const emoji = roomOverallEmoji(rm);
    const code = rm.spaceCode || rm.spaceNo || '';
    const openSnags = (rm.snags || []).filter(s => s.status === 'open').length;
    const snagBadge = openSnags > 0 ? ` ⚠️${openSnags}` : '';
    const photoBadge = (rm.photos || []).length > 0 ? ` 📸${rm.photos.length}` : '';
    const label = `${emoji} ${code ? code + ' · ' : ''}${rm.space}${snagBadge}${photoBadge}`;
    return [
      {
        text: label.slice(0, 52),
        callback_data: `b_rm:${rm.id}`
      }
    ];
  });

  if (totalPages > 1) {
    const nav: TelegramInlineKeyboardButton[] = [];
    if (safePage > 0) {
      nav.push({ text: '⬅️ Prev', callback_data: `b_rms:${level}:${zone}:${safePage - 1}` });
    }
    if (safePage < totalPages - 1) {
      nav.push({ text: 'Next ➡️', callback_data: `b_rms:${level}:${zone}:${safePage + 1}` });
    }
    if (nav.length) rows.push(nav);
  }

  rows.push([
    { text: `🗺️ ${lvlName} Zones`, callback_data: `b_zn:${level}` },
    { text: '🏢 All Levels', callback_data: 'b_lvl:all' }
  ]);

  return {
    text,
    keyboard: { inline_keyboard: rows }
  };
}

function buildRoomDashboardCard(room: Room): { text: string; keyboard: TelegramInlineKeyboardMarkup } {
  const title = formatRoomTitle(room);
  const checkEntries = Object.entries(room.checks || {});
  const checksLines = checkEntries.length
    ? checkEntries
        .map(([c, st]) => `  ${statusEmoji(st)} \`${c}\` · ${finishShortDesc(c)} — *${st.toUpperCase()}*`)
        .join('\n')
    : '  _No finishes assigned_';

  const openSnags = (room.snags || []).filter(s => s.status === 'open');
  const snagLines = openSnags.length
    ? openSnags
        .slice(0, 5)
        .map((s, i) => `  ${i + 1}. ⚠️ *[${s.trade || 'General'}]* ${s.text}`)
        .join('\n')
    : '  ✅ None';

  const latestLogs = (room.log || []).slice(0, 2);
  const logLines = latestLogs.length
    ? latestLogs.map(l => `  • _${l.text}_ (${l.by || 'User'})`).join('\n')
    : '';

  const text =
    `🏠 *${title}*\n\n` +
    `📋 *Finishes (${checkEntries.filter(([, s]) => s === 'done').length}/${checkEntries.length} Done):*\n${checksLines}\n\n` +
    `⚠️ *Open Snags (${openSnags.length}):*\n${snagLines}\n` +
    (room.notes ? `\n📝 *Notes:* _${room.notes}_\n` : '') +
    `📸 *Stored Photos:* ${(room.photos || []).length}` +
    (logLines ? `\n\n🕒 *Recent Activity:*\n${logLines}` : '') +
    `\n\n💡 _Tap any finish below to cycle status (Pending ➔ Ongoing ➔ Done), or reply to this message with a photo/note!_`;

  const rows: TelegramInlineKeyboardButton[][] = [];

  // 1-Tap Finish Toggle buttons (2 per row so short names fit cleanly)
  if (checkEntries.length > 0) {
    const btns: TelegramInlineKeyboardButton[] = checkEntries.slice(0, 8).map(([code, st]) => ({
      text: formatFinishButton(code, `${statusEmoji(st)} `),
      callback_data: `qfin:${room.id}:${code}`
    }));
    for (let i = 0; i < btns.length; i += 2) {
      rows.push(btns.slice(i, i + 2));
    }
  }

  // 1-Tap Close Snag buttons for open snags (up to 3)
  for (const s of openSnags.slice(0, 3)) {
    const shortText = s.text.length > 26 ? s.text.slice(0, 26) + '…' : s.text;
    rows.push([
      {
        text: `✅ Resolve Snag: "${shortText}"`,
        callback_data: `qsnag:${room.id}:${s.id}`
      }
    ]);
  }

  // Photos & Web App link row
  const actionRow: TelegramInlineKeyboardButton[] = [];
  if ((room.photos || []).length > 0) {
    actionRow.push({
      text: `🖼️ Photos (${room.photos.length})`,
      callback_data: `vroom:dash:${room.id}`
    });
  }
  actionRow.push({
    text: '🌐 Open in Web App',
    url: `${WEB_APP_BASE}/#/room/${encodeURIComponent(room.id)}`
  });
  rows.push(actionRow);

  // Back navigation row
  rows.push([
    { text: `⬅️ ${room.level === 0 ? 'GF' : 'L' + room.level} Z${room.zone || 'All'} Rooms`, callback_data: `b_rms:${room.level}:${room.zone || 0}:0` },
    { text: '🧭 All Levels', callback_data: 'b_lvl:all' }
  ]);

  return {
    text,
    keyboard: { inline_keyboard: rows }
  };
}

async function buildStatsCard(env: Env): Promise<{ text: string; keyboard: TelegramInlineKeyboardMarkup }> {
  const stats = await getProjectStats(env);

  const levelLines: string[] = [];
  for (let l = 0; l <= 8; l++) {
    const lv = stats.byLevel[l];
    if (!lv || lv.total === 0) continue;
    const pct = lv.checksTotal ? Math.round((lv.checksDone / lv.checksTotal) * 100) : 0;
    const lbl = l === 0 ? 'GF' : `L${l}`;
    const snagStr = lv.snags > 0 ? ` · ⚠️ ${lv.snags}` : '';
    levelLines.push(`• *${lbl}:* ${pct}% checks (${lv.done}/${lv.total} rooms done)${snagStr}`);
  }

  const text =
    `📊 *ECIT Building — Live Project Status*\n\n` +
    `🏠 *Rooms Fully Done:* *${stats.roomsDone} / ${stats.totalRooms}* (*${stats.roomsDonePct}%*)\n` +
    `✅ *Finishes Done:* *${stats.checksDone} / ${stats.checksTotal}* (*${stats.checksDonePct}%*)\n` +
    `🔨 *Finishes Ongoing:* *${stats.checksOngoing}*\n` +
    `⏳ *Finishes Pending:* *${stats.checksPending}*\n` +
    `⚠️ *Open Snags:* *${stats.openSnags}*\n` +
    `📸 *Stored Photos:* *${stats.totalPhotos}*\n\n` +
    `*Progress by Floor:*\n${levelLines.join('\n')}\n\n` +
    `👇 *Tap a floor below to inspect its rooms:*`;

  const row1: TelegramInlineKeyboardButton[] = [0, 1, 2, 3, 4].map(lvl => ({
    text: lvl === 0 ? 'GF' : `L${lvl}`,
    callback_data: `b_zn:${lvl}`
  }));
  const row2: TelegramInlineKeyboardButton[] = [5, 6, 7, 8].map(lvl => ({
    text: `L${lvl}`,
    callback_data: `b_zn:${lvl}`
  }));

  return {
    text,
    keyboard: {
      inline_keyboard: [
        row1,
        row2,
        [
          { text: '🔄 Refresh Stats', callback_data: 'b_stats:refresh' },
          { text: `⚠️ Open Snags (${stats.openSnags})`, callback_data: 'b_snags:0' }
        ]
      ]
    }
  };
}

async function buildOpenSnagsCard(
  env: Env,
  page: number
): Promise<{ text: string; keyboard: TelegramInlineKeyboardMarkup }> {
  const rooms = await getRoomsWithOpenSnags(env);
  const totalOpenSnags = rooms.reduce(
    (acc, r) => acc + (r.snags || []).filter(s => s.status === 'open').length,
    0
  );

  if (rooms.length === 0) {
    return {
      text: `🎉 *Zero Open Snags!*\n\nAll reported snags across the project have been resolved.`,
      keyboard: mainMenuKeyboard()
    };
  }

  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(rooms.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = rooms.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const lines = slice.map(r => {
    const open = (r.snags || []).filter(s => s.status === 'open');
    const code = r.spaceCode || r.spaceNo || '';
    const sample = open[0]?.text || '';
    return `• *${r.level === 0 ? 'GF' : 'L' + r.level} Z${r.zone || 'All'} ${code}* (${r.space}) — *${open.length} open*\n  _"${sample.slice(0, 60)}"_`;
  });

  const text =
    `⚠️ *Open Snags Across Site (${totalOpenSnags} total in ${rooms.length} rooms)*\n` +
    `Page ${safePage + 1} of ${totalPages}\n\n` +
    `${lines.join('\n\n')}\n\n` +
    `👇 *Tap a room below to inspect or resolve its snags:*`;

  const rows: TelegramInlineKeyboardButton[][] = slice.map(r => {
    const openCount = (r.snags || []).filter(s => s.status === 'open').length;
    const code = r.spaceCode || r.spaceNo || '';
    return [
      {
        text: `⚠️ (${openCount}) ${r.level === 0 ? 'GF' : 'L' + r.level} ${code} · ${r.space}`.slice(0, 48),
        callback_data: `b_rm:${r.id}`
      }
    ];
  });

  if (totalPages > 1) {
    const nav: TelegramInlineKeyboardButton[] = [];
    if (safePage > 0) {
      nav.push({ text: '⬅️ Prev', callback_data: `b_snags:${safePage - 1}` });
    }
    if (safePage < totalPages - 1) {
      nav.push({ text: 'Next ➡️', callback_data: `b_snags:${safePage + 1}` });
    }
    rows.push(nav);
  }

  rows.push([
    { text: '🧭 Browse Rooms', callback_data: 'b_lvl:all' },
    { text: '📊 Project Status', callback_data: 'b_stats:main' }
  ]);

  return {
    text,
    keyboard: { inline_keyboard: rows }
  };
}

// ============================================================================
// PENDING UPDATE PROMPT BUILDER (LEVEL -> ZONE -> ROOM -> CONFIRM)
// ============================================================================

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

  const photoLine =
    action.uploadedPhotoId || action.photoFileId
      ? `• *Photo:* 📸 Attached ${action.uploadedPhotoId ? `(\`${action.uploadedPhotoId}.jpg\`)` : ''}\n`
      : '';
  const snagLine = parsed.snag
    ? `• *Snag:* ⚠️ "${parsed.snag.text}" (Trade: *${parsed.snag.trade}*)\n`
    : '';
  const notesLine = parsed.notes ? `• *Note:* _${parsed.notes}_\n` : '';

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
      (parsed.finishCode
        ? `• *Finish:* ${formatFinishLine(parsed.finishCode)} ${parsed.status ? `➔ *${parsed.status.toUpperCase()}*` : ''}\n`
        : '') +
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
      (parsed.finishCode
        ? `• *Finish:* ${formatFinishLine(parsed.finishCode)} ${parsed.status ? `➔ *${parsed.status.toUpperCase()}*` : ''}\n`
        : '') +
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
      (parsed.finishCode
        ? `• *Finish:* ${formatFinishLine(parsed.finishCode)} ${parsed.status ? `➔ *${parsed.status.toUpperCase()}*` : ''}\n`
        : '') +
      snagLine +
      photoLine +
      `\n👇 *Choose the room (${candidates.length} found, page ${page + 1}/${totalPages}):*`;

    const rows: TelegramInlineKeyboardButton[][] = pageItems.map(rm => {
      const code = rm.spaceCode || rm.spaceNo || '';
      const zTag = rm.zone ? `Z${rm.zone}` : 'All';
      const label = `${roomOverallEmoji(rm)} ${code ? code + ' · ' : ''}${rm.space} (${zTag})`;
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

  // ================= OPTIONAL: PICK SNAG TRADE =================
  if (mode === 'pick_trade') {
    const trades = ['Tile', 'Paint', 'Plaster', 'Ceiling', 'Floor', 'MEP', 'Civil', 'General'];
    const tradeRows: TelegramInlineKeyboardButton[][] = [];
    for (let i = 0; i < trades.length; i += 4) {
      tradeRows.push(
        trades.slice(i, i + 4).map(t => ({
          text: parsed.snag?.trade === t ? `🎯 ${t}` : t,
          callback_data: `strade:${action.id}:${t}`
        }))
      );
    }
    tradeRows.push([{ text: '⬅️ Back to Confirm', callback_data: `mode:${action.id}:confirm` }]);

    return {
      text: `🛠️ *Select Snag Trade*\n\n• *Snag:* "${parsed.snag?.text || parsed.notes || 'Site defect'}"\n\n👇 *Tap the responsible trade:*`,
      keyboard: { inline_keyboard: tradeRows }
    };
  }

  // ================= STEP 4: CONFIRMATION & FINISH/STATUS/SNAG CONTROLS =================
  const room = resolved.exact;
  const alignedFinish = resolveFinishCodeForRoom(room, parsed.finishCode, parsed.finishKind);
  if (alignedFinish) {
    parsed.finishCode = alignedFinish;
  }

  const roomLabel = formatRoomTitle(room);
  const roomCheckEntries = Object.entries(room.checks || {});
  const checksSummary = roomCheckEntries.length
    ? roomCheckEntries
        .map(([c, st]) => `  ${statusEmoji(st)} \`${c}\` · ${finishCompactName(c)} (*${st.toUpperCase()}*)`)
        .join('\n')
    : '  _No finishes linked_';

  const finishDisplay = parsed.finishCode
    ? `${formatFinishLine(parsed.finishCode)} ➔ *${(parsed.status || 'select status below').toUpperCase()}*${parsed.status === 'done' ? ' _(auto-completes micro-tasks)_' : ''}`
    : '_Tap a finish below (optional)_';

  const text =
    `📋 *Confirm Room Update*\n\n` +
    `• *Room:* *${roomLabel}*\n` +
    `• *Current Finishes:*\n${checksSummary}\n` +
    `• *Finish Update:* ${finishDisplay}\n` +
    snagLine +
    photoLine +
    notesLine +
    `\n*Tap buttons below to adjust or confirm:*`;

  const keyboardRows: TelegramInlineKeyboardButton[][] = [];

  // Finish selector rows from the room's actual checks (2 per row with short names)
  const finishCodes = Object.keys(room.checks || {});
  if (finishCodes.length > 0) {
    const codeButtons: TelegramInlineKeyboardButton[] = finishCodes.slice(0, 7).map(c => ({
      text: formatFinishButton(c, parsed.finishCode === c ? '🎯 ' : ''),
      callback_data: `sfin:${action.id}:${c}`
    }));
    codeButtons.push({
      text: formatFinishButton('ALL', parsed.finishCode === 'ALL' ? '🎯 ' : ''),
      callback_data: `sfin:${action.id}:ALL`
    });
    for (let i = 0; i < codeButtons.length; i += 2) {
      keyboardRows.push(codeButtons.slice(i, i + 2));
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

  // Snag toggle & Trade picker row
  const snagRow: TelegramInlineKeyboardButton[] = [
    {
      text: parsed.snag ? '⚠️ Snag: ON (Tap to turn OFF)' : '➕ Log as Snag',
      callback_data: `tsnag:${action.id}:toggle`
    }
  ];
  if (parsed.snag) {
    snagRow.push({
      text: `🛠️ Trade: ${parsed.snag.trade}`,
      callback_data: `mode:${action.id}:pick_trade`
    });
  }
  keyboardRows.push(snagRow);

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

// ============================================================================
// CALLBACK QUERY HANDLER
// ============================================================================

async function handleCallbackQuery(query: any, env: Env): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const data = query.data || '';
  const message = query.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  const authorName = query.from?.username || query.from?.first_name;

  if (!data.includes(':')) {
    await answerCallbackQuery(token, query.id);
    return;
  }

  const parts = data.split(':');
  const actionType = parts[0];
  const actionId = parts[1];
  const value = parts.slice(2).join(':');

  // --- Interactive Browser & Stats Callbacks ---
  if (actionType === 'b_lvl') {
    await answerCallbackQuery(token, query.id);
    const card = buildBrowseLevelsCard();
    if (chatId && messageId) {
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  if (actionType === 'b_zn') {
    const lvl = parseInt(actionId, 10) || 0;
    await answerCallbackQuery(token, query.id, lvl === 0 ? 'Ground Floor' : `Level ${lvl}`);
    const card = buildBrowseZonesCard(lvl);
    if (chatId && messageId) {
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  if (actionType === 'b_rms') {
    const lvl = parseInt(actionId, 10) || 0;
    const [zStr, pStr] = value.split(':');
    const zone = parseInt(zStr, 10) || 0;
    const page = parseInt(pStr, 10) || 0;
    await answerCallbackQuery(token, query.id);
    const card = await buildBrowseRoomsListCard(env, lvl, zone, page);
    if (chatId && messageId) {
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  if (actionType === 'b_rm') {
    const roomId = parts.slice(1).join(':');
    await answerCallbackQuery(token, query.id);
    const room = await getRoomByIdOrCode(env, roomId);
    if (room && chatId && messageId) {
      const card = buildRoomDashboardCard(room);
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  if (actionType === 'qfin') {
    const roomId = actionId;
    const finishCode = value;
    const updated = await quickCycleRoomFinish(env, roomId, finishCode, authorName);
    if (updated && chatId && messageId) {
      await answerCallbackQuery(
        token,
        query.id,
        `${finishCode} (${finishCompactName(finishCode)}) → ${updated.nextStatus.toUpperCase()}`
      );
      const card = buildRoomDashboardCard(updated.room);
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    } else {
      await answerCallbackQuery(token, query.id, 'Could not update finish', true);
    }
    return;
  }

  if (actionType === 'qsnag') {
    const roomId = actionId;
    const snagId = value;
    const res = await closeRoomSnag(env, roomId, snagId, authorName);
    if (res && chatId && messageId) {
      await answerCallbackQuery(token, query.id, 'Snag marked as Resolved ✅');
      const card = buildRoomDashboardCard(res.room);
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    } else {
      await answerCallbackQuery(token, query.id, 'Could not resolve snag', true);
    }
    return;
  }

  if (actionType === 'b_stats') {
    await answerCallbackQuery(token, query.id, 'Refreshing project stats...');
    const card = await buildStatsCard(env);
    if (chatId && messageId) {
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  if (actionType === 'b_snags') {
    const page = parseInt(actionId, 10) || 0;
    await answerCallbackQuery(token, query.id);
    const card = await buildOpenSnagsCard(env, page);
    if (chatId && messageId) {
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  // Undo last confirmed update
  if (actionType === 'undo') {
    await answerCallbackQuery(token, query.id, 'Reverting update...');
    try {
      const res = await applyUndoSnapshot(env, actionId);
      if (res.ok && chatId && messageId) {
        await editMessageText(
          token,
          chatId,
          messageId,
          `↩️ *Update Reverted*\n\nRoom *${res.roomTitle}* was restored to its previous state.`,
          { reply_markup: mainMenuKeyboard() }
        );
      } else {
        await answerCallbackQuery(token, query.id, 'Undo snapshot expired or already used', true);
      }
    } catch (e: any) {
      await answerCallbackQuery(token, query.id, 'Undo failed: ' + (e?.message || 'Error'), true);
    }
    return;
  }

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
    await answerCallbackQuery(token, query.id, `${value} · ${finishCompactName(value)}`);
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

  if (actionType === 'tsnag') {
    if (pending.parsed.snag) {
      pending.parsed.snag = null;
      await answerCallbackQuery(token, query.id, 'Snag mode OFF');
    } else {
      pending.parsed.snag = {
        text: pending.parsed.notes || pending.parsed.summary || 'Site defect reported via Telegram',
        trade: pending.parsed.finishKind === 'Ceiling' ? 'Ceiling' : pending.parsed.finishKind === 'Floor' ? 'Tile' : 'General'
      };
      await answerCallbackQuery(token, query.id, 'Snag mode ON ⚠️');
    }
    pending.uiMode = 'confirm';
    await updateCardMessage(env, chatId, messageId, pending);
    return;
  }

  if (actionType === 'strade') {
    if (!pending.parsed.snag) {
      pending.parsed.snag = {
        text: pending.parsed.notes || 'Site defect',
        trade: value
      };
    } else {
      pending.parsed.snag.trade = value;
    }
    pending.uiMode = 'confirm';
    await answerCallbackQuery(token, query.id, `Trade: ${value}`);
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
          ? `• *Finish:* ${formatFinishLine(result.appliedFinish)} ➔ *${pending.parsed.status.toUpperCase()}*\n`
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

      const postButtons: TelegramInlineKeyboardButton[][] = [
        [
          { text: '🏠 Open Room Card', callback_data: `b_rm:${result.room.id}` },
          { text: '↩️ Undo Change', callback_data: `undo:${result.undoId}` }
        ]
      ];
      if ((result.room.photos || []).length > 0) {
        postButtons.push([
          {
            text: `🖼️ View Room Photos (${result.room.photos.length})`,
            callback_data: `vroom:${actionId}:${result.room.id}`
          },
          {
            text: '🌐 Open in Web App',
            url: `${WEB_APP_BASE}/#/room/${encodeURIComponent(result.room.id)}`
          }
        ]);
      }

      if (chatId && messageId) {
        await editMessageText(token, chatId, messageId, successText, {
          reply_markup: { inline_keyboard: postButtons }
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

async function sendRoomInspectionAndPhotos(
  env: Env,
  chatId: number | string,
  room: Room,
  photosOnly = false
) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const title = formatRoomTitle(room);

  if (!photosOnly) {
    const card = buildRoomDashboardCard(room);
    await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
  }

  const photos = (room.photos || []).slice(0, 5);
  if (!photos.length) {
    await sendMessage(token, chatId, `📭 No stored photos found for *${title}*.`);
    return;
  }

  for (const p of photos) {
    const publicUrl = getPhotoPublicUrl(env, p.id);
    const caption = `📸 *${title}*\n${p.code ? `Finish: ${formatFinishLine(p.code)} · ` : ''}${p.caption || 'Site photo'}\nID: \`${p.id}\``;
    await sendPhoto(token, chatId, publicUrl, caption);
  }
}
