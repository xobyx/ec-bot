import type { Env, ParsedSiteUpdate,MicroTaskLibrary } from './types';

function buildMicroTaskPromptSection(lib: MicroTaskLibrary): string {
  if (!lib.library.length) return '';

  const lines: string[] = [
    '',
    '- Micro-task Prep Steps (preparatory tasks tracked under each finish code):',
    '  These are sub-steps engineers complete before a finish item is done.',
    '  If the engineer mentions a prep step by name, extract it as a "microTask".',
    '  Known micro-tasks (name → id):'
  ];

  lib.library.forEach(m => {
    lines.push(`    * "${m.name}" → id: "${m.id}"`);
  });

  if (Object.keys(lib.codeTemplates).length) {
    lines.push('  Default micro-tasks per finish code (use this to infer which finishCode the prep step belongs to):');
    for (const [code, ids] of Object.entries(lib.codeTemplates)) {
      const names = ids
        .map(id => lib.library.find(m => m.id === id)?.name || id)
        .join(', ');
      lines.push(`    * ${code}: ${names}`);
    }
  }

  return lines.join('\n');
}
function buildSystemPrompt(microLib?: MicroTaskLibrary): string {
    const microSection = microLib ? buildMicroTaskPromptSection(microLib) : '';
    return `You are an expert AI site engineer assistant for the ECIT Building Construction Site Tracker.
Your job is to analyze site messages and photos submitted by site engineers via Telegram, and extract structured progress updates, finishes, and snags (defects).

Project details:
- Levels: 0 (Ground Floor / GF), 1 (1st / F1 / L1), 2 (2nd / F2 / L2), 3 (3rd / F3 / L3), 4 (4th / F4 / L4), 5 (5th / F5 / L5), 6 (6th / F6 / L6), 7 (7th / F7 / L7), 8 (8th / F8 / L8).
  If level is NOT mentioned and cannot be inferred from a room code like GF-008 or F4-041, level MUST be null.
- Zones: 1, 2, 3, 4, or 0 (all zones). If message mentions "zone 2" or "z2", zone MUST be 2. If zone is NOT mentioned, zone MUST be null.
- Room Codes (spaceCode): Often formatted like "GF-008", "F1-021", "F1-040C", "F4-041".
  - "GF-xxx" implies level = 0.
  - "F1-xxx" implies level = 1, "F4-xxx" implies level = 4, etc.
- Known Space Names:
  GARBAGE ROOM, GARBAGE CHUTE, POD TOILET, MALE TOILET, FEMALE TOILET, TOILET, CORRIDOR, 2.40 M SERVICE CORRIDOR,
  JANITOR, STORE ROOM, FM OFFICE & STORE, FM OFFICE PANTRY, AHU ROOM, ELEC. ROOM, ELEC. CABINET, ELV. RM.,
  LIFT LOBBY, SERVICE LIFT LOBBY, STAIRCASE, AUDITORIUM, PRODUCTION ROOM, CCU ROOM, GENERATOR ROOM,
  IDF RM, SERVER ROOM, KITCHEN, PANTRY, MEP, MEP SHAFT, SHAFT, P.SHAFT, F.H.R., OFFICE SPACE.

- Finish Categories and common codes:
  * Floor (F):
    - F02: Power floated screed with fibres (standard screed in garbage rooms, service corridors, utility rooms, plant rooms)
    - F03: Screed for vinyl/carpet/tiles + waterproofing (toilets, wet areas, auditoriums)
    - F06: Epoxy coating
    - F08: Vitrified porcelain tiles
    - F09: Glazed ceramic tiles
    - F16: 20mm full body porcelain
  * Wall (W):
    - W01: Bare blockwork
    - W02: Spray plaster
    - W03: Cement sand plaster
    - W04: Paint system-1 washable
    - W05 / W05A / W05B: Anti-fungal paint systems
    - W07 / W08 / W90: Wall tiles
  * Ceiling (C):
    - C01: Bare slab soffit
    - C03: Gypsum board ceiling
    - C07 / C08: 600x600 Gypsum tiles on exposed T-grid
  * Skirting (S): S01-S13.

- Status values must be strictly: "pending", "ongoing", "done", or null if not mentioned.
- Snag trades: "Paint", "Plaster", "Tile", "Floor", "Ceiling", "MEP", "Civil", "Joinery", "Glazing", "General".
${microSection}
CRITICAL EXTRACTION RULES:
1. "level": Extract level number (0..8) ONLY if mentioned or inferred from room code (e.g. GF-008 -> 0, F4-041 -> 4). Otherwise null!
2. "zone": Extract zone number (1..4, or 0 if "all zones") ONLY if mentioned. Otherwise null!
3. "space": Put the uppercase Space Name here (e.g. "GARBAGE ROOM", "POD TOILET", "CORRIDOR", "MEP SHAFT"). If not mentioned, null!
4. "spaceCode" / "spaceNo": Put explicit room code (e.g. "GF-008", "F1-040C", "F4-041", "204") ONLY if explicitly written. Never invent a room number!
5. "microTask": If the engineer mentions a prep step by name (e.g. "water proofing done", "layout drawing ongoing", "suspension started"),
   fill microTask with the matching { "id": "...", "name": "..." } from the known micro-tasks list above.
   Also set "finishCode" to the finish code this prep step belongs to (use the "Default micro-tasks per finish code" table as a guide).
   If the message is about a WHOLE finish item (not a specific prep step), set microTask to null.

You MUST return ONLY a valid JSON object with the following schema:
{
  "level": number or null,
  "zone": number or null,
  "space": string or null,
  "spaceNo": string or null,
  "spaceCode": string or null,
  "finishCode": string or null,
  "finishKind": "Floor" | "Skirting" | "Wall" | "Ceiling" | null,
  "status": "pending" | "ongoing" | "done" | null,
  "snag": {
    "text": string,
    "trade": string
  } or null,
  "microTask": { "id": string, "name": string } or null,
  "notes": string,
  "summary": string
}
No markdown fences, no explanation, only the JSON.`;
}
export function normalizeScheduleCodeInput(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s || /^[ZLF]\d$/i.test(s)) return null;
  const m = s.match(/^(GF|F[1-8])[-\s]?(\d{2,4}[A-Z]?)$/i);
  if (m) {
    return `${m[1].toUpperCase()}-${m[2].toUpperCase()}`;
  }
  return s;
}

export function resolveMicroTaskFromLibrary(
  text: string,
  rawMicro: any,
  currentFinishCode: string | null,
  microLib?: MicroTaskLibrary
): {
  microTask: { id: string; name: string } | null;
  inferredFinishCode: string | null;
} {
  const lib = microLib?.library || [];
  const templates = microLib?.codeTemplates || {};
  const norm = (s: string) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');

  let matched: { id: string; name: string } | null = null;

  // 1. Check AI-provided microTask first
  if (rawMicro) {
    const rawId = typeof rawMicro === 'object' ? String(rawMicro.id || '').trim() : '';
    const rawName =
      typeof rawMicro === 'string'
        ? rawMicro.trim()
        : typeof rawMicro === 'object'
          ? String(rawMicro.name || '').trim()
          : '';

    if (lib.length > 0) {
      const byExactId = rawId ? lib.find(m => m.id === rawId) : undefined;
      const byExactName = rawName
        ? lib.find(m => m.name.toLowerCase() === rawName.toLowerCase())
        : undefined;
      const byNormName = rawName
        ? lib.find(
            m =>
              norm(m.name) === norm(rawName) ||
              norm(m.name).includes(norm(rawName)) ||
              norm(rawName).includes(norm(m.name))
          )
        : undefined;
      const found = byExactId || byExactName || byNormName;
      if (found) {
        matched = { id: found.id, name: found.name };
      }
    }

    if (!matched && rawId && rawName) {
      matched = { id: rawId, name: rawName };
    }
  }

  // 2. Fallback: scan user text for known micro-tasks in library
  if (!matched && text && lib.length > 0) {
    const lowerText = text.toLowerCase();
    const normText = norm(text);
    const sortedLib = [...lib].sort((a, b) => b.name.length - a.name.length);
    for (const item of sortedLib) {
      const itemLower = item.name.toLowerCase().trim();
      const itemNorm = norm(item.name);
      if (itemLower.length >= 3 && (lowerText.includes(itemLower) || (itemNorm.length >= 5 && normText.includes(itemNorm)))) {
        matched = { id: item.id, name: item.name };
        break;
      }
    }
  }

  // 3. Infer finishCode from codeTemplates if needed
  let inferredFinishCode = currentFinishCode;
  if (matched) {
    const matchingCodes = Object.entries(templates)
      .filter(([, ids]) => Array.isArray(ids) && ids.includes(matched!.id))
      .map(([code]) => code.toUpperCase());

    if (matchingCodes.length > 0) {
      if (!inferredFinishCode || !matchingCodes.includes(inferredFinishCode.toUpperCase())) {
        inferredFinishCode = matchingCodes[0];
      }
    }
  }

  return { microTask: matched, inferredFinishCode };
}

export async function analyzeSiteUpdate(
  env: Env,
  text: string,
  imageBytes?: Uint8Array,
  microLib?: MicroTaskLibrary
): Promise<ParsedSiteUpdate> {
  const SYSTEM_PROMPT = buildSystemPrompt(microLib);
  if (env.GEMINI_API_KEY) {
    try {
      return await analyzeWithGemini(env.GEMINI_API_KEY, SYSTEM_PROMPT, text, imageBytes, microLib);
    } catch (err) {
      console.error('Gemini analysis failed, falling back to Workers AI:', err);
    }
  }
  return await analyzeWithWorkersAI(env.AI, SYSTEM_PROMPT, text, imageBytes, microLib);
}

async function analyzeWithWorkersAI(
  ai: any,
  SYSTEM_PROMPT: string,
  text: string,
  imageBytes?: Uint8Array,
  microLib?: MicroTaskLibrary
): Promise<ParsedSiteUpdate> {
  const promptText = `User message: "${text || 'Please inspect attached site photo'}"`;

  try {
    let result: any;
    if (imageBytes && imageBytes.length > 0) {
      const imageArray = [...imageBytes];
      result = await ai.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        prompt: `${SYSTEM_PROMPT}\n\n${promptText}`,
        image: imageArray,
        max_tokens: 512
      });
    } else {
      result = await ai.run('@cf/meta/llama-3.2-3b-instruct', {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: promptText }
        ],
        max_tokens: 512
      });
    }

    const responseText = result?.response || (typeof result === 'string' ? result : JSON.stringify(result));
    return parseCleanJson(responseText, text, undefined, microLib, 'Cloudflare AI');
  } catch (err: any) {
    console.error('Workers AI execution error:', err);
    return fallbackHeuristicParser(text, microLib);
  }
}

async function analyzeWithGemini(
  apiKey: string,
  SYSTEM_PROMPT: string,
  text: string,
  imageBytes?: Uint8Array,
  microLib?: MicroTaskLibrary
): Promise<ParsedSiteUpdate> {
  const parts: any[] = [];
  parts.push({ text: `${SYSTEM_PROMPT}\n\nAnalyze this site update: "${text || 'Please inspect photo'}"` });

  if (imageBytes && imageBytes.length > 0) {
    let binary = '';
    const len = imageBytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(imageBytes[i]);
    }
    const base64Data = btoa(binary);

    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: base64Data
      }
    });
  }

  const models = ['gemini-3.1-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastErr: any = null;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.1,
          response_mime_type: 'application/json'
        }
      })
    });

    if (res.ok) {
      const data: any = await res.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return parseCleanJson(rawText, text, data, microLib, 'Gemini');
    }
    lastErr = new Error(`Gemini API error (${model}): ${res.status} ${await res.text()}`);
  }

  throw lastErr || new Error('Gemini API request failed');
}

function parseCleanJson(
  raw: string,
  fallbackText: string,
  org?: any,
  microLib?: MicroTaskLibrary,
  aiEngine = 'AI'
): ParsedSiteUpdate {
  try {
    const cleaned = raw.replace(/^```json/im, '').replace(/^```/im, '').replace(/```$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    const heuristic = fallbackHeuristicParser(fallbackText, microLib);

    const cleanSpaceCode = normalizeScheduleCodeInput(
      parsed.spaceCode || parsed.spaceNo || heuristic.spaceCode || ''
    );

    let level: number | null = typeof parsed.level === 'number' ? parsed.level : heuristic.level;
    const zone: number | null = typeof parsed.zone === 'number' ? parsed.zone : heuristic.zone;

    if (level === null && cleanSpaceCode) {
      if (/^GF-\d+/i.test(cleanSpaceCode)) level = 0;
      else {
        const m = cleanSpaceCode.match(/^F(\d)-\d+/i);
        if (m) level = parseInt(m[1], 10);
      }
    }

    const space = (parsed.space && parsed.space !== 'SITE' ? String(parsed.space).toUpperCase() : null) || heuristic.space;
    const rawFinishCode = (parsed.finishCode ? String(parsed.finishCode).toUpperCase() : null) || heuristic.finishCode;
    const status = ['pending', 'ongoing', 'done'].includes(parsed.status)
      ? parsed.status
      : heuristic.status;

    const { microTask, inferredFinishCode } = resolveMicroTaskFromLibrary(
      fallbackText,
      parsed.microTask || heuristic.microTask,
      rawFinishCode,
      microLib
    );
    const finishCode = inferredFinishCode || rawFinishCode;

    return {
      level,
      zone,
      space,
      spaceNo: cleanSpaceCode,
      spaceCode: cleanSpaceCode,
      finishCode,
      finishKind: parsed.finishKind || heuristic.finishKind || null,
      status,
      snag:
        parsed.snag && parsed.snag.text
          ? {
              text: String(parsed.snag.text),
              trade: parsed.snag.trade || 'General'
            }
          : heuristic.snag,
      notes: parsed.notes || fallbackText,
      summary: parsed.summary || heuristic.summary || 'Site update parsed',
      microTask,
      aiEngine,
      orginal: org
    };
  } catch (e) {
    console.error('Failed to parse AI JSON:', raw, e);
    return fallbackHeuristicParser(fallbackText, microLib);
  }
}

const KNOWN_SPACES = [
  '2.40 M SERVICE CORRIDOR', 'SERVICE LIFT LOBBY', 'FM OFFICE & STORE', 'FM OFFICE PANTRY',
  'GARBAGE ROOM', 'GARBAGE CHUTE', 'POD TOILET', 'MALE TOILET', 'FEMALE TOILET', 'TOILET',
  'CORRIDOR', 'JANITOR', 'STORE ROOM', 'AHU ROOM', 'ELEC. ROOM', 'ELEC. CABINET', 'ELV. RM.',
  'LIFT LOBBY', 'STAIRCASE', 'AUDITORIUM', 'PRODUCTION ROOM', 'CCU ROOM', 'GENERATOR ROOM',
  'IDF RM', 'SERVER ROOM', 'KITCHEN', 'PANTRY', 'MEP SHAFT', 'MEP', 'P.SHAFT', 'SHAFT', 'F.H.R.'
];

export function fallbackHeuristicParser(
  text: string,
  microLib?: MicroTaskLibrary
): ParsedSiteUpdate {
  const upper = (text || '').toUpperCase();

  // 1. Match explicit Room Code like GF-008, GF008, F1-021, F1-040C, F4-041
  let spaceCode: string | null = null;
  const schedCodeMatch = upper.match(/\b(GF[-\s]?\d{2,4}[A-Z]?|F[1-8][-\s]?\d{2,4}[A-Z]?)\b/i);
  if (schedCodeMatch) {
    spaceCode = normalizeScheduleCodeInput(schedCodeMatch[1]);
  }

  // 2. Match Level (e.g. GF, GROUND FLOOR, L2, LEVEL 2, FLOOR 2)
  let level: number | null = null;
  if (/\b(?:GF|GROUND\s*FLOOR|LEVEL\s*0|L0)\b/i.test(upper)) {
    level = 0;
  } else {
    const levelMatch = upper.match(/\b(?:L|LEVEL|FLOOR|F)\s*([0-8])\b/i);
    if (levelMatch) {
      level = parseInt(levelMatch[1], 10);
    }
  }
  if (level === null && spaceCode) {
    if (spaceCode.startsWith('GF-')) level = 0;
    else {
      const m = spaceCode.match(/^F(\d)-/);
      if (m) level = parseInt(m[1], 10);
    }
  }

  // 3. Match Zone (e.g. Z1, ZONE 2, ALL ZONES)
  let zone: number | null = null;
  if (/\bALL\s*ZONES?\b/i.test(upper)) {
    zone = 0;
  } else {
    const zoneMatch = upper.match(/\b(?:Z|ZONE)\s*([1-4])\b/i);
    if (zoneMatch) {
      zone = parseInt(zoneMatch[1], 10);
    }
  }

  // 4. Match Space Name
  let space: string | null = null;
  for (const s of KNOWN_SPACES) {
    if (upper.includes(s)) {
      space = s;
      break;
    }
  }

  // 5. Match explicit room number if no schedule code yet
  if (!spaceCode) {
    const textWithoutSpace = space ? upper.replace(space, '') : upper;
    const roomMatch = textWithoutSpace.match(/\b(?:ROOM|RM|R|#)\s*([A-Z0-9-]*\d+[A-Z0-9-]*)\b/i);
    if (roomMatch && /\d/.test(roomMatch[1])) {
      const cand = normalizeScheduleCodeInput(roomMatch[1]);
      if (cand) {
        spaceCode = cand;
      }
    }
  }

  // 6. Match explicit finish code (e.g. F02, W04, W05A, C07, S02) or keyword
  let finishCode: string | null = null;
  let finishKind: 'Floor' | 'Skirting' | 'Wall' | 'Ceiling' | null = null;

  const explicitFinish = upper.match(/\b([FWCS]\d{2}[A-Z]?)\b/);
  if (explicitFinish) {
    finishCode = explicitFinish[1];
    const p = finishCode[0];
    finishKind = p === 'F' ? 'Floor' : p === 'W' ? 'Wall' : p === 'C' ? 'Ceiling' : 'Skirting';
  } else if (/WATER\s*PROOF/i.test(upper)) {
    finishCode = 'F03';
    finishKind = 'Floor';
  } else if (/SCREED/i.test(upper)) {
    finishCode = 'F02';
    finishKind = 'Floor';
  } else if (/EPOXY/i.test(upper)) {
    finishCode = 'F06';
    finishKind = 'Floor';
  } else if (/PAINT/i.test(upper)) {
    finishCode = 'W04';
    finishKind = 'Wall';
  } else if (/PLASTER/i.test(upper)) {
    finishCode = 'W02';
    finishKind = 'Wall';
  } else if (/BLOCK\s*WORK|BLOCK/i.test(upper)) {
    finishCode = 'W01';
    finishKind = 'Wall';
  } else if (/WALL\s*TILE/i.test(upper)) {
    finishCode = 'W08';
    finishKind = 'Wall';
  } else if (/TILE|TILES|TILING|PORCELAIN|CERAMIC/i.test(upper)) {
    finishCode = 'F08';
    finishKind = 'Floor';
  } else if (/T-?GRID|SUSPENSION|600X600/i.test(upper)) {
    finishCode = 'C07';
    finishKind = 'Ceiling';
  } else if (/CEILING|GYPSUM/i.test(upper)) {
    finishCode = 'C03';
    finishKind = 'Ceiling';
  } else if (/SKIRT/i.test(upper)) {
    finishCode = 'S01';
    finishKind = 'Skirting';
  }

  // 7. Match status
  let status: 'pending' | 'ongoing' | 'done' | null = null;
  if (/\b(?:DONE|COMPLETE|COMPLETED|FINISHED|PASSED|READY)\b/i.test(upper)) status = 'done';
  else if (/\b(?:ONGOING|IN\s*PROGRESS|STARTED|PROGRESS|WORKING|WIP)\b/i.test(upper)) status = 'ongoing';
  else if (/\b(?:PENDING|NOT\s*STARTED|HOLD|WAIT)\b/i.test(upper)) status = 'pending';

  // 8. Check for snag keyword
  let snag: { text: string; trade: string } | null = null;
  if (/\b(?:SNAG|DEFECT|ISSUE|CRACK|LEAK|DAMAGE|LIPPAGE|SCRATCH|BROKEN|MISSING|TOUCH\s*UP)\b/i.test(upper)) {
    let trade = 'General';
    if (/TILE|GROUT|LIPPAGE|PORCELAIN|CERAMIC/i.test(upper)) trade = 'Tile';
    else if (/PAINT|COAT|TOUCH\s*UP/i.test(upper)) trade = 'Paint';
    else if (/PLASTER|CRACK|BLOCK/i.test(upper)) trade = 'Civil';
    else if (/CEILING|GRID|GYPSUM/i.test(upper)) trade = 'Ceiling';
    else if (/PIPE|LEAK|DUCT|CABLE|MEP|DRAIN|SOCKET|LIGHT/i.test(upper)) trade = 'MEP';
    snag = {
      text: text.replace(/^snag\s*[:\-]?\s*/i, '').trim() || text,
      trade
    };
  }

  // 9. Match micro-task prep step if present in microLib
  const { microTask, inferredFinishCode } = resolveMicroTaskFromLibrary(
    text,
    null,
    finishCode,
    microLib
  );
  if (inferredFinishCode) {
    finishCode = inferredFinishCode;
    const p = finishCode.charAt(0).toUpperCase();
    finishKind = p === 'F' ? 'Floor' : p === 'W' ? 'Wall' : p === 'C' ? 'Ceiling' : 'Skirting';
  }

  const spaceTitle = spaceCode ? `${space || 'Room'} (${spaceCode})` : space || 'Room';
  const targetDesc = microTask
    ? ` Prep "${microTask.name}"${finishCode ? ` [${finishCode}]` : ''}`
    : finishCode
      ? ` ${finishCode}`
      : '';

  return {
    level,
    zone,
    space,
    spaceNo: spaceCode,
    spaceCode,
    finishCode,
    finishKind,
    status,
    snag,
    microTask,
    aiEngine: 'Heuristic',
    notes: text,
    summary: `${spaceTitle}${targetDesc}${status ? ` → ${status.toUpperCase()}` : ''}`
  };
}
