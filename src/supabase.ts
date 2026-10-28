import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env, PendingAction, Room, RoomPhoto, RoomSnag, RoomLogEntry, Status } from './types';

export function getSupabase(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

export function generatePhotoId(): string {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function rowToRoom(r: any): Room {
  return {
    id: String(r.id || r.key || ''),
    level: typeof r.level === 'number' ? r.level : 0,
    zone: typeof r.zone === 'number' ? r.zone : 0,
    space: r.space || '',
    spaceNo: r.space_no || '',
    spaceCode: r.space_code || '',
    notes: r.notes || '',
    checks: r.checks && typeof r.checks === 'object' ? { ...r.checks } : {},
    steps: r.steps && typeof r.steps === 'object' ? { ...r.steps } : {},
    log: Array.isArray(r.log) ? [...r.log] : [],
    snags: Array.isArray(r.snags) ? [...r.snags] : [],
    photos: Array.isArray(r.photos) ? [...r.photos] : [],
    added: r.added || new Date().toISOString(),
    updated: r.updated || new Date().toISOString()
  };
}

/**
 * Saves a pending confirmation action into the `kv` table in Supabase.
 */
export async function savePendingAction(env: Env, action: PendingAction): Promise<void> {
  const sb = getSupabase(env);
  const key = `tg_pending:${action.id}`;
  const { error } = await sb.from('kv').upsert(
    {
      k: key,
      v: action,
      updated: new Date().toISOString()
    },
    { onConflict: 'k' }
  );
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
 * Uploads photo bytes to Supabase Storage bucket (`photos`) at root `${photoId}.jpg`
 * so the ECIT Site Tracker web app can load it directly by `photoId`.
 */
export async function uploadSitePhoto(
  env: Env,
  photoBytes: Uint8Array,
  photoId?: string
): Promise<{ photoId: string; publicUrl: string }> {
  const sb = getSupabase(env);
  const bucket = env.SUPABASE_BUCKET || 'photos';
  const id = photoId || generatePhotoId();
  const filePath = `${id}.jpg`;

  const { error } = await sb.storage.from(bucket).upload(filePath, photoBytes, {
    contentType: 'image/jpeg',
    upsert: true
  });

  if (error) {
    console.error('Supabase storage upload error:', error);
    throw error;
  }

  const { data } = sb.storage.from(bucket).getPublicUrl(filePath);
  return {
    photoId: id,
    publicUrl: data.publicUrl || filePath
  };
}

/**
 * Deletes an unconfirmed/cancelled photo from Supabase Storage (`photos`).
 */
export async function deleteSitePhoto(env: Env, photoId: string): Promise<void> {
  if (!photoId) return;
  const sb = getSupabase(env);
  const bucket = env.SUPABASE_BUCKET || 'photos';
  const filePath = `${photoId}.jpg`;
  await sb.storage.from(bucket).remove([filePath]).catch(() => {});
  try {
    await sb.from('photo_meta').delete().eq('id', photoId);
  } catch {}
}

/**
 * Returns the public URL for a stored photo ID (`${photoId}.jpg`).
 */
export function getPhotoPublicUrl(env: Env, photoId: string): string {
  const sb = getSupabase(env);
  const bucket = env.SUPABASE_BUCKET || 'photos';
  return sb.storage.from(bucket).getPublicUrl(`${photoId}.jpg`).data.publicUrl;
}

/**
 * Fetches a room by its primary key `id` or by exact `space_code`.
 */
export async function getRoomByIdOrCode(env: Env, idOrCode: string): Promise<Room | null> {
  if (!idOrCode) return null;
  const sb = getSupabase(env);

  const byIdRes = await sb.from('rooms').select('*').eq('id', idOrCode).maybeSingle();
  if (!byIdRes.error && byIdRes.data) {
    return rowToRoom(byIdRes.data);
  }

  const cleanCode = idOrCode.trim().toUpperCase();
  const byCodeRes = await sb.from('rooms').select('*').ilike('space_code', cleanCode).limit(1);
  if (!byCodeRes.error && byCodeRes.data && byCodeRes.data.length > 0) {
    return rowToRoom(byCodeRes.data[0]);
  }

  return null;
}

/**
 * Lists rooms for a given level and optional zone.
 */
export async function getRoomsForLevelZone(
  env: Env,
  level: number,
  zone?: number | null
): Promise<Room[]> {
  const sb = getSupabase(env);
  const { data, error } = await sb.from('rooms').select('*').eq('level', level);
  if (error || !data) return [];

  let list = data.map(rowToRoom);
  if (typeof zone === 'number' && zone > 0) {
    const zoneFiltered = list.filter(r => r.zone === zone || r.zone === 0);
    if (zoneFiltered.length > 0) {
      list = zoneFiltered;
    }
  }

  return list.sort((a, b) => {
    if (a.zone !== b.zone) return a.zone - b.zone;
    const ca = a.spaceCode || a.spaceNo || '';
    const cb = b.spaceCode || b.spaceNo || '';
    if (ca !== cb) return ca.localeCompare(cb);
    return (a.space || '').localeCompare(b.space || '');
  });
}

/**
 * Searches Supabase `rooms` to resolve a room or return candidate rooms.
 */
export async function resolveRoomCandidates(
  env: Env,
  action: PendingAction
): Promise<{ exact: Room | null; candidates: Room[] }> {
  const sb = getSupabase(env);
  const { parsed, selectedRoomId } = action;

  // 1. If user already picked a specific room ID, load it directly
  if (selectedRoomId) {
    const exact = await getRoomByIdOrCode(env, selectedRoomId);
    if (exact) {
      parsed.level = exact.level;
      parsed.zone = exact.zone;
      parsed.space = exact.space;
      parsed.spaceCode = exact.spaceCode || exact.spaceNo;
      parsed.spaceNo = exact.spaceNo || exact.spaceCode;
      return { exact, candidates: [exact] };
    }
  }

  // 2. If an explicit room code like GF-008 or F4-041 was provided, try matching globally
  const targetCode = (parsed.spaceCode || parsed.spaceNo || '').trim().toUpperCase();
  if (targetCode) {
    const { data: codeRows } = await sb
      .from('rooms')
      .select('*')
      .or(`space_code.ilike.${targetCode},space_no.ilike.${targetCode}`);

    if (codeRows && codeRows.length === 1) {
      const exact = rowToRoom(codeRows[0]);
      parsed.level = exact.level;
      parsed.zone = exact.zone;
      parsed.space = exact.space;
      parsed.spaceCode = exact.spaceCode || exact.spaceNo;
      parsed.spaceNo = exact.spaceNo || exact.spaceCode;
      return { exact, candidates: [exact] };
    } else if (codeRows && codeRows.length > 1) {
      const list = codeRows.map(rowToRoom);
      const filtered =
        typeof parsed.level === 'number' ? list.filter(r => r.level === parsed.level) : list;
      if (filtered.length === 1) {
        const exact = filtered[0];
        parsed.level = exact.level;
        parsed.zone = exact.zone;
        parsed.space = exact.space;
        return { exact, candidates: [exact] };
      }
      return { exact: null, candidates: filtered.length ? filtered : list };
    }
  }

  // 3. If level is not known yet, check if space name uniquely identifies a room across the project
  const cleanSpace = (parsed.space || '').trim().toUpperCase();
  if (typeof parsed.level !== 'number') {
    if (cleanSpace && cleanSpace !== 'SITE' && cleanSpace !== 'ROOM') {
      const { data: spaceRows } = await sb
        .from('rooms')
        .select('*')
        .ilike('space', `%${cleanSpace}%`);
      if (spaceRows && spaceRows.length === 1) {
        const exact = rowToRoom(spaceRows[0]);
        parsed.level = exact.level;
        parsed.zone = exact.zone;
        parsed.space = exact.space;
        parsed.spaceCode = exact.spaceCode || exact.spaceNo;
        return { exact, candidates: [exact] };
      }
    }
    return { exact: null, candidates: [] };
  }

  // 4. Level IS known: fetch rooms on this level
  const levelRooms = await getRoomsForLevelZone(env, parsed.level, parsed.zone);
  if (!levelRooms.length) {
    return { exact: null, candidates: [] };
  }

  // Filter by space name if provided
  if (cleanSpace && cleanSpace !== 'SITE' && cleanSpace !== 'ROOM') {
    const matched = levelRooms.filter(r => {
      const rs = (r.space || '').toUpperCase();
      return rs === cleanSpace || rs.includes(cleanSpace) || cleanSpace.includes(rs);
    });

    if (matched.length === 1) {
      const exact = matched[0];
      parsed.zone = exact.zone;
      parsed.space = exact.space;
      parsed.spaceCode = exact.spaceCode || exact.spaceNo;
      return { exact, candidates: [exact] };
    }
    if (matched.length > 1) {
      return { exact: null, candidates: matched };
    }
  }

  // If only 1 room exists in this level + zone, select it
  if (levelRooms.length === 1) {
    return { exact: levelRooms[0], candidates: levelRooms };
  }

  return { exact: null, candidates: levelRooms };
}

/**
 * Fetches micro-task templates from `kv` (`k = 'microtasks'`) so marking a finish DONE
 * automatically marks all its micro-tasks as DONE.
 */
async function getMicroTemplates(env: Env): Promise<Record<string, string[]>> {
  try {
    const sb = getSupabase(env);
    const { data } = await sb.from('kv').select('v').eq('k', 'microtasks').maybeSingle();
    if (data?.v?.codeTemplates && typeof data.v.codeTemplates === 'object') {
      return data.v.codeTemplates as Record<string, string[]>;
    }
  } catch {}
  return {};
}

/**
 * Aligns a parsed finish code with the room's actual finish codes in `room.checks`.
 */
export function resolveFinishCodeForRoom(
  room: Room,
  finishCode: string | null,
  finishKind: string | null
): string | null {
  const roomCodes = Object.keys(room.checks || {});
  if (!roomCodes.length) return finishCode;

  if (finishCode === 'ALL') return 'ALL';

  if (finishCode && roomCodes.includes(finishCode)) {
    return finishCode;
  }

  // Smart screed fallback: F02 <-> F03
  if (finishCode === 'F02' || finishCode === 'F03') {
    if (roomCodes.includes('F02')) return 'F02';
    if (roomCodes.includes('F03')) return 'F03';
  }

  // Match by prefix (F, W, C, S) if the room has only 1 code in that category
  const prefix = finishCode
    ? finishCode.charAt(0).toUpperCase()
    : finishKind === 'Floor'
      ? 'F'
      : finishKind === 'Wall'
        ? 'W'
        : finishKind === 'Ceiling'
          ? 'C'
          : finishKind === 'Skirting'
            ? 'S'
            : '';

  if (prefix) {
    const sameCategory = roomCodes.filter(c => c.toUpperCase().startsWith(prefix));
    if (sameCategory.length === 1) {
      return sameCategory[0];
    }
  }

  return finishCode;
}

/**
 * Applies the confirmed update to the Supabase `rooms` table and `photo_meta` table.
 */
export async function applyUpdateToRoom(
  env: Env,
  action: PendingAction,
  photoId?: string
): Promise<{ room: Room; roomTitle: string; appliedFinish?: string }> {
  const sb = getSupabase(env);
  const { parsed, telegramUsername } = action;

  const { exact, candidates } = await resolveRoomCandidates(env, action);
  const targetRoom = exact || candidates[0];
  if (!targetRoom) {
    throw new Error('Please select a valid room before confirming.');
  }

  const nowIso = new Date().toISOString();
  const author = telegramUsername ? `@${telegramUsername}` : 'Telegram Bot';
  const roomObj: Room = {
    ...targetRoom,
    checks: { ...(targetRoom.checks || {}) },
    steps: { ...(targetRoom.steps || {}) },
    log: Array.isArray(targetRoom.log) ? [...targetRoom.log] : [],
    snags: Array.isArray(targetRoom.snags) ? [...targetRoom.snags] : [],
    photos: Array.isArray(targetRoom.photos) ? [...targetRoom.photos] : [],
    updated: nowIso
  };

  const targetFinish = resolveFinishCodeForRoom(roomObj, parsed.finishCode, parsed.finishKind);
  const codeTemplates = parsed.status === 'done' ? await getMicroTemplates(env) : {};

  const completeMicrosForCode = (code: string) => {
    const tmpl = codeTemplates[code] || [];
    const existing = Object.keys(roomObj.steps[code] || {});
    const allMids = new Set([...existing, ...tmpl]);
    if (allMids.size > 0) {
      if (!roomObj.steps[code]) roomObj.steps[code] = {};
      allMids.forEach(mid => {
        roomObj.steps[code][mid] = 'done';
      });
    }
  };

  // 1. Update finish check(s) if provided
  if (targetFinish && parsed.status) {
    if (targetFinish === 'ALL') {
      Object.keys(roomObj.checks).forEach(c => {
        roomObj.checks[c] = parsed.status as Status;
        if (parsed.status === 'done') {
          completeMicrosForCode(c);
        }
      });
    } else {
      roomObj.checks[targetFinish] = parsed.status;
      if (parsed.status === 'done') {
        completeMicrosForCode(targetFinish);
      }
    }
  }

  // 2. Add snag if detected (newest first, matching ecit-site-tracker)
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (parsed.snag) {
    const newSnag: RoomSnag = {
      id: 's' + uid(),
      text: parsed.snag.text,
      trade: parsed.snag.trade || 'General',
      due: '',
      code: targetFinish && targetFinish !== 'ALL' ? targetFinish : '',
      status: 'open',
      created: nowIso,
      closed: '',
      photos: photoId ? [photoId] : []
    };
    roomObj.snags.unshift(newSnag);
  }

  // 3. Add photo if uploaded (using exact photoId so `${photoId}.jpg` loads in web app)
  const photoCaption = parsed.snag
    ? `Snag: ${parsed.snag.text}`
    : parsed.notes || parsed.summary || 'Telegram site update';
  const photoCode = targetFinish && targetFinish !== 'ALL' ? targetFinish : '';

  if (photoId) {
    const newPhoto: RoomPhoto = {
      id: photoId,
      ts: nowIso,
      caption: photoCaption,
      code: photoCode
    };
    roomObj.photos.unshift(newPhoto);

    // Sync photo_meta table for ECIT Site Tracker
    try {
      await sb.from('photo_meta').upsert(
        {
          id: photoId,
          room_key: roomObj.id,
          storage_path: `${photoId}.jpg`,
          ts: nowIso,
          caption: photoCaption,
          code: photoCode
        },
        { onConflict: 'id' }
      );
    } catch (metaErr) {
      console.warn('photo_meta upsert warning (non-fatal):', metaErr);
    }
  }

  // 4. Add log entry (newest first)
  const summaryParts: string[] = [];
  if (targetFinish && parsed.status) {
    summaryParts.push(`Finish ${targetFinish} → ${parsed.status.toUpperCase()}`);
  }
  if (parsed.snag) {
    summaryParts.push(`Snag logged: "${parsed.snag.text}" (${parsed.snag.trade || 'General'})`);
  }
  if (photoId) {
    summaryParts.push(`Added 1 photo`);
  }
  const logText = summaryParts.length
    ? `[Telegram] ${summaryParts.join(' · ')}`
    : `[Telegram] ${parsed.notes || parsed.summary || 'Site update'}`;

  const logEntry: RoomLogEntry = {
    id: 'l' + uid(),
    ts: nowIso,
    text: logText,
    by: author
  };
  roomObj.log.unshift(logEntry);

  // 5. Update existing room row in Supabase
  const updatePayload = {
    notes: roomObj.notes || '',
    checks: roomObj.checks,
    steps: roomObj.steps,
    log: roomObj.log,
    snags: roomObj.snags,
    photos: roomObj.photos,
    updated: nowIso
  };

  const { error: updateError } = await sb
    .from('rooms')
    .update(updatePayload)
    .eq('id', roomObj.id);

  if (updateError) {
    console.error('Supabase update error:', updateError);
    throw updateError;
  }

  const levelDisplay = roomObj.level === 0 ? 'GF' : `L${roomObj.level}`;
  const zoneDisplay = roomObj.zone ? `Z${roomObj.zone}` : 'All';
  const codeDisplay = roomObj.spaceCode || roomObj.spaceNo;
  const roomTitle = `${levelDisplay} ${zoneDisplay} · ${codeDisplay ? codeDisplay + ' — ' : ''}${roomObj.space}`;

  return {
    room: roomObj,
    roomTitle,
    appliedFinish: targetFinish || undefined
  };
}
