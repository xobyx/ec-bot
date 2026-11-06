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
  // Do not treat finish codes like F01, F02, F08, F09A, F14A (without hyphen) as room codes
  if (/^[FWCS]\d{2}[A-Z]?$/i.test(s)) return null;

  const m = s.match(/^(G|GF|F0|L0|F[1-8]|L[1-8])[-\s]?(\d{1,4})([A-Z]?)$/i);
  if (m) {
    const rawPrefix = m[1].toUpperCase();
    const prefix =
      rawPrefix === 'G' || rawPrefix === 'GF' || rawPrefix === 'F0' || rawPrefix === 'L0'
        ? 'G'
        : `F${rawPrefix.slice(-1)}`;
    const num = parseInt(m[2], 10);
    const suffix = (m[3] || '').toUpperCase();
    // Toilets on F2..F8 with numbers 96..99 use 2-digit codes (e.g. F2-96, F3-98); all other rooms use 3-digit zero-padded codes (e.g. G-008, F3-066)
    const isUpperToilet = prefix !== 'G' && prefix !== 'F1' && num >= 96 && num <= 99 && !suffix;
    const padded = isUpperToilet ? String(num) : String(num).padStart(3, '0');
    return `${prefix}-${padded}${suffix}`;
  }
  return s;
}

export function canonicalizeMicroTokens(raw: string): string[] {
  const s = String(raw || '')
    .toLowerCase()
    // normalize common site typos & abbreviations
    .replace(/\bwater\s*pro+f(?:ing)?\b/g, 'waterproofing')
    .replace(/\bw\.?\s*p\.?\b/g, 'waterproofing')
    .replace(/\bprep(?:aration|ration|are|ar|ared|aring)?\b/g, 'prepare')
    .replace(/\bprepration\b/g, 'prepare')
    .replace(/\bsusbuntion\b|\bsuspention\b|\bsuspension\b/g, 'suspension')
    .replace(/\bfloot\b/g, 'floor')
    .replace(/\bclearanc(?:e)?\b/g, 'clearance')
    .replace(/\bma?3?j+o+n\b|\bputty\b/g, 'm3joon')
    .replace(/\bmov(?:e)?ment\b/g, 'movement')
    .replace(/\blev(?:e)?l(?:ing|ling)?\b/g, 'leveling')
    .replace(/\bisolat(?:ion)?\b|\binsulat(?:ion)?\b/g, 'isolation');

  const stopWords = new Set([
    'done', 'ongoing', 'pending', 'complete', 'completed', 'finished', 'started',
    'in', 'progress', 'for', 'room', 'rm', 'zone', 'level', 'floor', 'wall', 'ceiling',
    'the', 'is', 'are', 'and', 'with', 'to', 'on', 'at', 'of', 'ok', 'passed', 'ready'
  ]);

  return s
    .split(/[^a-z0-9]+/)
    .filter(tok => tok.length >= 2 && !stopWords.has(tok) && !/^(gf|f[1-8]|l[0-8]|z[1-4]|\d+[a-z]?)$/i.test(tok));
}

function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) {
    const minLen = Math.min(a.length, b.length);
    if (minLen >= 4) return 0.9;
  }
  // Simple Levenshtein distance for typo tolerance (e.g. profing vs proofing)
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 0;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  const dist = dp[m][n];
  const maxLen = Math.max(m, n);
  return maxLen > 0 ? 1 - dist / maxLen : 0;
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
    canonicalizeMicroTokens(s).join('');

  let matched: { id: string; name: string } | null = null;

  const findBestInLib = (queryText: string): { id: string; name: string } | null => {
    if (!queryText || !lib.length) return null;
    const qTokens = canonicalizeMicroTokens(queryText);
    if (!qTokens.length) return null;

    let bestItem: { id: string; name: string } | null = null;
    let bestScore = 0;

    for (const item of lib) {
      const itemTokens = canonicalizeMicroTokens(item.name);
      if (!itemTokens.length) continue;

      // Check how many of itemTokens are matched by qTokens
      let matchedCount = 0;
      let similaritySum = 0;
      for (const iTok of itemTokens) {
        let bestTokSim = 0;
        for (const qTok of qTokens) {
          const sim = tokenSimilarity(iTok, qTok);
          if (sim > bestTokSim) bestTokSim = sim;
        }
        if (bestTokSim >= 0.72) {
          matchedCount++;
          similaritySum += bestTokSim;
        }
      }

      // Require all tokens of the micro-task name (or at least 2 tokens if name has >=3 tokens) to match
      const coverage = matchedCount / itemTokens.length;
      if (coverage < 0.99 && !(itemTokens.length >= 3 && matchedCount >= 2)) {
        continue;
      }

      // Prefer more specific matches (more tokens matched, e.g., "waterproofing + prepare" over just "waterproofing")
      const score = matchedCount * 10 + similaritySum + coverage;
      if (score > bestScore) {
        bestScore = score;
        bestItem = { id: item.id, name: item.name };
      }
    }

    return bestItem;
  };

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
        ? lib.find(m => m.name.toLowerCase().trim() === rawName.toLowerCase().trim())
        : undefined;
      const byNormName = rawName
        ? lib.find(m => norm(m.name) && norm(m.name) === norm(rawName))
        : undefined;
      const byFuzzy = rawName ? findBestInLib(rawName) : null;
      const found = byExactId || byExactName || byNormName || byFuzzy;
      if (found) {
        matched = { id: found.id, name: found.name };
      }
    }

    if (!matched && rawId && rawName) {
      matched = { id: rawId, name: rawName };
    }
  }

  // 2. Always check user text directly as well: if user text matches a MORE specific micro-task
  //    (e.g. "water profing prep" -> "water proofing prepare" vs AI returning null or generic "water proofing"), use it!
  if (text && lib.length > 0) {
    const fromText = findBestInLib(text);
    if (fromText) {
      if (
        !matched ||
        canonicalizeMicroTokens(fromText.name).length > canonicalizeMicroTokens(matched.name).length
      ) {
        matched = fromText;
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
    let modelLabel = 'Cloudflare AI';
    if (imageBytes && imageBytes.length > 0) {
      const imageArray = [...imageBytes];
      result = await ai.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        prompt: `${SYSTEM_PROMPT}\n\n${promptText}`,
        image: imageArray,
        max_tokens: 512
      });
      modelLabel = 'Cloudflare AI (Llama 3.2 11B Vision)';
    } else {
      try {
        result = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: promptText }
          ],
          max_tokens: 512
        });
        modelLabel = 'Cloudflare AI (Llama 3.3 70B)';
      } catch {
        result = await ai.run('@cf/meta/llama-3.2-3b-instruct', {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: promptText }
          ],
          max_tokens: 512
        });
        modelLabel = 'Cloudflare AI (Llama 3.2 3B)';
      }
    }

    const rawResp = result?.response ?? result;
    const responseText =
      typeof rawResp === 'string' ? rawResp : JSON.stringify(rawResp || {});
    return parseCleanJson(responseText, text, result, microLib, modelLabel, Boolean(imageBytes && imageBytes.length > 0));
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

  const models = [
    'gemini-2.5-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash'
  ];
  let lastErr: any = null;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
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
        return parseCleanJson(rawText, text, data, microLib, `Gemini (${model})`, Boolean(imageBytes && imageBytes.length > 0));
      }
      const errBody = await res.text();
      lastErr = new Error(`Gemini API error (${model}): ${res.status} ${errBody}`);
      // Project-wide auth/billing failure (401/402/403): don't waste time retrying other Gemini models
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        break;
      }
    } catch (fetchErr: any) {
      lastErr = fetchErr;
    }
  }

  throw lastErr || new Error('Gemini API request failed');
}

function extractJsonObject(raw: string): any {
  const trimmed = String(raw || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('No valid JSON object found in AI output');
  }
}

function parseCleanJson(
  raw: string,
  fallbackText: string,
  org?: any,
  microLib?: MicroTaskLibrary,
  aiEngine = 'AI',
  hasImage = false
): ParsedSiteUpdate {
  try {
    const parsed = extractJsonObject(raw);
    const heuristic = fallbackHeuristicParser(fallbackText, microLib);

    const cleanSpaceCode = normalizeScheduleCodeInput(
      parsed.spaceCode || parsed.spaceNo || heuristic.spaceCode || ''
    );

    let level: number | null = typeof parsed.level === 'number' ? parsed.level : heuristic.level;
    const zone: number | null =
      hasImage && typeof parsed.zone === 'number'
        ? parsed.zone
        : heuristic.zone !== null
          ? heuristic.zone
          : null;

    if (level === null && cleanSpaceCode) {
      if (/^G(?:F)?-\d+/i.test(cleanSpaceCode)) level = 0;
      else {
        const m = cleanSpaceCode.match(/^F(\d)-\d+/i);
        if (m) level = parseInt(m[1], 10);
      }
    }

    let rawAiSpace = parsed.space ? String(parsed.space).trim().toUpperCase() : null;
    if (rawAiSpace) {
      rawAiSpace = rawAiSpace
        .replace(/\b(?:FAMALE|WOMAN|WOMEN|LADIES|LADY)\s*(?:TOILETS?|TOLITES?|TOLETS?|WC)\b/g, 'FEMALE TOILET')
        .replace(/\b(?:MAN|MEN|GENTS)\s*(?:TOILETS?|TOLITES?|TOLETS?|WC)\b/g, 'MALE TOILET')
        .replace(/\b(?:TOLITES?|TOLETS?|TOILETS)\b/g, 'TOILET');
    }
    const invalidSpaces = new Set(['SITE', 'ROOM', 'FLOOR', 'WALL', 'CEILING', 'SKIRTING', 'NONE', 'NULL', 'UNKNOWN']);
    const space = (rawAiSpace && !invalidSpaces.has(rawAiSpace) ? rawAiSpace : null) || heuristic.space;
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
    const pChar = finishCode ? finishCode.charAt(0).toUpperCase() : '';
    const finishKind =
      pChar === 'F'
        ? 'Floor'
        : pChar === 'W'
          ? 'Wall'
          : pChar === 'C'
            ? 'Ceiling'
            : pChar === 'S'
              ? 'Skirting'
              : parsed.finishKind || heuristic.finishKind || null;

    return {
      level,
      zone,
      space,
      spaceNo: cleanSpaceCode,
      spaceCode: cleanSpaceCode,
      finishCode,
      finishKind,
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
  '2.40 M SERVICE CORRIDOR', 'MAIN ENTRANCE LOBBY & ATRIUM', 'LOADING & UNLOADING LOBBY',
  'FEMALE STAFF TOILET', 'MALE STAFF TOILET', 'SERVICE LIFT LOBBY', 'SERVICE LIFT SHAFT',
  'FM OFFICE & STORE', 'FM OFFICE PANTRY', 'SECURITY GUARD RM', 'G. SERVICE ROOM',
  'GARBAGE ROOM', 'GARBAGE CHUTE', 'DRIVER TOILET', 'POD TOILET', 'FEMALE TOILET', 'MALE TOILET',
  'TOILET CORRIDOR', 'TOILET', 'CORRIDOR', 'JANITOR', 'STORE ROOM', 'AHU ROOM', 'ELEC. ROOM',
  'ELEC. CABINET', 'ELV. RM.', 'LIFT LOBBY', 'STAIRCASE', 'AUDITORIUM', 'PRODUCTION ROOM',
  'CCU ROOM', 'GENERATOR ROOM', 'IDF RM', 'SERVER ROOM', 'KITCHEN', 'PANTRY', 'F&B OUTLET',
  'OFFICE SPACE', 'MEP SHAFT', 'MEP', 'P.SHAFT', 'SHAFT', 'F.H.R.'
];

export function fallbackHeuristicParser(
  text: string,
  microLib?: MicroTaskLibrary
): ParsedSiteUpdate {
  const upper = (text || '')
    .toUpperCase()
    .replace(/\b(?:FAMALE|WOMAN|WOMEN|LADIES|LADY)\s*(?:TOILETS?|TOLITES?|TOLETS?|WC)\b/g, 'FEMALE TOILET')
    .replace(/\b(?:MAN|MEN|GENTS)\s*(?:TOILETS?|TOLITES?|TOLETS?|WC)\b/g, 'MALE TOILET')
    .replace(/\b(?:TOLITES?|TOLETS?|TOILETS)\b/g, 'TOILET');

  // 1. Match explicit Room Code like G-008, GF-008, GF008, F1-021, F3-66, F1-040C, F4-041
  let spaceCode: string | null = null;
  const schedCodeMatch = upper.match(
    /\b((?:G|GF)[-\s]?\d{1,4}[A-Z]?|(?:F|L)[0-8]-\d{1,4}[A-Z]?|(?:F|L)[1-8]\s+\d{2,4}[A-Z]?|(?:F|L)[1-8]\d{3,4}[A-Z]?)\b/i
  );
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
    if (/^G(?:F)?-/.test(spaceCode)) level = 0;
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
