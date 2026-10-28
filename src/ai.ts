import type { Env, ParsedSiteUpdate } from './types';

const SYSTEM_PROMPT = `You are an expert AI site engineer assistant for the ECIT Building Construction Site Tracker.
Your job is to analyze site messages and photos submitted by site engineers via Telegram, and extract structured progress updates, finishes, and snags (defects).

Project details:
- Levels: 0 (Ground), 1 (1st), 2 (2nd), 3 (3rd), 4 (4th), 5 (5th), 6 (6th), 7 (7th), 8 (8th).
- Zones: 1, 2, 3, 4, or 0 (all zones). If message mentions "zone 2" or "z2", zone MUST be 2.
- Known Space Names:
  GARBAGE ROOM, GARBAGE CHUTE, POD TOILET, MALE TOILET, FEMALE TOILET, TOILET, CORRIDOR, 2.40 M SERVICE CORRIDOR,
  JANITOR, STORE ROOM, FM OFFICE & STORE, FM OFFICE PANTRY, AHU ROOM, ELEC. ROOM, ELEC. CABINET, ELV. RM.,
  LIFT LOBBY, SERVICE LIFT LOBBY, STAIRCASE, AUDITORIUM, PRODUCTION ROOM, CCU ROOM, GENERATOR ROOM,
  IDF RM, SERVER ROOM, KITCHEN, PANTRY, MEP, SHAFT, P.SHAFT, F.H.R., OFFICE SPACE.

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
- Snag trades: "Painting", "Plastering", "Tiling", "Flooring", "Ceiling", "MEP", "Electrical", "Plumbing", "HVAC", "Carpentry", "Civil", "Cleaning", "General".

CRITICAL EXTRACTION RULES:
1. "space": Put the uppercase Space Name here (e.g. "GARBAGE ROOM", "POD TOILET", "CORRIDOR").
2. "spaceNo": ONLY fill this if the user EXPLICITLY wrote a room number (e.g. "204", "105", "G-01").
   If the user only named the space (e.g. "garbage room", "toilet"), spaceNo MUST BE null! DO NOT INVENT A ROOM NUMBER.
3. "zone": Extract the zone number (1, 2, 3, 4). If the user mentions "zone 2", zone MUST BE 2.
4. "finishCode": If user mentions "screed" in a service area, garbage room, or corridor, map to "F02".

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
  // If user provided GEMINI_API_KEY, use Gemini Flash
  if (env.GEMINI_API_KEY) {
    try {
      return await analyzeWithGemini(env.GEMINI_API_KEY, text, imageBytes);
    } catch (err) {
      console.error('Gemini analysis failed, falling back to Workers AI:', err);
    }
  }

  // Otherwise, use Cloudflare Workers AI
  return await analyzeWithWorkersAI(env.AI, text, imageBytes);
}

async function analyzeWithWorkersAI(
  ai: any,
  text: string,
  imageBytes?: Uint8Array
): Promise<ParsedSiteUpdate> {
  let promptText = `User message: "${text || 'Please inspect attached site photo'}"`;

  try {
    let result: any;
    if (imageBytes && imageBytes.length > 0) {
      // Use Llama 3.2 Vision on Cloudflare Workers AI
      // Convert image bytes to number array for Cloudflare Workers AI vision input
      const imageArray = [...imageBytes];
      result = await ai.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        prompt: `${SYSTEM_PROMPT}\n\n${promptText}`,
        image: imageArray,
        max_tokens: 512
      });
    } else {
      // Text-only model
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
    // Fallback heuristic parser if AI temporarily fails
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
    // Convert Uint8Array to base64
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

    let cleanSpaceNo = parsed.spaceNo ? String(parsed.spaceNo).trim() : null;
    // Discard spaceNo if it's accidentally a Zone (Z1..Z4) or Level (L0..L8)
    if (cleanSpaceNo && /^[ZL]\d$/i.test(cleanSpaceNo)) {
      cleanSpaceNo = null;
    }

    return {
      level: typeof parsed.level === 'number' ? parsed.level : null,
      zone: typeof parsed.zone === 'number' ? parsed.zone : null,
      space: parsed.space || null,
      spaceNo: cleanSpaceNo,
      spaceCode: cleanSpaceNo,
      finishCode: parsed.finishCode ? String(parsed.finishCode).toUpperCase() : null,
      finishKind: parsed.finishKind || null,
      status: ['pending', 'ongoing', 'done'].includes(parsed.status) ? parsed.status : null,
      snag: parsed.snag && parsed.snag.text ? {
        text: String(parsed.snag.text),
        trade: parsed.snag.trade || 'General'
      } : null,
      notes: parsed.notes || fallbackText,
      summary: parsed.summary || 'Site update parsed'
    };
  } catch (e) {
    console.error('Failed to parse AI JSON:', raw, e);
    return fallbackHeuristicParser(fallbackText);
  }
}

const KNOWN_SPACES = [
  'GARBAGE ROOM', 'GARBAGE CHUTE', 'POD TOILET', 'MALE TOILET', 'FEMALE TOILET', 'TOILET',
  '2.40 M SERVICE CORRIDOR', 'CORRIDOR', 'JANITOR', 'STORE ROOM', 'FM OFFICE & STORE',
  'FM OFFICE PANTRY', 'AHU ROOM', 'ELEC. ROOM', 'ELEC. CABINET', 'ELV. RM.',
  'SERVICE LIFT LOBBY', 'LIFT LOBBY', 'STAIRCASE', 'AUDITORIUM', 'PRODUCTION ROOM',
  'CCU ROOM', 'GENERATOR ROOM', 'IDF RM', 'SERVER ROOM', 'KITCHEN', 'PANTRY', 'MEP'
];

function fallbackHeuristicParser(text: string): ParsedSiteUpdate {
  const upper = text.toUpperCase();

  // 1. Match Level (e.g. L2, LEVEL 2, FLOOR 2)
  const levelMatch = upper.match(/(?:L|LEVEL|FLOOR)\s*(\d)/i);
  const level = levelMatch ? parseInt(levelMatch[1], 10) : null;

  // 2. Match Zone (e.g. Z1, ZONE 2)
  const zoneMatch = upper.match(/(?:Z|ZONE)\s*(\d)/i);
  const zone = zoneMatch ? parseInt(zoneMatch[1], 10) : null;

  // 3. Match Space Name (from known spaces list)
  let space: string | null = null;
  for (const s of KNOWN_SPACES) {
    if (upper.includes(s)) {
      space = s;
      break;
    }
  }

  // 4. Match explicit numeric room number (e.g. ROOM 204, R102, #204)
  // Only if digits are present, avoiding words like "ROOM" alone or zone tags (Z1, Z2)
  let spaceNo: string | null = null;
  const textWithoutSpace = space ? upper.replace(space, '') : upper;
  const roomMatch = textWithoutSpace.match(/\b(?:ROOM|R|#)\s*([A-Z0-9-]*\d+[A-Z0-9-]*)\b/i) ||
                    textWithoutSpace.match(/\b([A-Z]?\d{3}[A-Z]?)\b/i);
  if (roomMatch && /\d/.test(roomMatch[1])) {
    const cand = roomMatch[1].toUpperCase();
    if (!/^[ZL]\d$/i.test(cand) && !/^ZONE/i.test(cand) && !/^LEVEL/i.test(cand)) {
      spaceNo = cand;
    }
  }

  // If no specific space name was matched, fall back to spaceNo or 'SITE'
  if (!space) {
    space = spaceNo ? `ROOM ${spaceNo}` : 'SITE';
  }

  // 5. Match finish and finish code
  let finishCode: string | null = null;
  let finishKind: 'Floor' | 'Skirting' | 'Wall' | 'Ceiling' | null = null;
  if (/SCREED/i.test(upper)) {
    finishCode = 'F02';
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
  } else if (/CEILING/i.test(upper)) {
    finishCode = 'C03';
    finishKind = 'Ceiling';
  }

  // 6. Match status
  let status: 'pending' | 'ongoing' | 'done' | null = null;
  if (/DONE|COMPLETE|COMPLETED|FINISHED/i.test(upper)) status = 'done';
  else if (/ONGOING|IN PROGRESS|STARTED|PROGRESS/i.test(upper)) status = 'ongoing';
  else if (/PENDING|NOT STARTED/i.test(upper)) status = 'pending';

  // 7. Check for snag keyword
  let snag: { text: string; trade: string } | null = null;
  if (/SNAG|DEFECT|ISSUE|CRACK|LEAK|DAMAGE/i.test(upper)) {
    snag = {
      text: text,
      trade: 'General'
    };
  }

  const spaceTitle = spaceNo ? `${space} (Room ${spaceNo})` : space;

  return {
    level,
    zone,
    space,
    spaceNo,
    spaceCode: spaceNo,
    finishCode,
    finishKind,
    status,
    snag,
    notes: text,
    summary: `Update for ${spaceTitle}${status ? ` (${status})` : ''}`
  };
}
