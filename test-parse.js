// Quick local sanity test for parser logic
const tests = [
  "Level 2 Room 204 screed complete",
  "L1 R105 - Ceiling grid done, snag: crack on wall (Plastering)",
  "L3 Zone 2 Toilet - tiling ongoing",
  "Floor 0 Pod toilet - W04 painting finished"
];

function fallbackHeuristicParser(text) {
  const upper = text.toUpperCase();
  const levelMatch = upper.match(/(?:L|LEVEL|FLOOR)\s*(\d)/i);
  const level = levelMatch ? parseInt(levelMatch[1], 10) : null;
  const zoneMatch = upper.match(/(?:Z|ZONE)\s*(\d)/i);
  const zone = zoneMatch ? parseInt(zoneMatch[1], 10) : null;
  const roomMatch = upper.match(/(?:ROOM|R|SPACE)?\s*([A-Z]?\d{3}[A-Z]?)/i);
  const spaceNo = roomMatch ? roomMatch[1] : null;

  let status = null;
  if (/DONE|COMPLETE|COMPLETED|FINISHED/i.test(upper)) status = 'done';
  else if (/ONGOING|IN PROGRESS|STARTED|PROGRESS/i.test(upper)) status = 'ongoing';
  else if (/PENDING|NOT STARTED/i.test(upper)) status = 'pending';

  let snag = null;
  if (/SNAG|DEFECT|ISSUE|CRACK|LEAK|DAMAGE/i.test(upper)) {
    snag = { text: text, trade: 'General' };
  }

  return { level, zone, spaceNo, status, snag };
}

console.log("=== Heuristic Parser Test ===");
for (const t of tests) {
  console.log(`Input:  "${t}"`);
  console.log(`Parsed:`, JSON.stringify(fallbackHeuristicParser(t)), "\n");
}
