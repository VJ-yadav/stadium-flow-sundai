// The operator's memory of past games, kept in this browser for now.
// One record per game (see PLAN.md for the shape). Newest first.
// Later this can move to a memory service without changing the calls below.
const KEY = 'stadium-flow:events:gillette';

export function listEvents() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

export function saveEvent(record) {
  const all = listEvents().filter((r) => r.id !== record.id);
  all.unshift(record);
  try { localStorage.setItem(KEY, JSON.stringify(all)); return { ok: true, id: record.id }; } catch { return { ok: false, id: record.id }; }
}

export function clearEvents() { try { localStorage.removeItem(KEY); } catch { /* storage blocked */ } }

// Download all records as a JSON file, so a demo can start from a known history.
export function exportEvents() {
  const blob = new Blob([JSON.stringify(listEvents(), null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'gillette-events.json' });
  a.click(); URL.revokeObjectURL(a.href);
}

export function importEvents(records) {
  if (!Array.isArray(records)) return false;
  try { localStorage.setItem(KEY, JSON.stringify(records)); return true; } catch { return false; }
}
