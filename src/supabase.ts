import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  Env,
  PendingAction,
  Room,
  RoomPhoto,
  RoomSnag,
  RoomLogEntry,
  RoomUndoSnapshot,
  Status,
  TelegramAuthorizedUser,
  TelegramLinkCode,
  TelegramAuthRegistry,
  WebSiteUser
} from './types';
import { normalizeScheduleCodeInput } from './ai';

export const TG_AUTH_REGISTRY_KEY = 'tg_auth_registry';

export const VALID_INVITE_CODES = [
  'ECIT2026',
  'SALEH2026',
  'SALEH-SITE',
  'ECIT-ADMIN',
  'DUBAI-SITE',
  'SITE-ENGINEER'
];

export function formatAuthorTag(raw?: string): string {
  if (!raw) return 'Telegram Bot';
  const trimmed = raw.trim();
  if (!trimmed) return 'Telegram Bot';
  if (trimmed.includes(' ') || trimmed.includes('@') || trimmed.includes('(')) {
    return trimmed;
  }
  return `@${trimmed}`;
}

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
    steps: r.steps && typeof r.steps === 'object' ? JSON.parse(JSON.stringify(r.steps)) : {},
    log: Array.isArray(r.log) ? [...r.log] : [],
    snags: Array.isArray(r.snags) ? [...r.snags] : [],
    photos: Array.isArray(r.photos) ? [...r.photos] : [],
    added: r.added || new Date().toISOString(),
    updated: r.updated || new Date().toISOString()
  };
}

export function formatRoomTitle(room: Room): string {
  const levelDisplay = room.level === 0 ? 'GF' : `L${room.level}`;
  const zoneDisplay = room.zone ? `Z${room.zone}` : 'All';
  const codeDisplay = room.spaceCode || room.spaceNo;
  return `${levelDisplay} ${zoneDisplay} · ${codeDisplay ? codeDisplay + ' — ' : ''}${room.space}`;
}

export const COMPACT_DESCS: Record<string, string> = {
  // Flooring
  F01: 'Bare Slab',
  F01A: 'Raised Slab',
  F02: 'Screed',
  F03: 'Underlay Screed',
  F04: 'Dry Shake',
  F05: 'PU Resin',
  F06: 'Epoxy Coating',
  F07: 'Raised Floor',
  F07A: 'Raised Floor',
  F08: 'Porcelain Tiles',
  F09: 'Ceramic Tiles',
  F09A: 'Stone Tiles',
  F10: 'Dry Shake',
  F10A: 'Deck Coating',
  F11: 'Rubber Flooring',
  F12: 'N/A',
  F13: 'Granite',
  F14: 'Prayer Carpet',
  F14A: 'Carpet Tiles',
  F15: 'Marble',
  F16: 'Porcelain Pavers',

  // Walls
  W01: 'Bare Blockwork',
  W02: 'Spray Plaster',
  W03: 'Sand Plaster',
  W04: 'Washable Paint',
  W05: 'Anti-Fungal Paint',
  W05A: 'Matt Paint',
  W05B: 'Anti-Fungal Matt',
  W06: 'Anti-Carbonation',
  W07: 'Ceramic Wall Tiles',
  W08: 'Porcelain Wall Tiles',
  W08A: 'Dust Seal',
  W09: 'Feature Paint',
  W90: 'Wall Tiles',
  EW01: 'External Plaster',
  EW02: 'Facade Paint',
  EW03: 'Granite Cladding',

  // Ceilings
  C01: 'Bare Soffit',
  C02: 'Plaster Ceiling',
  'C-02': 'Plaster Ceiling',
  C03: 'Gypsum Ceiling',
  C03A: 'MR Gypsum Ceiling',
  C03B: 'Mashrabiya',
  C04: 'Soffit Paint',
  C05: 'Soffit Paint',
  C05A: 'Soffit Matt Paint',
  C05B: 'Soffit Matt Paint',
  C06: 'Anti-Carbonation',
  C07: 'MR Gypsum Tiles',
  C08: 'T-Grid Ceiling',
  C09: 'Cement Ceiling',
  EC01: 'External Plaster',
  EC02: 'External Paint',
  EC03: 'Cement Board Ceiling',

  // Skirtings
  S01: 'Bare Skirting',
  S02: 'Plaster Skirting',
  S03: 'Sand Plaster Skirting',
  S04: 'PU Cove Skirting',
  S05: 'Dry Shake Skirting',
  S06: 'Epoxy Skirting',
  S07: 'Porcelain Skirting',
  S08: 'Ceramic Skirting',
  S09: 'Granite Skirting',
  S09A: 'Timber Skirting',
  S10: 'Marble Skirting',
  S11: 'Wood Skirting',
  S12: 'Deck Skirting',
  S13: 'Porcelain Skirting',
  ES01: 'Aluminium Flashing',
  ES02: 'Porcelain Skirting',
  ES03: 'Deck Skirting',
  ES04: 'Granite Skirting'
};

export const SHORT_DESCS: Record<string, string> = {
  // Flooring
  F01: 'Bare slab sand-blasted',
  F01A: 'Slab raised to FFL',
  F02: 'Power floated cement screed',
  F03: 'Screed for tile / carpet / vinyl',
  F04: 'Monolithic dry shake hardener',
  F05: 'Seamless self-smoothing PU resin',
  F06: 'Pigmented epoxy resin coating',
  F07: 'Antistatic raised access floor with vinyl',
  F07A: 'Raised access floor',
  F08: 'Vitrified non-slip porcelain tiles',
  F09: 'Non-slip glazed ceramic tiles',
  F09A: 'Stone tiles (ID9004)',
  F10: 'Dry shake hardener on wet concrete',
  F10A: 'PU deck coating',
  F11: 'Electrostatic rubber flooring',
  F12: 'Not applicable',
  F13: '20mm polished granite',
  F14: 'Mosque prayer carpet',
  F14A: '60x60 carpet tiles',
  F15: '20mm polished marble',
  F16: '20mm porcelain pavers',

  // Walls
  W01: 'Bare face concrete / blockwork',
  W02: 'Spray plaster (internal AC)',
  W03: 'Cement sand plaster (wet areas)',
  W04: 'Paint system-1 (washable)',
  W05: 'Paint system-2 (anti-fungal)',
  W05A: 'Paint system-3 (matt)',
  W05B: 'Paint system-4 (anti-fungal matt)',
  W06: 'Anti-carbonation paint',
  W07: 'Coloured glazed ceramic tiles',
  W08: 'Vitrified non-slip porcelain wall tiles',
  W08A: 'Moisture / dust protection',
  W09: 'Internal feature paint (ID9004)',
  W90: 'Wall tiles',
  EW01: 'External cement plaster',
  EW02: 'External facade paint',
  EW03: 'Polished granite cladding',

  // Ceilings
  C01: 'Bare slab ready for ceiling',
  C02: 'Spray plaster ceiling',
  'C-02': 'Spray plaster ceiling',
  C03: 'Gypsum board ceiling',
  C03A: 'MR gypsum board ceiling',
  C03B: 'Decorative mashrabiya ceiling',
  C04: 'Acrylic emulsion on bare slab',
  C05: 'Paint system-2 on slab soffit',
  C05A: 'Paint system-3 on slab soffit',
  C05B: 'Paint system-4 on slab soffit',
  C06: 'Anti-carbonation paint',
  C07: 'Fine line 600x600 MR gypsum tiles',
  C08: 'Exposed T-grid 600x600 MR gypsum tiles',
  C09: 'Rockwool + cement board ceiling',
  EC01: 'External soffit plaster',
  EC02: 'External soffit paint',
  EC03: '12mm cement board + external paint',

  // Skirtings
  S01: 'Bare face concrete / blockwork skirting',
  S02: 'Spray plaster skirting',
  S03: 'Cement sand plaster skirting',
  S04: '150x150 PU cove skirting',
  S05: '150mm dry shake skirting',
  S06: '150mm epoxy cove skirting',
  S07: '100mm porcelain skirting',
  S08: '100mm ceramic skirting',
  S09: '100mm polished granite skirting',
  S09A: 'Flush painted timber skirting',
  S10: '100mm polished marble skirting',
  S11: '100mm beech wood skirting',
  S12: '150mm PU deck skirting',
  S13: '100mm porcelain cover skirting',
  ES01: '150mm aluminium flashing',
  ES02: '150mm external porcelain skirting',
  ES03: '150mm PU deck skirting',
  ES04: '100mm bush hammered granite skirting'
};

export function finishCompactName(code: string | null | undefined): string {
  if (!code) return '';
  const c = code.trim().toUpperCase();
  if (c === 'ALL') return 'All Finishes';
  return COMPACT_DESCS[c] || SHORT_DESCS[c] || c;
}

export function finishShortDesc(code: string | null | undefined): string {
  if (!code) return '';
  const c = code.trim().toUpperCase();
  if (c === 'ALL') return 'All Room Finishes';
  return SHORT_DESCS[c] || COMPACT_DESCS[c] || c;
}

export function formatFinishButton(code: string, prefix = ''): string {
  const c = code.trim().toUpperCase();
  if (c === 'ALL') return `${prefix}ALL Finishes`.trim();
  const compact = COMPACT_DESCS[c];
  return compact ? `${prefix}${c} · ${compact}`.trim() : `${prefix}${c}`.trim();
}

export function formatFinishLine(code: string): string {
  const c = code.trim().toUpperCase();
  if (c === 'ALL') return `*ALL* (All Room Finishes)`;
  const short = SHORT_DESCS[c] || COMPACT_DESCS[c];
  return short ? `\`${c}\` (${short})` : `\`${c}\``;
}

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

export async function getPendingAction(env: Env, id: string): Promise<PendingAction | null> {
  const sb = getSupabase(env);
  const key = `tg_pending:${id}`;
  const { data, error } = await sb.from('kv').select('v').eq('k', key).maybeSingle();
  if (error || !data) return null;
  return data.v as PendingAction;
}

export async function deletePendingAction(env: Env, id: string): Promise<void> {
  const sb = getSupabase(env);
  const key = `tg_pending:${id}`;
  await sb.from('kv').delete().eq('k', key);
}

export async function saveUndoSnapshot(
  env: Env,
  undoId: string,
  snapshot: RoomUndoSnapshot
): Promise<void> {
  const sb = getSupabase(env);
  await sb.from('kv').upsert(
    {
      k: `tg_undo:${undoId}`,
      v: snapshot,
      updated: new Date().toISOString()
    },
    { onConflict: 'k' }
  );
}

export async function applyUndoSnapshot(
  env: Env,
  undoId: string
): Promise<{ ok: boolean; roomTitle?: string }> {
  const sb = getSupabase(env);
  const key = `tg_undo:${undoId}`;
  const { data } = await sb.from('kv').select('v').eq('k', key).maybeSingle();
  if (!data?.v) return { ok: false };

  const snap = data.v as RoomUndoSnapshot;
  const room = await getRoomByIdOrCode(env, snap.roomId);
  if (!room) return { ok: false };

  const { error } = await sb
    .from('rooms')
    .update({
      notes: snap.notes || '',
      checks: snap.checks || {},
      steps: snap.steps || {},
      log: snap.log || [],
      snags: snap.snags || [],
      photos: snap.photos || []
    })
    .eq('id', snap.roomId);

  if (error) throw error;

  if (snap.uploadedPhotoId) {
    await deleteSitePhoto(env, snap.uploadedPhotoId).catch(() => {});
  }
  await sb.from('kv').delete().eq('k', key);

  return { ok: true, roomTitle: formatRoomTitle(room) };
}

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

export function getPhotoPublicUrl(env: Env, photoId: string): string {
  const sb = getSupabase(env);
  const bucket = env.SUPABASE_BUCKET || 'photos';
  return sb.storage.from(bucket).getPublicUrl(`${photoId}.jpg`).data.publicUrl;
}

export async function getRoomByIdOrCode(env: Env, idOrCode: string): Promise<Room | null> {
  if (!idOrCode) return null;
  const sb = getSupabase(env);

  const byIdRes = await sb.from('rooms').select('*').eq('id', idOrCode).maybeSingle();
  if (!byIdRes.error && byIdRes.data) {
    return rowToRoom(byIdRes.data);
  }

  const cleanCode = normalizeScheduleCodeInput(idOrCode) || idOrCode.trim().toUpperCase();
  const byCodeRes = await sb
    .from('rooms')
    .select('*')
    .or(`space_code.ilike.${cleanCode},space_no.ilike.${cleanCode}`)
    .limit(1);
  if (!byCodeRes.error && byCodeRes.data && byCodeRes.data.length > 0) {
    return rowToRoom(byCodeRes.data[0]);
  }

  const byNameRes = await sb.from('rooms').select('*').ilike('space', `%${cleanCode}%`).limit(1);
  if (!byNameRes.error && byNameRes.data && byNameRes.data.length > 0) {
    return rowToRoom(byNameRes.data[0]);
  }

  return null;
}

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

export async function resolveRoomCandidates(
  env: Env,
  action: PendingAction
): Promise<{ exact: Room | null; candidates: Room[] }> {
  const sb = getSupabase(env);
  const { parsed, selectedRoomId } = action;

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

  const targetCode = normalizeScheduleCodeInput(parsed.spaceCode || parsed.spaceNo || '');
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

  const levelRooms = await getRoomsForLevelZone(env, parsed.level, parsed.zone);
  if (!levelRooms.length) {
    return { exact: null, candidates: [] };
  }

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

  if (levelRooms.length === 1) {
    return { exact: levelRooms[0], candidates: levelRooms };
  }

  return { exact: null, candidates: levelRooms };
}

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

  if (finishCode === 'F02' || finishCode === 'F03') {
    if (roomCodes.includes('F02')) return 'F02';
    if (roomCodes.includes('F03')) return 'F03';
  }

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

export async function applyUpdateToRoom(
  env: Env,
  action: PendingAction,
  photoId?: string
): Promise<{ room: Room; roomTitle: string; appliedFinish?: string; undoId: string }> {
  const sb = getSupabase(env);
  const { parsed, telegramUsername } = action;

  const { exact, candidates } = await resolveRoomCandidates(env, action);
  const targetRoom = exact || candidates[0];
  if (!targetRoom) {
    throw new Error('Please select a valid room before confirming.');
  }

  // Save Undo Snapshot before mutating
  const undoId = action.id;
  await saveUndoSnapshot(env, undoId, {
    roomId: targetRoom.id,
    notes: targetRoom.notes || '',
    checks: { ...(targetRoom.checks || {}) },
    steps: JSON.parse(JSON.stringify(targetRoom.steps || {})),
    log: Array.isArray(targetRoom.log) ? [...targetRoom.log] : [],
    snags: Array.isArray(targetRoom.snags) ? [...targetRoom.snags] : [],
    photos: Array.isArray(targetRoom.photos) ? [...targetRoom.photos] : [],
    uploadedPhotoId: photoId
  }).catch(() => {});

  const nowIso = new Date().toISOString();
  const author = formatAuthorTag(telegramUsername);
  const roomObj: Room = {
    ...targetRoom,
    checks: { ...(targetRoom.checks || {}) },
    steps: JSON.parse(JSON.stringify(targetRoom.steps || {})),
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

  const summaryParts: string[] = [];
  if (targetFinish && parsed.status) {
    summaryParts.push(`${ targetFinish } (${finishCompactName(targetFinish)}) → ${parsed.status.toUpperCase()}`);
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

  // Strictly update the 6 editable columns on public.rooms
  const updatePayload = {
    notes: roomObj.notes || '',
    checks: roomObj.checks,
    steps: roomObj.steps,
    log: roomObj.log,
    snags: roomObj.snags,
    photos: roomObj.photos
  };

  const { error: updateError } = await sb
    .from('rooms')
    .update(updatePayload)
    .eq('id', roomObj.id);

  if (updateError) {
    console.error('Supabase update error:', updateError);
    throw updateError;
  }

  return {
    room: roomObj,
    roomTitle: formatRoomTitle(roomObj),
    appliedFinish: targetFinish || undefined,
    undoId
  };
}

/**
 * Cycles or updates a single finish check directly on a room from the Interactive Room Browser.
 */
export async function quickCycleRoomFinish(
  env: Env,
  roomId: string,
  finishCode: string,
  authorName?: string
): Promise<{ room: Room; nextStatus: Status } | null> {
  const room = await getRoomByIdOrCode(env, roomId);
  if (!room) return null;

  const sb = getSupabase(env);
  const current: Status = room.checks?.[finishCode] || 'unknown';
  const order: Status[] = ['pending', 'ongoing', 'done'];
  const idx = order.indexOf(current);
  const nextStatus: Status = order[(idx + 1) % order.length];

  room.checks = { ...(room.checks || {}), [finishCode]: nextStatus };
  if (nextStatus === 'done') {
    const codeTemplates = await getMicroTemplates(env);
    const tmpl = codeTemplates[finishCode] || [];
    const existing = Object.keys(room.steps?.[finishCode] || {});
    const allMids = new Set([...existing, ...tmpl]);
    if (allMids.size > 0) {
      if (!room.steps) room.steps = {};
      if (!room.steps[finishCode]) room.steps[finishCode] = {};
      allMids.forEach(mid => {
        room.steps[finishCode][mid] = 'done';
      });
    }
  }

  const nowIso = new Date().toISOString();
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  room.log = [
    {
      id: 'l' + uid,
      ts: nowIso,
      text: `[Telegram] ${finishCode} (${finishCompactName(finishCode)}) → ${nextStatus.toUpperCase()}`,
      by: formatAuthorTag(authorName)
    },
    ...(room.log || [])
  ];

  const { error } = await sb
    .from('rooms')
    .update({
      notes: room.notes || '',
      checks: room.checks,
      steps: room.steps || {},
      log: room.log,
      snags: room.snags || [],
      photos: room.photos || []
    })
    .eq('id', room.id);

  if (error) throw error;
  return { room, nextStatus };
}

/**
 * Resolves (closes) an open snag in a room directly from Telegram.
 */
export async function closeRoomSnag(
  env: Env,
  roomId: string,
  snagId: string,
  authorName?: string
): Promise<{ room: Room; closedSnag?: RoomSnag } | null> {
  const room = await getRoomByIdOrCode(env, roomId);
  if (!room) return null;

  const sb = getSupabase(env);
  const nowIso = new Date().toISOString();
  let closedSnag: RoomSnag | undefined;

  room.snags = (room.snags || []).map(s => {
    if (s.id === snagId) {
      closedSnag = { ...s, status: 'closed', closed: nowIso };
      return closedSnag;
    }
    return s;
  });

  if (!closedSnag) return { room };

  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  room.log = [
    {
      id: 'l' + uid,
      ts: nowIso,
      text: `[Telegram] Snag resolved: "${closedSnag.text}"`,
      by: formatAuthorTag(authorName)
    },
    ...(room.log || [])
  ];

  const { error } = await sb
    .from('rooms')
    .update({
      notes: room.notes || '',
      checks: room.checks || {},
      steps: room.steps || {},
      log: room.log,
      snags: room.snags,
      photos: room.photos || []
    })
    .eq('id', room.id);

  if (error) throw error;
  return { room, closedSnag };
}

/**
 * Computes live project KPIs and per-level summary from `public.rooms`.
 */
export async function getProjectStats(env: Env) {
  const sb = getSupabase(env);
  const { data, error } = await sb
    .from('rooms')
    .select('id, level, zone, space, space_code, checks, snags, photos');
  if (error || !data) {
    throw error || new Error('Failed to load rooms');
  }

  let totalRooms = data.length;
  let roomsDone = 0;
  let checksTotal = 0;
  let checksDone = 0;
  let checksOngoing = 0;
  let checksPending = 0;
  let openSnags = 0;
  let totalPhotos = 0;

  const byLevel: Record<number, { total: number; done: number; checksDone: number; checksTotal: number; snags: number }> = {};
  for (let l = 0; l <= 8; l++) {
    byLevel[l] = { total: 0, done: 0, checksDone: 0, checksTotal: 0, snags: 0 };
  }

  for (const r of data) {
    const lvl = typeof r.level === 'number' ? r.level : 0;
    if (!byLevel[lvl]) {
      byLevel[lvl] = { total: 0, done: 0, checksDone: 0, checksTotal: 0, snags: 0 };
    }
    byLevel[lvl].total++;

    const checksVals = Object.values((r.checks || {}) as Record<string, Status>);
    if (checksVals.length > 0 && checksVals.every(st => st === 'done')) {
      roomsDone++;
      byLevel[lvl].done++;
    }

    for (const st of checksVals) {
      checksTotal++;
      byLevel[lvl].checksTotal++;
      if (st === 'done') {
        checksDone++;
        byLevel[lvl].checksDone++;
      } else if (st === 'ongoing') {
        checksOngoing++;
      } else if (st === 'pending') {
        checksPending++;
      }
    }

    const rSnags = Array.isArray(r.snags) ? r.snags : [];
    const rOpen = rSnags.filter((s: any) => s && s.status === 'open').length;
    openSnags += rOpen;
    byLevel[lvl].snags += rOpen;

    const rPhotos = Array.isArray(r.photos) ? r.photos : [];
    totalPhotos += rPhotos.length;
  }

  return {
    totalRooms,
    roomsDone,
    roomsDonePct: totalRooms ? Math.round((roomsDone / totalRooms) * 100) : 0,
    checksTotal,
    checksDone,
    checksOngoing,
    checksPending,
    checksDonePct: checksTotal ? Math.round((checksDone / checksTotal) * 100) : 0,
    openSnags,
    totalPhotos,
    byLevel
  };
}

/**
 * Fetches all rooms that currently have at least one open snag.
 */
export async function getRoomsWithOpenSnags(env: Env): Promise<Room[]> {
  const sb = getSupabase(env);
  const { data, error } = await sb.from('rooms').select('*');
  if (error || !data) return [];

  return data
    .map(rowToRoom)
    .filter(r => (r.snags || []).some(s => s && s.status === 'open'))
    .sort((a, b) => {
      const sa = (a.snags || []).filter(s => s.status === 'open').length;
      const sbCount = (b.snags || []).filter(s => s.status === 'open').length;
      if (sbCount !== sa) return sbCount - sa;
      return a.level - b.level;
    });
}

// ================= TELEGRAM USER AUTHENTICATION & LINKING =================

export async function getTelegramAuthRegistry(env: Env): Promise<TelegramAuthRegistry> {
  const sb = getSupabase(env);
  try {
    const { data, error } = await sb
      .from('kv')
      .select('v')
      .eq('k', TG_AUTH_REGISTRY_KEY)
      .maybeSingle();
    if (error || !data || !data.v) {
      return { users: {}, linkCodes: {} };
    }
    const raw = data.v as Partial<TelegramAuthRegistry>;
    const users = raw.users && typeof raw.users === 'object' ? { ...raw.users } : {};
    const linkCodes = raw.linkCodes && typeof raw.linkCodes === 'object' ? { ...raw.linkCodes } : {};

    // Prune expired link codes
    const now = Date.now();
    for (const [code, item] of Object.entries(linkCodes)) {
      if (!item || new Date(item.expiresAt).getTime() < now) {
        delete linkCodes[code];
      }
    }
    return { users, linkCodes };
  } catch (e) {
    console.warn('getTelegramAuthRegistry warning:', e);
    return { users: {}, linkCodes: {} };
  }
}

export async function saveTelegramAuthRegistry(
  env: Env,
  registry: TelegramAuthRegistry
): Promise<void> {
  const sb = getSupabase(env);
  const { error } = await sb.from('kv').upsert(
    {
      k: TG_AUTH_REGISTRY_KEY,
      v: registry,
      updated: new Date().toISOString()
    },
    { onConflict: 'k' }
  );
  if (error) {
    console.error('Failed to save Telegram auth registry:', error);
    throw error;
  }
}

export async function getAuthorizedTelegramUser(
  env: Env,
  telegramUserId?: number
): Promise<TelegramAuthorizedUser | null> {
  if (!telegramUserId) return null;
  const reg = await getTelegramAuthRegistry(env);
  return reg.users[String(telegramUserId)] || null;
}

export function formatTelegramAuthorLabel(
  authUser: TelegramAuthorizedUser | null,
  from?: { id?: number; username?: string; first_name?: string; last_name?: string }
): string {
  if (authUser?.displayName) {
    const handle = from?.username || authUser.telegramUsername;
    return handle ? `${authUser.displayName} (@${handle})` : authUser.displayName;
  }
  if (from?.username) return `@${from.username}`;
  if (from?.first_name) {
    return [from.first_name, from.last_name].filter(Boolean).join(' ');
  }
  return 'Telegram User';
}

export async function generateTelegramLinkCode(
  env: Env,
  input: {
    supabaseUserId: string;
    email: string;
    displayName: string;
    isAdmin: boolean;
  }
): Promise<TelegramLinkCode> {
  const reg = await getTelegramAuthRegistry(env);

  // Remove any previous active link codes for the same Supabase user
  for (const [k, v] of Object.entries(reg.linkCodes)) {
    if (v.supabaseUserId === input.supabaseUserId) {
      delete reg.linkCodes[k];
    }
  }

  // Generate a 6-digit numeric pairing code
  const num = Math.floor(100000 + Math.random() * 900000);
  const code = String(num);
  const now = new Date();
  const expires = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes

  const entry: TelegramLinkCode = {
    code,
    supabaseUserId: input.supabaseUserId,
    email: input.email,
    displayName: input.displayName,
    isAdmin: input.isAdmin,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString()
  };

  reg.linkCodes[code] = entry;
  await saveTelegramAuthRegistry(env, reg);
  return entry;
}

export async function consumeTelegramLinkCode(
  env: Env,
  rawCode: string,
  tgUser: { id: number; username?: string; first_name?: string; last_name?: string },
  chatId?: number
): Promise<{ ok: boolean; user?: TelegramAuthorizedUser; error?: string }> {
  const clean = rawCode.trim().replace(/^link_/i, '').replace(/^TG-/i, '').trim();
  const reg = await getTelegramAuthRegistry(env);
  const link = reg.linkCodes[clean];

  if (!link) {
    return { ok: false, error: 'Invalid or expired link code.' };
  }
  if (new Date(link.expiresAt).getTime() < Date.now()) {
    delete reg.linkCodes[clean];
    await saveTelegramAuthRegistry(env, reg);
    return { ok: false, error: 'This link code has expired. Please generate a new one in the Web App.' };
  }

  const userEntry: TelegramAuthorizedUser = {
    telegramUserId: tgUser.id,
    telegramUsername: tgUser.username,
    firstName: tgUser.first_name,
    lastName: tgUser.last_name,
    chatId: chatId || tgUser.id,
    status: 'approved',
    role: link.isAdmin ? 'admin' : 'inspector',
    authMethod: 'web_link',
    supabaseUserId: link.supabaseUserId,
    email: link.email,
    displayName: link.displayName,
    linkedAt: new Date().toISOString()
  };

  reg.users[String(tgUser.id)] = userEntry;
  delete reg.linkCodes[clean];
  await saveTelegramAuthRegistry(env, reg);
  return { ok: true, user: userEntry };
}

export async function authenticateWithInviteCode(
  env: Env,
  rawCode: string,
  tgUser: { id: number; username?: string; first_name?: string; last_name?: string },
  chatId?: number
): Promise<{ ok: boolean; user?: TelegramAuthorizedUser }> {
  const clean = rawCode.trim().toUpperCase();
  if (!VALID_INVITE_CODES.includes(clean)) {
    return { ok: false };
  }

  const reg = await getTelegramAuthRegistry(env);
  const existing = reg.users[String(tgUser.id)];
  const fullName =
    [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') ||
    tgUser.username ||
    `Telegram #${tgUser.id}`;

  const isInviteAdmin = clean === 'ECIT-ADMIN';
  const userEntry: TelegramAuthorizedUser = {
    telegramUserId: tgUser.id,
    telegramUsername: tgUser.username,
    firstName: tgUser.first_name,
    lastName: tgUser.last_name,
    chatId: chatId || tgUser.id,
    status: 'approved',
    role: isInviteAdmin || existing?.role === 'admin' ? 'admin' : 'inspector',
    authMethod: 'invite_code',
    supabaseUserId: existing?.supabaseUserId,
    email: existing?.email,
    displayName: existing?.displayName || fullName,
    linkedAt: new Date().toISOString()
  };

  reg.users[String(tgUser.id)] = userEntry;
  await saveTelegramAuthRegistry(env, reg);
  return { ok: true, user: userEntry };
}

export async function verifySupabaseUserFromToken(
  env: Env,
  accessToken: string
): Promise<{ id: string; email: string; displayName: string; isAdmin: boolean } | null> {
  if (!accessToken) return null;
  const sb = getSupabase(env);
  try {
    const { data, error } = await sb.auth.getUser(accessToken);
    if (error || !data?.user || data.user.is_anonymous) return null;
    const u = data.user;
    const displayName =
      u.user_metadata?.display_name ||
      u.email?.split('@')[0] ||
      u.email ||
      'ECIT User';

    let isAdmin =
      u.app_metadata?.is_room_admin === true ||
      u.app_metadata?.is_admin === true ||
      String(u.app_metadata?.role || '').toLowerCase() === 'admin';

    if (!isAdmin) {
      try {
        const userClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            headers: {
              Authorization: `Bearer ${accessToken}`
            }
          }
        });
        const { data: rpcAdmin } = await userClient.rpc('is_room_admin');
        if (rpcAdmin === true) {
          isAdmin = true;
        }
      } catch {
        // ignore
      }
    }

    return {
      id: u.id,
      email: u.email || '',
      displayName,
      isAdmin
    };
  } catch {
    return null;
  }
}

export async function authenticateWithSupabaseLogin(
  env: Env,
  email: string,
  password: string,
  tgUser: { id: number; username?: string; first_name?: string; last_name?: string },
  chatId?: number
): Promise<{ ok: boolean; user?: TelegramAuthorizedUser; error?: string }> {
  try {
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await sb.auth.signInWithPassword({
      email: email.trim(),
      password
    });
    if (error || !data?.user || !data?.session) {
      return { ok: false, error: error?.message || 'Invalid email or password' };
    }

    const verified = await verifySupabaseUserFromToken(env, data.session.access_token);
    const u = data.user;
    const displayName =
      verified?.displayName ||
      u.user_metadata?.display_name ||
      u.email?.split('@')[0] ||
      'ECIT User';
    const isAdmin = verified?.isAdmin === true;

    const reg = await getTelegramAuthRegistry(env);
    const userEntry: TelegramAuthorizedUser = {
      telegramUserId: tgUser.id,
      telegramUsername: tgUser.username,
      firstName: tgUser.first_name,
      lastName: tgUser.last_name,
      chatId: chatId || tgUser.id,
      status: 'approved',
      role: isAdmin ? 'admin' : 'inspector',
      authMethod: 'supabase_login',
      supabaseUserId: u.id,
      email: u.email || email.trim(),
      displayName,
      linkedAt: new Date().toISOString()
    };

    reg.users[String(tgUser.id)] = userEntry;
    await saveTelegramAuthRegistry(env, reg);
    return { ok: true, user: userEntry };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Authentication failed' };
  }
}

export async function requestTelegramAccess(
  env: Env,
  tgUser: { id: number; username?: string; first_name?: string; last_name?: string },
  chatId?: number
): Promise<{ user: TelegramAuthorizedUser; adminChatIds: number[] }> {
  const reg = await getTelegramAuthRegistry(env);
  const existing = reg.users[String(tgUser.id)];
  const fullName =
    [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') ||
    tgUser.username ||
    `Telegram #${tgUser.id}`;

  const entry: TelegramAuthorizedUser = existing
    ? {
        ...existing,
        telegramUsername: tgUser.username || existing.telegramUsername,
        firstName: tgUser.first_name || existing.firstName,
        lastName: tgUser.last_name || existing.lastName,
        chatId: chatId || existing.chatId || tgUser.id,
        status: existing.status === 'approved' ? 'approved' : 'pending'
      }
    : {
        telegramUserId: tgUser.id,
        telegramUsername: tgUser.username,
        firstName: tgUser.first_name,
        lastName: tgUser.last_name,
        chatId: chatId || tgUser.id,
        status: 'pending',
        role: 'inspector',
        authMethod: 'admin_approved',
        displayName: fullName,
        linkedAt: new Date().toISOString()
      };

  reg.users[String(tgUser.id)] = entry;
  await saveTelegramAuthRegistry(env, reg);

  const adminChatIds = Object.values(reg.users)
    .filter(u => u.status === 'approved' && u.role === 'admin' && u.chatId)
    .map(u => u.chatId!);

  return { user: entry, adminChatIds };
}

export async function setTelegramUserStatus(
  env: Env,
  targetTelegramId: number,
  status: 'approved' | 'revoked' | 'pending',
  role: 'admin' | 'inspector',
  approvedBy: string,
  extra?: { displayName?: string; telegramUsername?: string }
): Promise<TelegramAuthorizedUser> {
  const reg = await getTelegramAuthRegistry(env);
  const existing = reg.users[String(targetTelegramId)];
  const updated: TelegramAuthorizedUser = {
    telegramUserId: targetTelegramId,
    telegramUsername: extra?.telegramUsername || existing?.telegramUsername,
    firstName: existing?.firstName,
    lastName: existing?.lastName,
    chatId: existing?.chatId || targetTelegramId,
    status,
    role,
    authMethod: existing?.authMethod || 'admin_approved',
    supabaseUserId: existing?.supabaseUserId,
    email: existing?.email,
    displayName: extra?.displayName || existing?.displayName || `Telegram #${targetTelegramId}`,
    linkedAt: existing?.linkedAt || new Date().toISOString(),
    approvedBy
  };

  reg.users[String(targetTelegramId)] = updated;
  await saveTelegramAuthRegistry(env, reg);
  return updated;
}

export async function unlinkTelegramUser(
  env: Env,
  opts: { telegramUserId?: number; supabaseUserId?: string }
): Promise<number> {
  const reg = await getTelegramAuthRegistry(env);
  let removed = 0;
  for (const [k, u] of Object.entries(reg.users)) {
    if (
      (opts.telegramUserId && u.telegramUserId === opts.telegramUserId) ||
      (opts.supabaseUserId && u.supabaseUserId === opts.supabaseUserId)
    ) {
      delete reg.users[k];
      removed++;
    }
  }
  if (removed > 0) {
    await saveTelegramAuthRegistry(env, reg);
  }
  return removed;
}

// ================= WEBSITE USERS MANAGEMENT (SUPABASE AUTH ADMIN) =================

function mapAuthUserToWebSiteUser(
  u: any,
  tgUsers: TelegramAuthorizedUser[]
): WebSiteUser {
  const displayName =
    u.user_metadata?.display_name ||
    u.email?.split('@')[0] ||
    u.email ||
    'User';
  const rawInvite =
    u.user_metadata?.invite_code ||
    u.user_metadata?.invitation_code ||
    '';
  const inviteCode = rawInvite && rawInvite.length <= 24 ? rawInvite : rawInvite ? 'TOKEN' : '';

  const isAdmin =
    u.app_metadata?.is_room_admin === true ||
    u.app_metadata?.is_admin === true ||
    String(u.app_metadata?.role || '').toLowerCase() === 'admin';

  const bannedUntil = u.banned_until || null;
  const isBanned =
    !!bannedUntil &&
    bannedUntil !== 'none' &&
    new Date(bannedUntil).getTime() > Date.now();

  const linkedTg = tgUsers.find(
    t =>
      t.supabaseUserId === u.id ||
      (u.email && t.email && t.email.toLowerCase() === u.email.toLowerCase())
  );

  return {
    id: u.id,
    email: u.email || '',
    displayName,
    inviteCode,
    isAdmin,
    isBanned,
    bannedUntil,
    createdAt: u.created_at || '',
    lastSignInAt: u.last_sign_in_at || null,
    linkedTelegram: linkedTg
      ? {
          telegramUserId: linkedTg.telegramUserId,
          telegramUsername: linkedTg.telegramUsername,
          status: linkedTg.status
        }
      : null
  };
}

export async function listRegisteredWebUsers(env: Env): Promise<WebSiteUser[]> {
  const sb = getSupabase(env);
  const [{ data, error }, reg] = await Promise.all([
    sb.auth.admin.listUsers({ page: 1, perPage: 200 }),
    getTelegramAuthRegistry(env)
  ]);
  if (error) throw error;
  const tgList = Object.values(reg.users);
  return (data?.users || [])
    .filter((u: any) => !u.is_anonymous && u.email)
    .map((u: any) => mapAuthUserToWebSiteUser(u, tgList))
    .sort((a, b) => {
      if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
      return (b.lastSignInAt || b.createdAt || '').localeCompare(a.lastSignInAt || a.createdAt || '');
    });
}

export async function adminCreateWebUser(
  env: Env,
  input: {
    email: string;
    password: string;
    displayName?: string;
    role?: 'admin' | 'inspector';
  }
): Promise<WebSiteUser> {
  const sb = getSupabase(env);
  const email = input.email.trim();
  const displayName = (input.displayName || '').trim() || email.split('@')[0];
  const isAdmin = input.role === 'admin';

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    user_metadata: {
      display_name: displayName,
      invite_code: 'ADMIN-CREATED'
    },
    app_metadata: {
      is_room_admin: isAdmin,
      role: isAdmin ? 'admin' : 'inspector'
    }
  });
  if (error || !data?.user) {
    throw error || new Error('Failed to create user');
  }
  const reg = await getTelegramAuthRegistry(env);
  return mapAuthUserToWebSiteUser(data.user, Object.values(reg.users));
}

export async function adminUpdateWebUser(
  env: Env,
  input: {
    userId: string;
    displayName?: string;
    password?: string;
    role?: 'admin' | 'inspector';
    banned?: boolean;
  }
): Promise<WebSiteUser> {
  const sb = getSupabase(env);
  const { data: existingData, error: getErr } = await sb.auth.admin.getUserById(input.userId);
  if (getErr || !existingData?.user) {
    throw getErr || new Error('User not found');
  }
  const existing = existingData.user;
  const attrs: any = {};

  if (typeof input.displayName === 'string' && input.displayName.trim()) {
    attrs.user_metadata = {
      ...(existing.user_metadata || {}),
      display_name: input.displayName.trim()
    };
  }

  if (input.role === 'admin' || input.role === 'inspector') {
    const makeAdmin = input.role === 'admin';
    attrs.app_metadata = {
      ...(existing.app_metadata || {}),
      is_room_admin: makeAdmin,
      role: makeAdmin ? 'admin' : 'inspector'
    };
  }

  if (typeof input.password === 'string' && input.password.trim().length >= 6) {
    attrs.password = input.password.trim();
  }

  if (typeof input.banned === 'boolean') {
    attrs.ban_duration = input.banned ? '876000h' : 'none';
  }

  const { data: updatedData, error: upErr } = await sb.auth.admin.updateUserById(input.userId, attrs);
  if (upErr || !updatedData?.user) {
    throw upErr || new Error('Failed to update user');
  }

  // Sync linked Telegram user if any
  const reg = await getTelegramAuthRegistry(env);
  let regChanged = false;
  for (const tg of Object.values(reg.users)) {
    if (
      tg.supabaseUserId === input.userId ||
      (existing.email && tg.email && tg.email.toLowerCase() === existing.email.toLowerCase())
    ) {
      if (typeof input.displayName === 'string' && input.displayName.trim()) {
        tg.displayName = input.displayName.trim();
        regChanged = true;
      }
      if (input.role === 'admin' || input.role === 'inspector') {
        tg.role = input.role;
        regChanged = true;
      }
      if (typeof input.banned === 'boolean') {
        tg.status = input.banned ? 'revoked' : 'approved';
        regChanged = true;
      }
    }
  }
  if (regChanged) {
    await saveTelegramAuthRegistry(env, reg);
  }

  return mapAuthUserToWebSiteUser(updatedData.user, Object.values(reg.users));
}

export async function adminDeleteWebUser(env: Env, userId: string): Promise<void> {
  const sb = getSupabase(env);
  const { error } = await sb.auth.admin.deleteUser(userId);
  if (error) throw error;
  await unlinkTelegramUser(env, { supabaseUserId: userId });
}
