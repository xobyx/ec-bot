import type { Env, ParsedSiteUpdate } from './types';

const SYSTEM_PROMPT = `You are an expert AI site engineer assistant for the ECIT Building Construction Site Tracker.
Your job is to analyze site messages and photos submitted by site engineers via Telegram, and extract structured progress updates, finishes, and snags (defects).

Project details:
- Levels: 0 (Ground), 1 (1st), 2 (2nd), 3 (3rd), 4 (4th), 5 (5th), 6 (6th), 7 (7th), 8 (8th).
- Finish Categories and common codes:
  * Floor (F): F01, F02 (Power floated screed), F03 (Screed), F05 (PU resin), F06 (Epoxy), F08 (Porcelain tiles), F09 (Ceramic tiles), F15 (Marble), F16 (Porcelain).
  * Wall (W): W01, W02 (Spray plaster), W03 (Cement plaster), W04 (Paint system-1 washable), W05 (Paint system-2 anti-fungal), W07 (Glazed ceramic tiles), W08 (Porcelain tiles).
  * Ceiling (C): C01, C03 (Gypsum board ceiling), C03A (MR gypsum), C07 (Fine line 600x600 tiles), C08 (Exposed T-grid tiles).
  * Skirting (S): S01-S13.
- Status values must be strictly: "pending", "ongoing", "done", or null if not mentioned.
- Snag trades: "Painting", "Plastering", "Tiling", "Flooring", "Ceiling", "MEP", "Electrical", "Plumbing", "HVAC", "Carpentry", "Civil", "Cleaning", "General".

You MUST return ONLY a valid JSON object with the following schema:
{
  "level": number or null,
  "zone": number or null (1 to 4, or 0 if common/all),
  "space": string or null (e.g. "CORRIDOR", "MALE TOILET", "OFFICE SPACE", "IDF RM" or room code like "204"),
  "spaceNo": string or null (e.g. "204", "G01", "102"),
  "spaceCode": string or null,
  "finishCode": string or null (e.g. "F02", "W04", "C03"),
  "finishKind": "Floor" | "Skirting" | "Wall" | "Ceiling" | null,
  "status": "pending" | "ongoing" | "done" | null,
  "snag": {
    "text": string (description of defect),
    "trade": string (trade responsible)
  } or null,
  "notes": string (brief progress or inspection note),
  "summary": string (1-2 sentences human readable summary of the update)
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

    return {
      level: typeof parsed.level === 'number' ? parsed.level : null,
      zone: typeof parsed.zone === 'number' ? parsed.zone : null,
      space: parsed.space || null,
      spaceNo: parsed.spaceNo || null,
      spaceCode: parsed.spaceCode || null,
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

function fallbackHeuristicParser(text: string): ParsedSiteUpdate {
  const upper = text.toUpperCase();

  // Try to match level (e.g. L2, LEVEL 2, FLOOR 2)
  const levelMatch = upper.match(/(?:L|LEVEL|FLOOR)\s*(\d)/i);
  const level = levelMatch ? parseInt(levelMatch[1], 10) : null;

  // Try to match zone (e.g. Z1, ZONE 2)
  const zoneMatch = upper.match(/(?:Z|ZONE)\s*(\d)/i);
  const zone = zoneMatch ? parseInt(zoneMatch[1], 10) : null;

  // Try to match room number (e.g. ROOM 204, R204, 204)
  const roomMatch = upper.match(/(?:ROOM|R|SPACE)?\s*([A-Z]?\d{3}[A-Z]?)/i);
  const spaceNo = roomMatch ? roomMatch[1] : null;

  // Try to match status
  let status: 'pending' | 'ongoing' | 'done' | null = null;
  if (/DONE|COMPLETE|COMPLETED|FINISHED/i.test(upper)) status = 'done';
  else if (/ONGOING|IN PROGRESS|STARTED|PROGRESS/i.test(upper)) status = 'ongoing';
  else if (/PENDING|NOT STARTED/i.test(upper)) status = 'pending';

  // Check for snag keyword
  let snag: { text: string; trade: string } | null = null;
  if (/SNAG|DEFECT|ISSUE|CRACK|LEAK|DAMAGE/i.test(upper)) {
    snag = {
      text: text,
      trade: 'General'
    };
  }

  return {
    level,
    zone,
    space: spaceNo || 'SITE',
    spaceNo,
    spaceCode: spaceNo,
    finishCode: null,
    finishKind: null,
    status,
    snag,
    notes: text,
    summary: `Update for ${spaceNo ? 'Room ' + spaceNo : 'site space'}${status ? ` (${status})` : ''}`
  };
}
