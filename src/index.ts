import type {
  Env,
  TelegramUpdate,
  PendingAction,
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
  Room,
  Status,
  TelegramAuthorizedUser,
  MicroTaskLibrary
} from './types';
import {
  sendMessage,
  editMessageText,
  sendPhoto,
  answerCallbackQuery,
  deleteMessage,
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
  alignParsedWithRoom,
  applyUpdateToRoom,
  quickCycleRoomFinish,
  closeRoomSnag,
  getProjectStats,
  getRoomsWithOpenSnags,
  formatRoomTitle,
  finishCompactName,
  finishShortDesc,
  formatFinishButton,
  formatFinishLine,
  getTelegramAuthRegistry,
  getAuthorizedTelegramUser,
  formatTelegramAuthorLabel,
  generateTelegramLinkCode,
  consumeTelegramLinkCode,
  authenticateWithInviteCode,
  authenticateWithSupabaseLogin,
  verifySupabaseUserFromToken,
  requestTelegramAccess,
  setTelegramUserStatus,
  unlinkTelegramUser,
  listRegisteredWebUsers,
  adminCreateWebUser,
  adminUpdateWebUser,
  adminDeleteWebUser,
  fetchMicroTaskLibrary,
  humanizeMicroId,
  getRoomFinishMicroTasks,
  quickCycleRoomMicro,
  passAllRoomMicros
} from './supabase';

const WEB_APP_BASE = 'https://ecit-tracker.pages.dev';
const BOT_USERNAME = 'ec20026bot';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS
    }
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 1. Health check endpoint
    if (request.method === 'GET' && url.pathname === '/') {
      return jsonResponse({
        status: 'online',
        service: 'ECIT Site Tracker Telegram Bot Worker',
        botUsername: BOT_USERNAME,
        time: new Date().toISOString()
      });
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
      return jsonResponse({ webhook: tgData, commands: cmdData });
    }

    // 3. Web App <-> Telegram Auth API (/api/tg-auth)
    if (url.pathname === '/api/tg-auth') {
      return handleWebTelegramAuthApi(request, env);
    }
    if (url.pathname === '/api/test-ai') {
          return handleTestAiApi(request, env);
    }

    // 4. Webhook handler: POST / or POST /webhook
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

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  }
};

async function handleWebTelegramAuthApi(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const webUser = await verifySupabaseUserFromToken(env, token);
  if (!webUser) {
    return jsonResponse({ ok: false, error: 'Unauthorized: valid Supabase session required' }, 401);
  }

  try {
    const body: any = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const action = body.action || 'status';

    if (action === 'status') {
      const reg = await getTelegramAuthRegistry(env);
      const allList = Object.values(reg.users).sort((a, b) =>
        (b.linkedAt || '').localeCompare(a.linkedAt || '')
      );
      const linkedUsers = allList.filter(
        u =>
          u.supabaseUserId === webUser.id ||
          (webUser.email && u.email && u.email.toLowerCase() === webUser.email.toLowerCase())
      );
      const activeCode = Object.values(reg.linkCodes).find(c => c.supabaseUserId === webUser.id) || null;
      const webUsers = webUser.isAdmin ? await listRegisteredWebUsers(env).catch(() => []) : undefined;
      return jsonResponse({
        ok: true,
        botUsername: BOT_USERNAME,
        linkedUsers,
        activeCode,
        allUsers: webUser.isAdmin ? allList : undefined,
        webUsers
      });
    }

    if (action === 'admin_list_web_users') {
      if (!webUser.isAdmin) {
        return jsonResponse({ ok: false, error: 'Admin privileges required' }, 403);
      }
      const webUsers = await listRegisteredWebUsers(env);
      return jsonResponse({ ok: true, webUsers });
    }

    if (action === 'admin_create_web_user') {
      if (!webUser.isAdmin) {
        return jsonResponse({ ok: false, error: 'Admin privileges required' }, 403);
      }
      if (!body.email || !body.password) {
        return jsonResponse({ ok: false, error: 'Email and password are required' }, 400);
      }
      const created = await adminCreateWebUser(env, {
        email: String(body.email),
        password: String(body.password),
        displayName: body.displayName ? String(body.displayName) : undefined,
        role: body.role === 'admin' ? 'admin' : 'inspector'
      });
      const webUsers = await listRegisteredWebUsers(env);
      return jsonResponse({ ok: true, user: created, webUsers });
    }

    if (action === 'admin_update_web_user') {
      if (!webUser.isAdmin) {
        return jsonResponse({ ok: false, error: 'Admin privileges required' }, 403);
      }
      const targetUserId = String(body.userId || '').trim();
      if (!targetUserId) {
        return jsonResponse({ ok: false, error: 'Missing userId' }, 400);
      }
      if (targetUserId === webUser.id) {
        if (body.banned === true) {
          return jsonResponse({ ok: false, error: 'You cannot suspend your own Admin account' }, 400);
        }
        if (body.role === 'inspector') {
          return jsonResponse({ ok: false, error: 'You cannot demote your own Admin account' }, 400);
        }
      }
      const updated = await adminUpdateWebUser(env, {
        userId: targetUserId,
        displayName: body.displayName,
        password: body.password,
        role: body.role,
        banned: body.banned
      });
      const reg = await getTelegramAuthRegistry(env);
      const webUsers = await listRegisteredWebUsers(env);
      return jsonResponse({
        ok: true,
        user: updated,
        webUsers,
        allUsers: Object.values(reg.users).sort((a, b) =>
          (b.linkedAt || '').localeCompare(a.linkedAt || '')
        )
      });
    }

    if (action === 'admin_delete_web_user') {
      if (!webUser.isAdmin) {
        return jsonResponse({ ok: false, error: 'Admin privileges required' }, 403);
      }
      const targetUserId = String(body.userId || '').trim();
      if (!targetUserId) {
        return jsonResponse({ ok: false, error: 'Missing userId' }, 400);
      }
      if (targetUserId === webUser.id) {
        return jsonResponse({ ok: false, error: 'You cannot delete your own Admin account' }, 400);
      }
      await adminDeleteWebUser(env, targetUserId);
      const reg = await getTelegramAuthRegistry(env);
      const webUsers = await listRegisteredWebUsers(env);
      return jsonResponse({
        ok: true,
        webUsers,
        allUsers: Object.values(reg.users).sort((a, b) =>
          (b.linkedAt || '').localeCompare(a.linkedAt || '')
        )
      });
    }

    if (action === 'generate_code') {
      const codeObj = await generateTelegramLinkCode(env, {
        supabaseUserId: webUser.id,
        email: webUser.email,
        displayName: webUser.displayName,
        isAdmin: webUser.isAdmin
      });
      return jsonResponse({
        ok: true,
        botUsername: BOT_USERNAME,
        code: codeObj.code,
        expiresAt: codeObj.expiresAt,
        deepLink: `https://t.me/${BOT_USERNAME}?start=link_${codeObj.code}`
      });
    }

    if (action === 'unlink') {
      const targetTgId = body.telegramUserId ? Number(body.telegramUserId) : undefined;
      const reg = await getTelegramAuthRegistry(env);
      if (targetTgId) {
        const target = reg.users[String(targetTgId)];
        if (!target) {
          return jsonResponse({ ok: false, error: 'Telegram user not found' }, 404);
        }
        if (!webUser.isAdmin && target.supabaseUserId !== webUser.id) {
          return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
        }
        await unlinkTelegramUser(env, { telegramUserId: targetTgId });
      } else {
        await unlinkTelegramUser(env, { supabaseUserId: webUser.id });
      }
      return jsonResponse({ ok: true });
    }

    if (action === 'admin_set_status') {
      if (!webUser.isAdmin) {
        return jsonResponse({ ok: false, error: 'Admin privileges required' }, 403);
      }
      const targetTgId = Number(body.telegramUserId);
      if (!targetTgId) {
        return jsonResponse({ ok: false, error: 'Invalid telegramUserId' }, 400);
      }
      const status: 'approved' | 'revoked' | 'pending' =
        body.status === 'revoked' ? 'revoked' : body.status === 'pending' ? 'pending' : 'approved';
      const role: 'admin' | 'inspector' = body.role === 'admin' ? 'admin' : 'inspector';
      const updated = await setTelegramUserStatus(
        env,
        targetTgId,
        status,
        role,
        webUser.displayName,
        {
          displayName: body.displayName,
          telegramUsername: body.telegramUsername
        }
      );

      if (env.TELEGRAM_BOT_TOKEN && updated.chatId) {
        if (status === 'approved') {
          await sendMessage(
            env.TELEGRAM_BOT_TOKEN,
            updated.chatId,
            `🎉 *Access Approved!*\n\n` +
              `Your Telegram account has been authorized for *ECIT Site Tracker* by *${webUser.displayName}*.\n` +
              `• *Role:* ${role === 'admin' ? '🛡️ Project Admin' : '👷 Site Inspector'}\n` +
              `• *Attribution Name:* ${updated.displayName}\n\n` +
              `Tap below to start browsing rooms or send a site update!`,
            { reply_markup: mainMenuKeyboard() }
          ).catch(() => {});
        } else if (status === 'revoked') {
          await sendMessage(
            env.TELEGRAM_BOT_TOKEN,
            updated.chatId,
            `🚫 Your Telegram access to *ECIT Site Tracker* has been revoked by an administrator.`
          ).catch(() => {});
        }
      }

      const reg = await getTelegramAuthRegistry(env);
      return jsonResponse({
        ok: true,
        user: updated,
        allUsers: Object.values(reg.users).sort((a, b) =>
          (b.linkedAt || '').localeCompare(a.linkedAt || '')
        )
      });
    }

    return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
  } catch (e: any) {
    return jsonResponse({ ok: false, error: e?.message || 'Server error' }, 500);
  }
}

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

function mainMenuKeyboard(isAdmin = false): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [
    [
      { text: '🧭 Browse Rooms', callback_data: 'b_lvl:all' },
      { text: '📊 Project Status', callback_data: 'b_stats:main' }
    ],
    [
      { text: '⚠️ Open Snags', callback_data: 'b_snags:0' },
      { text: '👤 My Account', callback_data: 'tg_acc:me' }
    ],
    [
      { text: '🌐 Open Web App', url: WEB_APP_BASE }
    ]
  ];
  if (isAdmin) {
    rows[2].unshift({ text: '🛡️ Telegram Users', callback_data: 'tg_adm:list:0' });
  }
  return { inline_keyboard: rows };
}

function buildAuthRequiredCard(
  tgUser?: { id?: number; username?: string; first_name?: string },
  existingUser?: TelegramAuthorizedUser | null
): { text: string; keyboard: TelegramInlineKeyboardMarkup } {
  const isPending = existingUser?.status === 'pending';
  const isRevoked = existingUser?.status === 'revoked';

  const statusBanner = isPending
    ? `⏳ *Status:* Your access request is *pending Admin approval*.\n\n`
    : isRevoked
    ? `🚫 *Status:* Your Telegram access was revoked by an administrator.\n\n`
    : '';

  const text =
    `🔒 *ECIT Site Tracker — Authentication Required*\n\n` +
    statusBanner +
    `To view or update site records via Telegram, authenticate using any of these methods:\n\n` +
    `1️⃣ *Link via Web App (Recommended):*\n` +
    `Open the [ECIT Web App](${WEB_APP_BASE}) ➔ *Account* ➔ *Link Telegram Bot*, then tap *Open in Telegram* or send:\n` +
    `\`/auth <6-digit-code>\`\n\n` +
    `2️⃣ *Sign In with Web App Account:*\n` +
    `\`/login your@email.com yourpassword\`\n` +
    `_(Your password message is automatically deleted immediately)_\n\n` +
    `3️⃣ *Project Invitation Code:*\n` +
    `\`/auth <INVITE_CODE>\`\n\n` +
    `4️⃣ *Or Request Admin Approval:*\n` +
    `Tap *🙋 Request Access* below (Telegram ID: \`${tgUser?.id || 'unknown'}\`).`;

  const buttons: TelegramInlineKeyboardButton[][] = [];
  if (!isPending) {
    buttons.push([{ text: '🙋 Request Access from Admin', callback_data: 'tg_req:ask' }]);
  } else {
    buttons.push([{ text: '🔄 Check Approval Status', callback_data: 'tg_req:check' }]);
  }
  buttons.push([{ text: '🌐 Open Web App Account', url: WEB_APP_BASE }]);

  return {
    text,
    keyboard: { inline_keyboard: buttons }
  };
}

function buildAccountCard(authUser: TelegramAuthorizedUser): {
  text: string;
  keyboard: TelegramInlineKeyboardMarkup;
} {
  const roleBadge = authUser.role === 'admin' ? '🛡️ Project Admin' : '👷 Site Inspector';
  const methodLabel =
    authUser.authMethod === 'web_link'
      ? 'Web App Account Link'
      : authUser.authMethod === 'supabase_login'
      ? 'Web App Email & Password'
      : authUser.authMethod === 'invite_code'
      ? 'Project Invitation Code'
      : 'Admin Approval';

  const text =
    `👤 *Authenticated Telegram Account*\n\n` +
    `• *Name:* *${authUser.displayName || 'Inspector'}*\n` +
    (authUser.email ? `• *Web Account:* \`${authUser.email}\`\n` : '') +
    `• *Telegram:* ${authUser.telegramUsername ? `@${authUser.telegramUsername}` : '—'} (\`${authUser.telegramUserId}\`)\n` +
    `• *Role:* ${roleBadge}\n` +
    `• *Auth Method:* ${methodLabel}\n` +
    `• *Linked:* ${authUser.linkedAt ? authUser.linkedAt.slice(0, 10) : 'Active'}\n\n` +
    `_All room finish updates, photos, and snags you send are logged under your name._`;

  const rows: TelegramInlineKeyboardButton[][] = [
    [
      { text: '🧭 Browse Rooms', callback_data: 'b_lvl:all' },
      { text: '📊 Project Status', callback_data: 'b_stats:main' }
    ]
  ];
  if (authUser.role === 'admin') {
    rows.push([{ text: '🛡️ Manage Telegram Users', callback_data: 'tg_adm:list:0' }]);
  }
  rows.push([{ text: '🔓 Unlink / Sign Out', callback_data: 'tg_unlk:me' }]);

  return { text, keyboard: { inline_keyboard: rows } };
}

async function buildAdminUsersCard(env: Env): Promise<{
  text: string;
  keyboard: TelegramInlineKeyboardMarkup;
}> {
  const reg = await getTelegramAuthRegistry(env);
  const all = Object.values(reg.users).sort((a, b) => {
    const order: Record<string, number> = { pending: 0, approved: 1, revoked: 2 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.linkedAt || '').localeCompare(a.linkedAt || '');
  });

  const pendingCount = all.filter(u => u.status === 'pending').length;
  const approvedCount = all.filter(u => u.status === 'approved').length;

  let lines =
    `🛡️ *Telegram User Access Manager*\n` +
    `Approved: *${approvedCount}* · Pending: *${pendingCount}* · Total: *${all.length}*\n\n`;

  const rows: TelegramInlineKeyboardButton[][] = [];

  if (!all.length) {
    lines += `_No Telegram users registered yet._`;
  } else {
    for (const u of all.slice(0, 10)) {
      const icon = u.status === 'approved' ? (u.role === 'admin' ? '🛡️' : '✅') : u.status === 'pending' ? '⏳' : '🚫';
      const handle = u.telegramUsername ? `@${u.telegramUsername}` : `#${u.telegramUserId}`;
      const roleTag = u.role === 'admin' ? 'ADMIN' : 'INSPECTOR';
      lines += `${icon} *${u.displayName || handle}* (${handle}) — \`${u.status.toUpperCase()}\` · ${roleTag}\n`;

      if (u.status === 'pending') {
        rows.push([
          { text: `✅ Approve ${handle}`, callback_data: `tg_adm:app:${u.telegramUserId}` },
          { text: `🛡️ Admin ${handle}`, callback_data: `tg_adm:adm:${u.telegramUserId}` },
          { text: `🚫 Reject`, callback_data: `tg_adm:rev:${u.telegramUserId}` }
        ]);
      } else if (u.status === 'approved') {
        const toggleRole = u.role === 'admin' ? 'app' : 'adm';
        const toggleLabel = u.role === 'admin' ? `👷 Make Inspector (${handle})` : `🛡️ Make Admin (${handle})`;
        rows.push([
          { text: toggleLabel, callback_data: `tg_adm:${toggleRole}:${u.telegramUserId}` },
          { text: `🚫 Revoke ${handle}`, callback_data: `tg_adm:rev:${u.telegramUserId}` }
        ]);
      } else {
        rows.push([
          { text: `✅ Re-Approve ${handle}`, callback_data: `tg_adm:app:${u.telegramUserId}` }
        ]);
      }
    }
  }

  rows.push([
    { text: '🔄 Refresh List', callback_data: 'tg_adm:list:0' },
    { text: '🏠 Main Menu', callback_data: 'b_stats:main' }
  ]);

  return { text: lines, keyboard: { inline_keyboard: rows } };
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
  const tgFrom = message.from || { id: chatId, first_name: 'User' };
  const tgUserId = Number(tgFrom.id || chatId);

  // 1. Check /start deep-link pairing code: `/start link_123456` or `/start 123456`
  if (text.startsWith('/start')) {
    await setMyCommands(token).catch(() => {});
    const startArg = text.replace(/^\/start(?:@\w+)?\s*/i, '').trim();
    if (startArg && (/^link_\d{6}$/i.test(startArg) || /^\d{6}$/.test(startArg))) {
      const linked = await consumeTelegramLinkCode(env, startArg, tgFrom, chatId);
      if (linked.ok && linked.user) {
        await sendMessage(
          token,
          chatId,
          `✅ *Telegram Account Linked Successfully!*\n\n` +
            `• *Account:* *${linked.user.displayName}* (${linked.user.email})\n` +
            `• *Role:* ${linked.user.role === 'admin' ? '🛡️ Project Admin' : '👷 Site Inspector'}\n\n` +
            `You can now send site updates, photos, or browse rooms below:`,
          { reply_markup: mainMenuKeyboard(linked.user.role === 'admin') }
        );
        return;
      } else {
        await sendMessage(
          token,
          chatId,
          `⚠️ *Link Code Error:* ${linked.error || 'Invalid or expired code.'}`
        );
      }
    } else if (startArg) {
      const inv = await authenticateWithInviteCode(env, startArg, tgFrom, chatId);
      if (inv.ok && inv.user) {
        await sendMessage(
          token,
          chatId,
          `✅ *Authenticated via Invitation Code!*\n\n` +
            `• *Name:* *${inv.user.displayName}*\n` +
            `• *Role:* ${inv.user.role === 'admin' ? '🛡️ Project Admin' : '👷 Site Inspector'}`,
          { reply_markup: mainMenuKeyboard(inv.user.role === 'admin') }
        );
        return;
      }
    }
  }

  // 2. Command: /login <email> <password>
  if (/^\/login(?:@\w+)?(\s|$)/i.test(text)) {
    // Immediately delete the message containing the password for security
    if (message.message_id) {
      await deleteMessage(token, chatId, message.message_id).catch(() => {});
    }
    const args = text.replace(/^\/login(?:@\w+)?\s*/i, '').trim();
    const spaceIdx = args.indexOf(' ');
    if (!args || spaceIdx === -1) {
      await sendMessage(
        token,
        chatId,
        `🔑 *Sign In with ECIT Web App Account*\n\n` +
          `Send your email and password in this format:\n` +
          `\`/login engineer@saleh.com yourpassword\`\n\n` +
          `_(Your message with the password will be automatically deleted immediately.)_`
      );
      return;
    }
    const email = args.slice(0, spaceIdx).trim();
    const password = args.slice(spaceIdx + 1).trim();
    const res = await authenticateWithSupabaseLogin(env, email, password, tgFrom, chatId);
    if (res.ok && res.user) {
      await sendMessage(
        token,
        chatId,
        `✅ *Signed In & Linked Successfully!*\n\n` +
          `• *Account:* *${res.user.displayName}* (\`${res.user.email}\`)\n` +
          `• *Role:* ${res.user.role === 'admin' ? '🛡️ Project Admin' : '👷 Site Inspector'}\n\n` +
          `Your password message was deleted for security. Use the menu below to get started:`,
        { reply_markup: mainMenuKeyboard(res.user.role === 'admin') }
      );
    } else {
      await sendMessage(
        token,
        chatId,
        `❌ *Sign In Failed:* ${res.error || 'Invalid credentials.'}\n\n` +
          `Please check your email and password, or generate a 6-digit Link Code in the [ECIT Web App](${WEB_APP_BASE}).`
      );
    }
    return;
  }

  // 3. Command: /auth <link_code_or_invite_code>
  if (/^\/auth(?:@\w+)?(\s|$)/i.test(text)) {
    const codeArg = text.replace(/^\/auth(?:@\w+)?\s*/i, '').trim();
    if (!codeArg) {
      const existing = await getAuthorizedTelegramUser(env, tgUserId);
      if (existing && existing.status === 'approved') {
        const card = buildAccountCard(existing);
        await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
      } else {
        const card = buildAuthRequiredCard(tgFrom, existing);
        await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
      }
      return;
    }

    // Try 6-digit Web App link code first
    const cleanedCode = codeArg.replace(/^link_/i, '').replace(/^TG-/i, '').trim();
    if (/^\d{6}$/.test(cleanedCode)) {
      const linked = await consumeTelegramLinkCode(env, cleanedCode, tgFrom, chatId);
      if (linked.ok && linked.user) {
        await sendMessage(
          token,
          chatId,
          `✅ *Telegram Account Linked!*\n\n` +
            `• *Account:* *${linked.user.displayName}* (\`${linked.user.email}\`)\n` +
            `• *Role:* ${linked.user.role === 'admin' ? '🛡️ Project Admin' : '👷 Site Inspector'}`,
          { reply_markup: mainMenuKeyboard(linked.user.role === 'admin') }
        );
      } else {
        await sendMessage(
          token,
          chatId,
          `❌ *Link Code Failed:* ${linked.error || 'Invalid or expired 6-digit code.'}`
        );
      }
      return;
    }

    // Otherwise try Project Invitation Code
    const inv = await authenticateWithInviteCode(env, codeArg, tgFrom, chatId);
    if (inv.ok && inv.user) {
      await sendMessage(
        token,
        chatId,
        `✅ *Authenticated with Invitation Code!*\n\n` +
          `• *Name:* *${inv.user.displayName}*\n` +
          `• *Role:* ${inv.user.role === 'admin' ? '🛡️ Project Admin' : '👷 Site Inspector'}`,
        { reply_markup: mainMenuKeyboard(inv.user.role === 'admin') }
      );
    } else {
      await sendMessage(
        token,
        chatId,
        `❌ *Invalid Code:* \`${codeArg}\` is not a valid 6-digit Web App Link Code or Project Invitation Code.`
      );
    }
    return;
  }

  // 4. Command: /logout or /unlink
  if (/^\/(logout|unlink)(?:@\w+)?(\s|$)/i.test(text)) {
    const removed = await unlinkTelegramUser(env, { telegramUserId: tgUserId });
    await sendMessage(
      token,
      chatId,
      removed
        ? `🔓 *Signed Out:* Your Telegram account has been unlinked from ECIT Site Tracker.`
        : `ℹ️ Your Telegram account is not currently linked.`
    );
    return;
  }

  // 5. Check current user authorization status
  let authUser = await getAuthorizedTelegramUser(env, tgUserId);

  // If unauthenticated and user sent a raw 6-digit code or valid invite code directly, accept it!
  if (!authUser || authUser.status !== 'approved') {
    const rawTrimmed = text.replace(/^TG-/i, '').trim();
    if (/^\d{6}$/.test(rawTrimmed)) {
      const linked = await consumeTelegramLinkCode(env, rawTrimmed, tgFrom, chatId);
      if (linked.ok && linked.user) {
        await sendMessage(
          token,
          chatId,
          `✅ *Telegram Account Linked!*\n\n` +
            `• *Account:* *${linked.user.displayName}* (\`${linked.user.email}\`)\n` +
            `• *Role:* ${linked.user.role === 'admin' ? '🛡️ Project Admin' : '👷 Site Inspector'}`,
          { reply_markup: mainMenuKeyboard(linked.user.role === 'admin') }
        );
        return;
      }
    } else if (text && !text.startsWith('/')) {
      const inv = await authenticateWithInviteCode(env, text, tgFrom, chatId);
      if (inv.ok && inv.user) {
        await sendMessage(
          token,
          chatId,
          `✅ *Authenticated with Invitation Code!*\n\n` +
            `• *Name:* *${inv.user.displayName}*\n` +
            `• *Role:* ${inv.user.role === 'admin' ? '🛡️ Project Admin' : '👷 Site Inspector'}`,
          { reply_markup: mainMenuKeyboard(inv.user.role === 'admin') }
        );
        return;
      }
    }

    const card = buildAuthRequiredCard(tgFrom, authUser);
    await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
    return;
  }

  const isAdmin = authUser.role === 'admin';
  const authorLabel = formatTelegramAuthorLabel(authUser, tgFrom);

  // Command: /whoami or /account
  if (/^\/(whoami|account)(?:@\w+)?(\s|$)/i.test(text)) {
    const card = buildAccountCard(authUser);
    await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
    return;
  }

  // Command: /users (Admin only)
  if (/^\/users(?:@\w+)?(\s|$)/i.test(text)) {
    if (!isAdmin) {
      await sendMessage(token, chatId, `⚠️ Only Project Admins can manage Telegram users.`);
      return;
    }
    const card = await buildAdminUsersCard(env);
    await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
    return;
  }

  // Command: /start or /menu
  if (text.startsWith('/start') || text.startsWith('/menu')) {
    await setMyCommands(token).catch(() => {});
    const welcome =
      `🏗️ *ECIT Site Tracker Assistant*\n` +
      `👤 Signed in as: *${authUser.displayName}* (${isAdmin ? '🛡️ Admin' : '👷 Inspector'})\n\n` +
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
      `• \`/photos <code>\` — View stored room photos\n` +
      `• \`/whoami\` — View linked account & role`;
    await sendMessage(token, chatId, welcome, { reply_markup: mainMenuKeyboard(isAdmin) });
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
      `5️⃣ *Account & Security:* Use \`/whoami\` to view your linked ECIT account or \`/logout\` to unlink.`;
    await sendMessage(token, chatId, help, { reply_markup: mainMenuKeyboard(isAdmin) });
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
      const microLib = await fetchMicroTaskLibrary(env);
      const card = buildRoomDashboardCard(room, microLib);
      await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  if (!text && (!message.photo || message.photo.length === 0)) {
    return;
  }

  // Check if user replied to a previous bot message mentioning a room code (e.g., G-008, GF-008, F1-040C, F3-98)
  let replyContextCode: string | null = null;
  const replyText = message.reply_to_message?.text || message.reply_to_message?.caption || '';
  if (replyText) {
    const m = replyText.match(/\b(G(?:F)?-\d{1,4}[A-Z]?|F[1-8]-\d{1,4}[A-Z]?)\b/i);
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
    const microLib = await fetchMicroTaskLibrary(env);
    const parsed = await analyzeSiteUpdate(env, effectiveText, photoBytes,microLib);

    const actionId = Math.random().toString(36).substring(2, 10);
    const pendingAction: PendingAction = {
      id: actionId,
      chatId,
      telegramUserId: tgUserId,
      telegramUsername: authorLabel,
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

function buildRoomDashboardCard(
  room: Room,
  microLib?: MicroTaskLibrary
): { text: string; keyboard: TelegramInlineKeyboardMarkup } {
  const title = formatRoomTitle(room);
  const checkEntries = Object.entries(room.checks || {});
  const codesWithPrep: Array<{ code: string; doneCount: number; totalCount: number }> = [];

  const checksLines = checkEntries.length
    ? checkEntries
        .map(([c, st]) => {
          const micros = getRoomFinishMicroTasks(room, c, microLib);
          let prepTag = '';
          if (micros.length > 0) {
            const doneM = micros.filter(m => m.status === 'done').length;
            prepTag = ` _(🔧 Prep: ${doneM}/${micros.length})_`;
            codesWithPrep.push({ code: c, doneCount: doneM, totalCount: micros.length });
          }
          return `  ${statusEmoji(st)} \`${c}\` · ${finishShortDesc(c)} — *${st.toUpperCase()}*${prepTag}`;
        })
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
    `\n\n💡 _Tap any finish below to cycle status (Pending ➔ Ongoing ➔ Done), tap 🔧 Prep to manage micro-tasks, or reply with a photo/note!_`;

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

  // 1-Tap Prep Steps (Micro-tasks) buttons for finishes that have prep tasks
  if (codesWithPrep.length > 0) {
    const prepBtns: TelegramInlineKeyboardButton[] = codesWithPrep.slice(0, 6).map(item => ({
      text: `🔧 ${item.code} Prep (${item.doneCount}/${item.totalCount})`,
      callback_data: `b_prep:${room.id}:${item.code}`
    }));
    for (let i = 0; i < prepBtns.length; i += 2) {
      rows.push(prepBtns.slice(i, i + 2));
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

function buildRoomPrepCard(
  room: Room,
  finishCode: string,
  microLib: MicroTaskLibrary
): { text: string; keyboard: TelegramInlineKeyboardMarkup } {
  const title = formatRoomTitle(room);
  const finishSt = room.checks?.[finishCode] || 'pending';
  const micros = getRoomFinishMicroTasks(room, finishCode, microLib);
  const doneCount = micros.filter(m => m.status === 'done').length;

  const microLines = micros.length
    ? micros
        .map(m => `  ${statusEmoji(m.status)} *${m.name}* — \`${m.status.toUpperCase()}\``)
        .join('\n')
    : '  _No preparatory micro-tasks defined for this finish code._';

  const text =
    `🔧 *Prep Steps (Micro-Tasks)*\n` +
    `🏠 *${title}*\n` +
    `🎨 *Finish:* ${formatFinishLine(finishCode)} — *${finishSt.toUpperCase()}*\n` +
    `📊 *Prep Progress:* *${doneCount} / ${micros.length} Done*\n\n` +
    `${microLines}\n\n` +
    `💡 _Tap any prep step below to cycle its status (Pending ➔ Ongoing ➔ Done). Completing prep steps marks the main finish Ongoing (not Done)._`;

  const rows: TelegramInlineKeyboardButton[][] = [];

  for (let i = 0; i < micros.length; i += 2) {
    const pair = micros.slice(i, i + 2).map(m => ({
      text: `${statusEmoji(m.status)} ${m.name}`.slice(0, 36),
      callback_data: `qmic:${room.id}:${finishCode}:${m.id}`
    }));
    rows.push(pair);
  }

  if (micros.length > 0 && doneCount < micros.length) {
    rows.push([
      {
        text: `✅ Pass All Prep (${finishCode})`,
        callback_data: `qmicall:${room.id}:${finishCode}`
      }
    ]);
  }

  rows.push([
    {
      text: `${statusEmoji(finishSt)} Main ${finishCode}: ${finishSt.toUpperCase()} (Tap to cycle)`,
      callback_data: `qfin:${room.id}:${finishCode}`
    }
  ]);

  rows.push([
    { text: '⬅️ Back to Room Card', callback_data: `b_rm:${room.id}` }
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
  const [resolved, microLib] = await Promise.all([
    resolveRoomCandidates(env, action),
    fetchMicroTaskLibrary(env)
  ]);

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
  const microStr = parsed.microTask
    ? `• *Prep Step:* 🔧 "${parsed.microTask.name}"${parsed.finishCode ? ` [${parsed.finishCode}]` : ''} ➔ *${(parsed.status || 'done').toUpperCase()}*\n`
    : '';
  const notesLine = parsed.notes ? `• *Note:* _${parsed.notes}_\n` : '';
  const engineLabel =
    parsed.aiEngine?.startsWith('Gemini')
      ? `✨ ${parsed.aiEngine}`
      : parsed.aiEngine?.startsWith('Cloudflare AI')
        ? `☁️ ${parsed.aiEngine}`
        : '⚡ Heuristic';
  const engineLine = `• *Parser:* *${engineLabel}*\n`;

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
      engineLine +
      `• *Detected Space:* ${parsed.spaceCode || parsed.space || 'Unspecified'}\n` +
      (parsed.finishCode
        ? `• *Finish:* ${formatFinishLine(parsed.finishCode)} ${parsed.status ? `➔ *${parsed.status.toUpperCase()}*` : ''}\n`
        : '') +
      snagLine +
      microStr +
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
      engineLine +
      `• *Level:* *${levelStr}*\n` +
      `• *Detected Space:* ${parsed.spaceCode || parsed.space || 'Unspecified'}\n` +
      (parsed.finishCode
        ? `• *Finish:* ${formatFinishLine(parsed.finishCode)} ${parsed.status ? `➔ *${parsed.status.toUpperCase()}*` : ''}\n`
        : '') +
      snagLine +
      microStr +
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
      engineLine +
      (parsed.space ? `• *Searched Space:* \`${parsed.space}\`\n` : '') +
      (parsed.finishCode
        ? `• *Finish:* ${formatFinishLine(parsed.finishCode)} ${parsed.status ? `➔ *${parsed.status.toUpperCase()}*` : ''}\n`
        : '') +
      snagLine +
      microStr +
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

  const room = resolved.exact;
  alignParsedWithRoom(room, parsed, microLib);

  // ================= OPTIONAL: PICK PREP STEP (MICRO-TASK) =================
  if (mode === 'pick_micro') {
    const roomCodes = Object.keys(room.checks || {});
    const targetCodes =
      parsed.finishCode && parsed.finishCode !== 'ALL' && roomCodes.includes(parsed.finishCode)
        ? [parsed.finishCode, ...roomCodes.filter(c => c !== parsed.finishCode)]
        : roomCodes;

    const options: Array<{ code: string; id: string; name: string; status: Status }> = [];
    const seen = new Set<string>();

    for (const c of targetCodes) {
      const micros = getRoomFinishMicroTasks(room, c, microLib);
      for (const m of micros) {
        const key = `${c}|${m.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          options.push({ code: c, id: m.id, name: m.name, status: m.status });
        }
      }
    }

    // Fallback to global library if room's finishes have no template steps yet
    if (options.length === 0 && microLib.library.length > 0) {
      const defaultCode =
        parsed.finishCode && parsed.finishCode !== 'ALL'
          ? parsed.finishCode
          : roomCodes[0] || '';
      for (const m of microLib.library.slice(0, 14)) {
        options.push({
          code: defaultCode,
          id: m.id,
          name: m.name,
          status: (defaultCode && room.steps?.[defaultCode]?.[m.id]) || 'pending'
        });
      }
    }

    const microRows: TelegramInlineKeyboardButton[][] = [];
    for (let i = 0; i < Math.min(options.length, 16); i += 2) {
      const pair = options.slice(i, i + 2).map(opt => {
        const isSelected =
          parsed.microTask?.id === opt.id &&
          (!parsed.finishCode || parsed.finishCode === opt.code);
        const prefix = isSelected ? '🎯 ' : `${statusEmoji(opt.status)} `;
        const codeTag = opt.code ? ` [${opt.code}]` : '';
        return {
          text: `${prefix}${opt.name}${codeTag}`.slice(0, 42),
          callback_data: `smicro:${action.id}:${opt.code}|${opt.id}`
        };
      });
      microRows.push(pair);
    }

    if (parsed.microTask) {
      microRows.push([
        {
          text: '🚫 Clear Prep Step (Update Main Finish)',
          callback_data: `tmicro:${action.id}:clear`
        }
      ]);
    }
    microRows.push([{ text: '⬅️ Back to Confirm', callback_data: `mode:${action.id}:confirm` }]);

    const text =
      `🔧 *Select Prep Step (Micro-Task)*\n\n` +
      `• *Room:* *${formatRoomTitle(room)}*\n` +
      (parsed.finishCode ? `• *Finish:* ${formatFinishLine(parsed.finishCode)}\n` : '') +
      (parsed.microTask ? `• *Selected Prep:* 🔧 *${parsed.microTask.name}*\n` : '') +
      `\n👇 *Tap a preparatory step to update its status (or clear to update the main finish):*`;

    return {
      text,
      keyboard: { inline_keyboard: microRows }
    };
  }

  // ================= STEP 4: CONFIRMATION & FINISH/STATUS/SNAG CONTROLS =================
  const roomLabel = formatRoomTitle(room);
  const roomCheckEntries = Object.entries(room.checks || {});
  const checksSummary = roomCheckEntries.length
    ? roomCheckEntries
        .map(([c, st]) => {
          const micros = getRoomFinishMicroTasks(room, c, microLib);
          const prepSuffix =
            micros.length > 0
              ? ` _(🔧 ${micros.filter(m => m.status === 'done').length}/${micros.length} prep)_`
              : '';
          return `  ${statusEmoji(st)} \`${c}\` · ${finishCompactName(c)} (*${st.toUpperCase()}*)${prepSuffix}`;
        })
        .join('\n')
    : '  _No finishes linked_';

  const updateTargetDisplay = parsed.microTask
    ? `🔧 *Prep "${parsed.microTask.name}"* ${parsed.finishCode ? `[${parsed.finishCode}]` : ''} ➔ *${(parsed.status || 'done').toUpperCase()}* _(sets finish to Ongoing if Pending)_`
    : parsed.finishCode
      ? `${formatFinishLine(parsed.finishCode)} ➔ *${(parsed.status || 'select status below').toUpperCase()}*${parsed.status === 'done' ? ' _(auto-completes micro-tasks)_' : ''}`
      : '_Tap a finish or prep step below (optional)_';

  const text =
    `📋 *Confirm Room Update*\n\n` +
    engineLine +
    `• *Room:* *${roomLabel}*\n` +
    `• *Current Finishes:*\n${checksSummary}\n` +
    `• *${parsed.microTask ? 'Prep Update' : 'Finish Update'}:* ${updateTargetDisplay}\n` +
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

  // Prep Step (Micro-task) selector row
  const microRow: TelegramInlineKeyboardButton[] = [];
  if (parsed.microTask) {
    microRow.push(
      {
        text: `🔧 Prep: ${parsed.microTask.name}`.slice(0, 32),
        callback_data: `mode:${action.id}:pick_micro`
      },
      {
        text: '❌ Clear Prep',
        callback_data: `tmicro:${action.id}:clear`
      }
    );
  } else {
    const activeCode =
      parsed.finishCode && parsed.finishCode !== 'ALL' ? parsed.finishCode : finishCodes[0] || '';
    const countForCode = activeCode
      ? getRoomFinishMicroTasks(room, activeCode, microLib).length
      : 0;
    if (countForCode > 0 || microLib.library.length > 0) {
      microRow.push({
        text: `🔧 Pick Prep Step${countForCode > 0 ? ` (${activeCode}: ${countForCode})` : ''}`,
        callback_data: `mode:${action.id}:pick_micro`
      });
    }
  }
  if (microRow.length > 0) {
    keyboardRows.push(microRow);
  }

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
  const tgFrom = query.from || { id: chatId, first_name: 'User' };
  const tgUserId = Number(tgFrom.id || chatId);

  if (!data.includes(':')) {
    await answerCallbackQuery(token, query.id);
    return;
  }

  const parts = data.split(':');
  const actionType = parts[0];
  const actionId = parts[1];
  const value = parts.slice(2).join(':');

  // --- Access Request Callbacks (allowed before approval) ---
  if (actionType === 'tg_req') {
    if (actionId === 'ask') {
      const { user, adminChatIds } = await requestTelegramAccess(env, tgFrom, chatId);
      await answerCallbackQuery(token, query.id, 'Access request sent to Project Admins ✅');
      const card = buildAuthRequiredCard(tgFrom, user);
      if (chatId && messageId) {
        await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
      }
      // Notify any Telegram admins
      const handle = user.telegramUsername ? `@${user.telegramUsername}` : `#${user.telegramUserId}`;
      for (const adminChatId of adminChatIds) {
        if (adminChatId === chatId) continue;
        await sendMessage(
          token,
          adminChatId,
          `🔔 *New Telegram Access Request*\n\n` +
            `• *Name:* *${user.displayName}*\n` +
            `• *Username:* ${handle}\n` +
            `• *Telegram ID:* \`${user.telegramUserId}\`\n\n` +
            `Approve or reject below:`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Approve (Inspector)', callback_data: `tg_adm:app:${user.telegramUserId}` },
                  { text: '🛡️ Approve (Admin)', callback_data: `tg_adm:adm:${user.telegramUserId}` }
                ],
                [
                  { text: '🚫 Reject', callback_data: `tg_adm:rev:${user.telegramUserId}` }
                ]
              ]
            }
          }
        ).catch(() => {});
      }
      return;
    }

    if (actionId === 'check') {
      const current = await getAuthorizedTelegramUser(env, tgUserId);
      if (current && current.status === 'approved') {
        await answerCallbackQuery(token, query.id, 'Approved! Welcome ✅');
        const card = buildAccountCard(current);
        if (chatId && messageId) {
          await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
        }
      } else {
        await answerCallbackQuery(token, query.id, 'Still pending Admin approval ⏳', true);
      }
      return;
    }
  }

  // Enforce authentication for all other bot actions
  const authUser = await getAuthorizedTelegramUser(env, tgUserId);
  if (!authUser || authUser.status !== 'approved') {
    await answerCallbackQuery(token, query.id, '🔒 Authentication required', true);
    if (chatId) {
      const card = buildAuthRequiredCard(tgFrom, authUser);
      await sendMessage(token, chatId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  const authorName = formatTelegramAuthorLabel(authUser, tgFrom);

  // --- Account & Admin User Management Callbacks ---
  if (actionType === 'tg_acc') {
    await answerCallbackQuery(token, query.id);
    const card = buildAccountCard(authUser);
    if (chatId && messageId) {
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  if (actionType === 'tg_unlk') {
    await unlinkTelegramUser(env, { telegramUserId: tgUserId });
    await answerCallbackQuery(token, query.id, 'Account unlinked 🔓');
    if (chatId && messageId) {
      const card = buildAuthRequiredCard(tgFrom, null);
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  if (actionType === 'tg_adm') {
    if (authUser.role !== 'admin') {
      await answerCallbackQuery(token, query.id, 'Admin privileges required', true);
      return;
    }
    if (actionId === 'list') {
      await answerCallbackQuery(token, query.id);
      const card = await buildAdminUsersCard(env);
      if (chatId && messageId) {
        await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
      }
      return;
    }

    const targetId = Number(value);
    if (!targetId) {
      await answerCallbackQuery(token, query.id, 'Invalid user ID', true);
      return;
    }

    const newStatus = actionId === 'rev' ? 'revoked' : 'approved';
    const newRole = actionId === 'adm' ? 'admin' : 'inspector';
    const updated = await setTelegramUserStatus(
      env,
      targetId,
      newStatus,
      newRole,
      authUser.displayName || authorName
    );
    await answerCallbackQuery(
      token,
      query.id,
      newStatus === 'revoked'
        ? `Revoked #${targetId}`
        : `Approved #${targetId} (${newRole.toUpperCase()})`
    );

    if (updated.chatId) {
      if (newStatus === 'approved') {
        await sendMessage(
          token,
          updated.chatId,
          `🎉 *Access Approved!*\n\n` +
            `Your Telegram account has been authorized for *ECIT Site Tracker*.\n` +
            `• *Role:* ${newRole === 'admin' ? '🛡️ Project Admin' : '👷 Site Inspector'}`,
          { reply_markup: mainMenuKeyboard(newRole === 'admin') }
        ).catch(() => {});
      } else {
        await sendMessage(
          token,
          updated.chatId,
          `🚫 Your Telegram access to *ECIT Site Tracker* has been revoked.`
        ).catch(() => {});
      }
    }

    const card = await buildAdminUsersCard(env);
    if (chatId && messageId) {
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

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
    const [room, microLib] = await Promise.all([
      getRoomByIdOrCode(env, roomId),
      fetchMicroTaskLibrary(env)
    ]);
    if (room && chatId && messageId) {
      const card = buildRoomDashboardCard(room, microLib);
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  if (actionType === 'b_prep') {
    const roomId = actionId;
    const finishCode = value;
    await answerCallbackQuery(token, query.id, `Prep steps for ${finishCode}`);
    const [room, microLib] = await Promise.all([
      getRoomByIdOrCode(env, roomId),
      fetchMicroTaskLibrary(env)
    ]);
    if (room && chatId && messageId) {
      const card = buildRoomPrepCard(room, finishCode, microLib);
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    }
    return;
  }

  if (actionType === 'qmic') {
    const roomId = actionId;
    const [finishCode, ...microParts] = value.split(':');
    const microId = microParts.join(':');
    const updated = await quickCycleRoomMicro(env, roomId, finishCode, microId, authorName);
    if (updated && chatId && messageId) {
      await answerCallbackQuery(
        token,
        query.id,
        `🔧 ${updated.microName} [${finishCode}] → ${updated.nextStatus.toUpperCase()}`
      );
      const microLib = await fetchMicroTaskLibrary(env);
      const card = buildRoomPrepCard(updated.room, finishCode, microLib);
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    } else {
      await answerCallbackQuery(token, query.id, 'Could not update prep step', true);
    }
    return;
  }

  if (actionType === 'qmicall') {
    const roomId = actionId;
    const finishCode = value;
    const updated = await passAllRoomMicros(env, roomId, finishCode, authorName);
    if (updated && chatId && messageId) {
      await answerCallbackQuery(
        token,
        query.id,
        `✅ All ${updated.count} prep steps for ${finishCode} marked DONE!`
      );
      const microLib = await fetchMicroTaskLibrary(env);
      const card = buildRoomPrepCard(updated.room, finishCode, microLib);
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    } else {
      await answerCallbackQuery(token, query.id, 'Could not update prep steps', true);
    }
    return;
  }

  if (actionType === 'qfin') {
    const roomId = actionId;
    const finishCode = value;
    const [updated, microLib] = await Promise.all([
      quickCycleRoomFinish(env, roomId, finishCode, authorName),
      fetchMicroTaskLibrary(env)
    ]);
    if (updated && chatId && messageId) {
      await answerCallbackQuery(
        token,
        query.id,
        `${finishCode} (${finishCompactName(finishCode)}) → ${updated.nextStatus.toUpperCase()}`
      );
      const card = buildRoomDashboardCard(updated.room, microLib);
      await editMessageText(token, chatId, messageId, card.text, { reply_markup: card.keyboard });
    } else {
      await answerCallbackQuery(token, query.id, 'Could not update finish', true);
    }
    return;
  }

  if (actionType === 'qsnag') {
    const roomId = actionId;
    const snagId = value;
    const [res, microLib] = await Promise.all([
      closeRoomSnag(env, roomId, snagId, authorName),
      fetchMicroTaskLibrary(env)
    ]);
    if (res && chatId && messageId) {
      await answerCallbackQuery(token, query.id, 'Snag marked as Resolved ✅');
      const card = buildRoomDashboardCard(res.room, microLib);
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
    if (value === 'ALL') {
      pending.parsed.microTask = null;
    } else if (pending.parsed.microTask) {
      const microLib = await fetchMicroTaskLibrary(env);
      const tmpl = microLib.codeTemplates?.[value] || [];
      if (tmpl.length > 0 && !tmpl.includes(pending.parsed.microTask.id)) {
        pending.parsed.microTask = null;
      }
    }
    if (!pending.parsed.status) {
      pending.parsed.status = 'done';
    }
    pending.uiMode = 'confirm';
    await answerCallbackQuery(token, query.id, `${value} · ${finishCompactName(value)}`);
    await updateCardMessage(env, chatId, messageId, pending);
    return;
  }

  if (actionType === 'tmicro') {
    pending.parsed.microTask = null;
    pending.uiMode = 'confirm';
    await answerCallbackQuery(token, query.id, 'Prep step cleared (updating main finish)');
    await updateCardMessage(env, chatId, messageId, pending);
    return;
  }

  if (actionType === 'smicro') {
    const microLib = await fetchMicroTaskLibrary(env);
    const sepIdx = value.indexOf('|');
    const codePart = sepIdx >= 0 ? value.slice(0, sepIdx) : '';
    const microId = sepIdx >= 0 ? value.slice(sepIdx + 1) : value;
    if (!microId || microId === 'none') {
      pending.parsed.microTask = null;
    } else {
      const name = humanizeMicroId(microId, microLib);
      pending.parsed.microTask = { id: microId, name };
      if (codePart) {
        pending.parsed.finishCode = codePart;
      }
      if (!pending.parsed.status) {
        pending.parsed.status = 'done';
      }
    }
    pending.uiMode = 'confirm';
    await answerCallbackQuery(
      token,
      query.id,
      pending.parsed.microTask ? `🔧 Prep: ${pending.parsed.microTask.name}` : 'Main finish mode'
    );
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

      const finishOrMicroLine = result.appliedMicro
        ? `• *Prep Step:* 🔧 *${result.appliedMicro.name}*${result.appliedFinish ? ` [${result.appliedFinish}]` : ''} ➔ *${result.appliedMicro.status.toUpperCase()}*\n` +
          (result.appliedFinish
            ? `• *Main Finish:* ${formatFinishLine(result.appliedFinish)} — *${(result.room.checks?.[result.appliedFinish] || 'ongoing').toUpperCase()}*\n`
            : '')
        : result.appliedFinish && pending.parsed.status
          ? `• *Finish:* ${formatFinishLine(result.appliedFinish)} ➔ *${pending.parsed.status.toUpperCase()}*\n`
          : '';
      const snagLine = pending.parsed.snag
        ? `• *Snag Logged:* "${pending.parsed.snag.text}" (${pending.parsed.snag.trade})\n`
        : '';
      const photoLine = photoId ? `• *Storage Photo ID:* \`${photoId}\` (synced to web app)\n` : '';

      const successText =
        `✅ *Saved to ECIT Site Tracker!*\n\n` +
        `• *Room:* *${result.roomTitle}*\n` +
        finishOrMicroLine +
        snagLine +
        photoLine +
        `\n_Live synced with Supabase & ECIT Web App._`;

      const postButtons: TelegramInlineKeyboardButton[][] = [
        [
          { text: '🏠 Open Room Card', callback_data: `b_rm:${result.room.id}` },
          ...(result.appliedMicro && result.appliedFinish
            ? [{ text: `🔧 ${result.appliedFinish} Prep Steps`, callback_data: `b_prep:${result.room.id}:${result.appliedFinish}` }]
            : []),
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
    const microLib = await fetchMicroTaskLibrary(env);
    const card = buildRoomDashboardCard(room, microLib);
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
async function handleTestAiApi(request: Request, env: Env): Promise<Response> {
  // Optional security check: require Bearer token if not local dev
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token) {
    const webUser = await verifySupabaseUserFromToken(env, token);
    if (!webUser) {
      return jsonResponse({ ok: false, error: 'Invalid auth token' }, 401);
    }
  }

  let text = '';
  let photoBytes: Uint8Array | undefined = undefined;

  if (request.method === 'GET') {
    const url = new URL(request.url);
    text = url.searchParams.get('text') || url.searchParams.get('q') || '';
    const imageUrl = url.searchParams.get('imageUrl') || '';
    if (imageUrl) {
      try {
        const imgRes = await fetch(imageUrl);
        if (imgRes.ok) {
          photoBytes = new Uint8Array(await imgRes.arrayBuffer());
        }
      } catch (e: any) {
        return jsonResponse({ ok: false, error: `Failed to fetch test image: ${e?.message}` }, 400);
      }
    }
  }
  else if (request.method === 'POST') {
    try {
      const body: any = await request.json();
      text = String(body.text || body.prompt || '').trim();

      // Support base64 image data (e.g., from file uploads on the frontend)
      if (body.imageBase64) {
        const cleanBase64 = body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const binaryString = atob(cleanBase64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        photoBytes = bytes;
      } else if (body.imageUrl) {
        const imgRes = await fetch(body.imageUrl);
        if (imgRes.ok) {
          photoBytes = new Uint8Array(await imgRes.arrayBuffer());
        }
      }
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON request body' }, 400);
    }
  } else {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  if (!text && !photoBytes) {
    return jsonResponse({
      ok: false,
      error: 'Please supply "text", "imageUrl", or "imageBase64" in query parameters or POST body.'
    }, 400);
  }

  try {
    const start = performance.now();
    const microLib = await fetchMicroTaskLibrary(env).catch(() => undefined);
      const parsed  = await analyzeSiteUpdate(env, text, photoBytes, microLib);
    const durationMs = Math.round(performance.now() - start);

    // Optional: resolve candidate rooms against Supabase to see real matching
    const resolvedCandidates = await resolveRoomCandidates(env, {
      id: 'test',
      chatId: 0,
      telegramUserId: 0,
      parsed,

      createdAt: new Date().toISOString()
    }).catch(() => null);

    if (resolvedCandidates?.exact) {
      alignParsedWithRoom(resolvedCandidates.exact, parsed, microLib);
    }

    return jsonResponse({
      ok: true,
      durationMs,
      input: {
        text,
        hasPhoto: Boolean(photoBytes),
        photoSizeBytes: photoBytes ? photoBytes.byteLength : 0
      },
      parsed,
      resolutionPreview: resolvedCandidates ? {
        exactMatch: resolvedCandidates.exact ? formatRoomTitle(resolvedCandidates.exact) : null,
        exactMatchId: resolvedCandidates.exact?.id || null,
        candidateCount: resolvedCandidates.candidates.length,
        candidateCodes: resolvedCandidates.candidates.slice(0, 5).map(r => r.spaceCode || r.space)
      } : null
    });
  } catch (err: any) {
    return jsonResponse({
      ok: false,
      error: err?.message || 'Error executing analyzeSiteUpdate',
      stack: err?.stack
    }, 500);
  }
}
