export type Status = 'pending' | 'ongoing' | 'done' | 'unknown';

export interface Env {
  AI: any; // Cloudflare Workers AI binding
  TELEGRAM_BOT_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_BUCKET?: string;
  GEMINI_API_KEY?: string;
  WEBHOOK_SECRET?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  inline_message_id?: string;
  chat_instance: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface MicroTask {
  id: string;
  name: string;
}

export interface MicroTaskLibrary {
  library: MicroTask[];
  codeTemplates: Record<string, string[]>; // finishCode -> microTaskId[]
}

export interface ParsedSiteUpdate {
  level: number | null;
  zone: number | null;
  space: string | null;
  spaceNo: string | null;
  spaceCode: string | null;
  finishCode: string | null;
  finishKind: 'Floor' | 'Skirting' | 'Wall' | 'Ceiling' | null;
  status: Status | null;
  snag: {
    text: string;
    trade: string;
  } | null;
  notes: string;
  summary: string;
  // Micro-task update (optional – only set when engineer mentions a specific prep step)
  microTask?: {
    id: string;
    name: string;
  } | null;
    orginal?:any
}


export type BotUiMode =
  | 'auto'
  | 'confirm'
  | 'pick_level'
  | 'pick_zone'
  | 'pick_room'
  | 'pick_finish'
  | 'pick_trade'
  | 'pick_micro';

export interface RoomUndoSnapshot {
  roomId: string;
  notes: string;
  checks: Record<string, Status>;
  steps: Record<string, Record<string, Status>>;
  log: RoomLogEntry[];
  snags: RoomSnag[];
  photos: RoomPhoto[];
  uploadedPhotoId?: string;
}

export interface PendingAction {
  id: string;
  chatId: number;
  telegramUserId: number;
  telegramUsername?: string;
  parsed: ParsedSiteUpdate;
  selectedRoomId?: string;
  uiMode?: BotUiMode;
  roomPage?: number;
  photoFileId?: string;
  uploadedPhotoId?: string;
  createdAt: string;
}

export interface RoomSnag {
  id: string;
  text: string;
  trade: string;
  due: string;
  code: string;
  status: 'open' | 'closed';
  created: string;
  closed: string;
  photos: string[];
  pinX?: number;
  pinY?: number;
}

export interface RoomPhoto {
  id: string;
  ts: string;
  caption: string;
  code: string;
}

export interface RoomLogEntry {
  id: string;
  ts: string;
  text: string;
  by?: string;
}

export interface Room {
  id: string;
  level: number;
  zone: number;
  space: string;
  spaceNo: string;
  spaceCode: string;
  checks: Record<string, Status>;
  steps: Record<string, Record<string, Status>>;
  notes: string;
  log: RoomLogEntry[];
  snags: RoomSnag[];
  photos: RoomPhoto[];
  added: string;
  updated: string;
  pinX?: number;
  pinY?: number;
}

export interface TelegramAuthorizedUser {
  telegramUserId: number;
  telegramUsername?: string;
  firstName?: string;
  lastName?: string;
  chatId?: number;
  status: 'approved' | 'pending' | 'revoked';
  role: 'admin' | 'inspector';
  authMethod: 'web_link' | 'supabase_login' | 'invite_code' | 'admin_approved';
  supabaseUserId?: string;
  email?: string;
  displayName?: string;
  linkedAt: string;
  approvedBy?: string;
}

export interface TelegramLinkCode {
  code: string;
  supabaseUserId: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface TelegramAuthRegistry {
  users: Record<string, TelegramAuthorizedUser>;
  linkCodes: Record<string, TelegramLinkCode>;
}

export interface WebSiteUser {
  id: string;
  email: string;
  displayName: string;
  inviteCode?: string;
  isAdmin: boolean;
  isBanned: boolean;
  bannedUntil?: string | null;
  createdAt: string;
  lastSignInAt?: string | null;
  linkedTelegram?: {
    telegramUserId: number;
    telegramUsername?: string;
    status: string;
  } | null;
}
