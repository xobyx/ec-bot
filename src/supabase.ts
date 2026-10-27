import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env, PendingAction, Room, RoomPhoto, RoomSnag, RoomLogEntry } from './types';

export function getSupabase(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

/**
 * Saves a pending confirmation action into the existing `kv` table in Supabase.
 */
export async function savePendingAction(env: Env, action: PendingAction): Promise<void> {
  const sb = getSupabase(env);
  const key = `tg_pending:${action.id}`;
  const { error } = await sb.from('kv').upsert({
    k: key,
    v: action
  });
  if (error) {
    console.error('Error saving pending action to kv:', error);
    throw error;
  }
}

/**
 * Fetches a pending confirmation action from the `kv` table.
 */
export async function getPendingAction(env: Env, id: string): Promise<PendingAction | null> {
  const sb = getSupabase(env);
  const key = `tg_pending:${id}`;
  const { data, error } = await sb.from('kv').select('v').eq('k', key).maybeSingle();
  if (error || !data) return null;
  return data.v as PendingAction;
}

/**
 * Deletes a pending action after confirmation or cancellation.
 */
export async function deletePendingAction(env: Env, id: string): Promise<void> {
  const sb = getSupabase(env);
  const key = `tg_pending:${id}`;
  await sb.from('kv').delete().eq('k', key);
}

/**
 * Uploads photo bytes to Supabase Storage bucket (`photos`).
 * Returns the stored photo ID/filename.
 */
export async function uploadSitePhoto(
  env: Env,
  photoBytes: Uint8Array,
  filename: string
): Promise<string> {
  const sb = getSupabase(env);
  const bucket = env.SUPABASE_BUCKET || 'photos';
  const filePath = `site_updates/${Date.now()}_${filename}`;

  const { error } = await sb.storage.from(bucket).upload(filePath, photoBytes, {
    contentType: 'image/jpeg',
    upsert: true
  });

  if (error) {
    console.error('Supabase storage upload error:', error);
    throw error;
  }

  // Retrieve public URL or relative path
  const { data } = sb.storage.from(bucket).getPublicUrl(filePath);
  return data.publicUrl || filePath;
}

/**
 * Applies the confirmed update directly to the Supabase `rooms` table.
 */
export async function applyUpdateToRoom(
  env: Env,
  action: PendingAction,
  photoUrl?: string
): Promise<{ roomKey: string; roomTitle: string }> {
  const sb = getSupabase(env);
  const { parsed, telegramUsername } = action;

  const targetLevel = typeof parsed.level === 'number' ? parsed.level : 0;
  const targetSpaceNo = parsed.spaceNo || parsed.spaceCode || '';
  const targetSpace = parsed.space || (targetSpaceNo ? `ROOM ${targetSpaceNo}` : 'SPACE');
  const targetZone = typeof parsed.zone === 'number' ? parsed.zone : 0;
  const targetSpaceCode = parsed.spaceCode || targetSpaceNo;

  // Search existing rooms in Supabase matching this level and spaceNo
  let existingRoomRow: any = null;
  const { data: rows, error: searchError } = await sb
    .from('rooms')
    .select('*')
    .eq('level', targetLevel);

  if (!searchError && rows && rows.length > 0) {
    // Find matching room by spaceNo or spaceCode or space
    existingRoomRow = rows.find(
      (r: any) =>
        (targetSpaceNo && (r.space_no === targetSpaceNo || r.space_code === targetSpaceNo)) ||
        (targetSpace && r.space && r.space.toUpperCase().includes(targetSpace.toUpperCase()))
    );
  }

  const nowIso = new Date().toISOString();
  const author = telegramUsername ? `@${telegramUsername}` : 'Telegram Bot';

  let roomObj: Room;
  if (existingRoomRow) {
    roomObj = {
      id: existingRoomRow.id,
      level: existingRoomRow.level,
      zone: existingRoomRow.zone,
      space: existingRoomRow.space,
      spaceNo: existingRoomRow.space_no || '',
      spaceCode: existingRoomRow.space_code || '',
      notes: existingRoomRow.notes || '',
      checks: existingRoomRow.checks || {},
      steps: existingRoomRow.steps || {},
      log: Array.isArray(existingRoomRow.log) ? existingRoomRow.log : [],
      snags: Array.isArray(existingRoomRow.snags) ? existingRoomRow.snags : [],
      photos: Array.isArray(existingRoomRow.photos) ? existingRoomRow.photos : [],
      added: existingRoomRow.added || nowIso,
      updated: nowIso
    };
  } else {
    // Construct new room entry
    const newId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    roomObj = {
      id: newId,
      level: targetLevel,
      zone: targetZone,
      space: targetSpace,
      spaceNo: targetSpaceNo,
      spaceCode: targetSpaceCode,
      notes: '',
      checks: {},
      steps: {},
      log: [],
      snags: [],
      photos: [],
      added: nowIso,
      updated: nowIso
    };
  }

  // 1. Update finish check if provided
  if (parsed.finishCode && parsed.status) {
    roomObj.checks[parsed.finishCode] = parsed.status;
  }

  // 2. Add snag if detected
  if (parsed.snag) {
    const snagId = `snag_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newSnag: RoomSnag = {
      id: snagId,
      text: parsed.snag.text,
      trade: parsed.snag.trade || 'General',
      due: '',
      code: parsed.finishCode || '',
      status: 'open',
      created: nowIso,
      closed: '',
      photos: photoUrl ? [photoUrl] : []
    };
    roomObj.snags.push(newSnag);
  }

  // 3. Add photo if uploaded
  if (photoUrl) {
    const photoId = `photo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newPhoto: RoomPhoto = {
      id: photoId,
      ts: nowIso,
      caption: parsed.notes || 'Telegram site update',
      code: parsed.finishCode || ''
    };
    roomObj.photos.push(newPhoto);
  }

  // 4. Add log entry
  const logEntry: RoomLogEntry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ts: nowIso,
    text: parsed.summary || parsed.notes || 'Status updated via Telegram',
    by: author
  };
  roomObj.log.push(logEntry);

  // 5. Construct DB row
  const key = [roomObj.level, roomObj.zone, roomObj.space, roomObj.spaceNo || '', roomObj.spaceCode || ''].join('|');
  const dbRow = {
    key,
    id: roomObj.id,
    level: roomObj.level,
    zone: roomObj.zone,
    space: roomObj.space,
    space_no: roomObj.spaceNo || '',
    space_code: roomObj.spaceCode || '',
    notes: roomObj.notes || '',
    checks: roomObj.checks,
    steps: roomObj.steps,
    log: roomObj.log,
    snags: roomObj.snags,
    photos: roomObj.photos,
    added: roomObj.added,
    updated: nowIso
  };

  const { error: upsertError } = await sb.from('rooms').upsert([dbRow], { onConflict: 'key' });
  if (upsertError) {
    console.error('Supabase upsert error:', upsertError);
    throw upsertError;
  }

  return {
    roomKey: key,
    roomTitle: `L${roomObj.level} ${roomObj.spaceNo ? 'Room ' + roomObj.spaceNo : roomObj.space}`
  };
}
