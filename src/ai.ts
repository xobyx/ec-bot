import type { Env, ParsedSiteUpdate } from './types';

const SYSTEM_PROMPT = `You are an expert AI site engineer assistant for the ECIT Building Construction Site Tracker.
Your job is to analyze site messages and photos submitted by site engineers via Telegram, and extract structured progress updates, finishes, and snags (defects).

Project details:
- Levels: 0 (Ground Floor / GF), 1 (1st / F1 / L1), 2 (2nd / F2 / L2), 3 (3rd / F3 / L3), 4 (4th / F4 / L4), 5 (5th / F5 / L5), 6 (6th / F6 / L6), 7 (7th / F7 / L7), 8 (8th / F8 / L8).
  If level is NOT mentioned and cannot be inferred from a room code like GF-008 or F4-041, level MUST be null.
- Zones: 1, 2, 3, 4, or 0 (all zones). If message mentions "zone 2" or "z2", zone MUST be 2. If zone is NOT mentioned, zone MUST be null.
- Room Codes (spaceCode): Often formatted like "GF-008", "F1-021", "F4-041".
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
    - F03: Screed for vinyl/carpet/tiles (toilets, auditoriums)
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

CRITICAL EXTRACTION RULES:
1. "level": Extract level number (0..8) ONLY if mentioned or inferred from room code (e.g. GF-008 -> 0, F4-041 -> 4). Otherwise null!
2. "zone": Extract zone number (1..4, or 0 if "all zones") ONLY if mentioned. Otherwise null!
3. "space": Put the uppercase Space Name here (e.g. "GARBAGE ROOM", "POD TOILET", "CORRIDOR", "MEP SHAFT"). If not mentioned, null!
4. "spaceCode" / "spaceNo": Put explicit room code (e.g. "GF-008", "F4-041", "204") ONLY if explicitly written. Never invent a room number!

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
  "notes": string,
  "summary": string
}
No markdown fences, no explanation, only the JSON.`;

export async function analyzeSiteUpdate(
  env: Env,
  text: string,
  imageBytes?: Uint8Array
): Promise<ParsedSiteUpdate> {
  if (env.GEMINI_API_KEY) {
    try {
      return await analyzeWithGemini(env.GEMINI_API_KEY, text, imageBytes);
    } catch (err) {
      console.error('Gemini analysis failed, falling back to Workers AI:', err);
    }
  }

  return await analyzeWithWorkersAI(env.AI, text, imageBytes);
}

async function analyzeWithWorkersAI(
  ai: any,
  text: string,
  imageBytes?: Uint8Array
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
    return parseCleanJson(responseText, text);
  } catch (err: any) {
    console.error('Workers AI execution error:', err);
    return fallbackHeuristicParser(text);
  }
}

async function analyzeWithGemini(
  apiKey: string,
  text: string,
  imageBytes?: Uint8Array
): Promise<ParsedSiteUpdate> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

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

  if (!res.ok) {
    throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  }

  const data: any = await res.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return parseCleanJson(rawText, text);
}

function parseCleanJson(raw: string, fallbackText: string): ParsedSiteUpdate {
  try {
    const cleaned = raw.replace(/^```json/im, '').replace(/^```/im, '').replace(/```$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    const heuristic = fallbackHeuristicParser(fallbackText);

    let cleanSpaceCode = (parsed.spaceCode || parsed.spaceNo || heuristic.spaceCode || '')
      .toString()
      .trim()
      .toUpperCase() || null;

    if (cleanSpaceCode && /^[ZL]\d$/i.test(cleanSpaceCode)) {
      cleanSpaceCode = null;
    }

    let level: number | null = typeof parsed.level === 'number' ? parsed.level : heuristic.level;
    const zone: number | null = typeof parsed.zone === 'number' ? parsed.zone : heuristic.zone;

    // Infer level from schedule code like GF-008 or F4-041 if level is still null
    if (level === null && cleanSpaceCode) {
      if (/^GF-\d+/i.test(cleanSpaceCode)) level = 0;
      else {
        const m = cleanSpaceCode.match(/^F(\d)-\d+/i);
        if (m) level = parseInt(m[1], 10);
      }
    }

    const space = (parsed.space && parsed.space !== 'SITE' ? String(parsed.space).toUpperCase() : null) || heuristic.space;
    const finishCode = (parsed.finishCode ? String(parsed.finishCode).toUpperCase() : null) || heuristic.finishCode;
    const status = ['pending', 'ongoing', 'done'].includes(parsed.status)
      ? parsed.status
      : heuristic.status;

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
      summary: parsed.summary || heuristic.summary || 'Site update parsed'
    };
  } catch (e) {
    console.error('Failed to parse AI JSON:', raw, e);
    return fallbackHeuristicParser(fallbackText);
  }
}

const KNOWN_SPACES = [
  '2.40 M SERVICE CORRIDOR', 'SERVICE LIFT LOBBY', 'FM OFFICE & STORE', 'FM OFFICE PANTRY',
  'GARBAGE ROOM', 'GARBAGE CHUTE', 'POD TOILET', 'MALE TOILET', 'FEMALE TOILET', 'TOILET',
  'CORRIDOR', 'JANITOR', 'STORE ROOM', 'AHU ROOM', 'ELEC. ROOM', 'ELEC. CABINET', 'ELV. RM.',
  'LIFT LOBBY', 'STAIRCASE', 'AUDITORIUM', 'PRODUCTION ROOM', 'CCU ROOM', 'GENERATOR ROOM',
  'IDF RM', 'SERVER ROOM', 'KITCHEN', 'PANTRY', 'MEP SHAFT', 'MEP', 'P.SHAFT', 'SHAFT', 'F.H.R.'
];

export function fallbackHeuristicParser(text: string): ParsedSiteUpdate {
  const upper = (text || '').toUpperCase();

  // 1. Match explicit Room Code like GF-008, F1-021, F4-041
  let spaceCode: string | null = null;
  const schedCodeMatch = upper.match(/\b(GF-\d{2,4}|F\d-\d{2,4})\b/i);
  if (schedCodeMatch) {
    spaceCode = schedCodeMatch[1].toUpperCase();
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
      const cand = roomMatch[1].toUpperCase();
      if (!/^[ZLF]\d$/i.test(cand)) {
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
  } else if (/TILE|TILES|TILING/i.test(upper)) {
    finishCode = 'F08';
    finishKind = 'Floor';
  } else if (/CEILING|GYPSUM|GRID/i.test(upper)) {
    finishCode = 'C03';
    finishKind = 'Ceiling';
  } else if (/SKIRT/i.test(upper)) {
    finishCode = 'S01';
    finishKind = 'Skirting';
  }

  // 7. Match status
  let status: 'pending' | 'ongoing' | 'done' | null = null;
  if (/\b(?:DONE|COMPLETE|COMPLETED|FINISHED|PASSED)\b/i.test(upper)) status = 'done';
  else if (/\b(?:ONGOING|IN\s*PROGRESS|STARTED|PROGRESS|WORKING)\b/i.test(upper)) status = 'ongoing';
  else if (/\b(?:PENDING|NOT\s*STARTED|HOLD)\b/i.test(upper)) status = 'pending';

  // 8. Check for snag keyword
  let snag: { text: string; trade: string } | null = null;
  if (/\b(?:SNAG|DEFECT|ISSUE|CRACK|LEAK|DAMAGE|LIPPAGE|SCRATCH)\b/i.test(upper)) {
    let trade = 'General';
    if (/TILE|GROUT|LIPPAGE/i.test(upper)) trade = 'Tile';
    else if (/PAINT|COAT/i.test(upper)) trade = 'Paint';
    else if (/PLASTER|CRACK/i.test(upper)) trade = 'Civil';
    else if (/CEILING|GRID/i.test(upper)) trade = 'Ceiling';
    else if (/PIPE|LEAK|DUCT|CABLE|MEP/i.test(upper)) trade = 'MEP';
    snag = {
      text: text.replace(/^snag\s*[:\-]?\s*/i, '').trim() || text,
      trade
    };
  }

  const spaceTitle = spaceCode ? `${space || 'Room'} (${spaceCode})` : space || 'Room';

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
    notes: text,
    summary: `${spaceTitle}${finishCode ? ` ${finishCode}` : ''}${status ? ` → ${status.toUpperCase()}` : ''}`
  };
}
