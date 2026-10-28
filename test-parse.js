#!/usr/bin/env node

/**
 * CLI Test Script for ECIT Telegram Bot Message Parsing
 * 
 * Usage:
 *   node test-parse.js "garbage room level 1 zone 2 screed done"
 *   node test-parse.js "L2 Room 204 screed complete, snag: crack on wall (Plastering)"
 *   node test-parse.js  (runs built-in test suite)
 */

const KNOWN_SPACES = [
  'GARBAGE ROOM', 'GARBAGE CHUTE', 'POD TOILET', 'MALE TOILET', 'FEMALE TOILET', 'TOILET',
  '2.40 M SERVICE CORRIDOR', 'CORRIDOR', 'JANITOR', 'STORE ROOM', 'FM OFFICE & STORE',
  'FM OFFICE PANTRY', 'AHU ROOM', 'ELEC. ROOM', 'ELEC. CABINET', 'ELV. RM.',
  'SERVICE LIFT LOBBY', 'LIFT LOBBY', 'STAIRCASE', 'AUDITORIUM', 'PRODUCTION ROOM',
  'CCU ROOM', 'GENERATOR ROOM', 'IDF RM', 'SERVER ROOM', 'KITCHEN', 'PANTRY', 'MEP'
];

function parseMessage(text) {
  const upper = text.toUpperCase();

  // 1. Level (e.g. L2, LEVEL 2, FLOOR 2)
  const levelMatch = upper.match(/(?:L|LEVEL|FLOOR)\s*(\d)/i);
  const level = levelMatch ? parseInt(levelMatch[1], 10) : null;

  // 2. Zone (e.g. Z1, ZONE 2)
  const zoneMatch = upper.match(/(?:Z|ZONE)\s*(\d)/i);
  const zone = zoneMatch ? parseInt(zoneMatch[1], 10) : null;

  // 3. Space Name
  let space = null;
  for (const s of KNOWN_SPACES) {
    if (upper.includes(s)) {
      space = s;
      break;
    }
  }

  // 4. Room Number (digits required, e.g. 204, R102, G-01)
  let spaceNo = null;
  const textWithoutSpace = space ? upper.replace(space, '') : upper;
  const roomMatch = textWithoutSpace.match(/\b(?:ROOM|R|#)\s*([A-Z0-9-]*\d+[A-Z0-9-]*)\b/i) ||
                    textWithoutSpace.match(/\b([A-Z]?\d{3}[A-Z]?)\b/i);
  if (roomMatch && /\d/.test(roomMatch[1])) {
    const cand = roomMatch[1].toUpperCase();
    if (!/^[ZL]\d$/i.test(cand) && !/^ZONE/i.test(cand) && !/^LEVEL/i.test(cand)) {
      spaceNo = cand;
    }
  }

  if (!space) {
    space = spaceNo ? `ROOM ${spaceNo}` : 'SITE';
  }

  // 5. Finish Code
  let finishCode = null;
  if (/SCREED/i.test(upper)) {
    finishCode = 'F02';
  } else if (/PAINT/i.test(upper)) {
    finishCode = 'W04';
  } else if (/PLASTER/i.test(upper)) {
    finishCode = 'W02';
  } else if (/TILE|TILES|TILING/i.test(upper)) {
    finishCode = 'F08';
  } else if (/CEILING/i.test(upper)) {
    finishCode = 'C03';
  }

  // 6. Status
  let status = null;
  if (/DONE|COMPLETE|COMPLETED|FINISHED/i.test(upper)) status = 'done';
  else if (/ONGOING|IN PROGRESS|STARTED|PROGRESS/i.test(upper)) status = 'ongoing';
  else if (/PENDING|NOT STARTED/i.test(upper)) status = 'pending';

  // 7. Snags
  let snag = null;
  const snagMatch = text.match(/(?:snag|defect|issue):\s*([^()]+)(?:\(([^)]+)\))?/i);
  if (snagMatch) {
    snag = {
      text: snagMatch[1].trim(),
      trade: snagMatch[2] ? snagMatch[2].trim() : 'General'
    };
  } else if (/SNAG|DEFECT|ISSUE|CRACK|LEAK|DAMAGE/i.test(upper)) {
    snag = { text, trade: 'General' };
  }

  return { level, zone, space, spaceNo, finishCode, status, snag };
}

function formatCard(parsed, originalText) {
  const levelStr = typeof parsed.level === 'number' ? `Level ${parsed.level}` : 'Unspecified Level';
  const zoneStr = typeof parsed.zone === 'number' && parsed.zone > 0 ? `Zone ${parsed.zone}` : (parsed.zone === 0 ? 'All Zones' : '');
  const spaceName = parsed.space && parsed.space !== 'SITE' ? parsed.space : '';
  const roomNumber = (parsed.spaceNo && !spaceName.includes(parsed.spaceNo)) ? `Room ${parsed.spaceNo}` : '';

  const locationParts = [levelStr, zoneStr, spaceName, roomNumber].filter(Boolean);
  const locationText = locationParts.join(' | ');

  const finishStr = parsed.finishCode
    ? `• Finish: ${parsed.finishCode} ➔ ${(parsed.status || 'updated').toUpperCase()}\n`
    : (parsed.status ? `• Status: ${parsed.status.toUpperCase()}\n` : '');
  const snagStr = parsed.snag
    ? `• Snag Detected: "${parsed.snag.text}" (Trade: ${parsed.snag.trade})\n`
    : '';

  return [
    `📋 Proposed Room Update`,
    `• Location: ${locationText}`,
    finishStr.trim(),
    snagStr.trim(),
    `• Notes: ${originalText}`,
    `\n[ ✅ Confirm & Save ]   [ ❌ Cancel ]`
  ].filter(Boolean).join('\n');
}

// Main execution
const inputArg = process.argv.slice(2).join(' ').trim();

if (inputArg) {
  console.log(`\n========================================`);
  console.log(`📥 Input: "${inputArg}"`);
  console.log(`========================================`);
  const parsed = parseMessage(inputArg);
  console.log(`\n🔍 Extracted JSON:`);
  console.log(JSON.stringify(parsed, null, 2));
  console.log(`\n📱 Telegram Message Preview:`);
  console.log(`----------------------------------------`);
  console.log(formatCard(parsed, inputArg));
  console.log(`----------------------------------------\n`);
} else {
  const testSuite = [
    "garbage room level 1 zone 2  screed done",
    "level 2 zone 1 room 204 screed complete",
    "L1 R105 - Ceiling grid done, snag: crack on wall (Plastering)",
    "pod toilet level 0 zone 2 - tiles ongoing",
    "ahu room level 1 zone 2 spray plaster finished"
  ];

  console.log(`\n🚀 Running Test Suite (${testSuite.length} cases):\n`);
  testSuite.forEach((t, i) => {
    console.log(`[Test ${i + 1}] "${t}"`);
    const p = parseMessage(t);
    console.log(`  ➔ Location: ${formatCard(p, t).split('\n')[1]}`);
    console.log(`  ➔ Finish:   ${p.finishCode || 'none'} (${p.status || 'none'})`);
    if (p.snag) console.log(`  ➔ Snag:     "${p.snag.text}" [${p.snag.trade}]`);
    console.log('');
  });
}
