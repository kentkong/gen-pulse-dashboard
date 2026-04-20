/**
 * Parse natural-ish time: HH:MM (24h), H:MMam/pm, "4pm", ISO date string.
 * Returns epoch ms for "until" in local server TZ unless ISO includes offset.
 */
export function parseUntil(text) {
  const t = text.trim();
  if (!t) return null;

  const iso = Date.parse(t);
  if (!Number.isNaN(iso) && t.length >= 8) return iso;

  const lower = t.toLowerCase();
  const m24 = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const d = new Date();
    d.setHours(Number(m24[1]), Number(m24[2]), 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  const m12 = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m12) {
    let h = Number(m12[1]);
    const min = Number(m12[2] ?? 0);
    const ap = m12[3];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const d = new Date();
    d.setHours(h, min, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  return null;
}

export function tokenizeCommandText(text) {
  const parts = [];
  let cur = "";
  let q = null;
  for (const ch of text.trim()) {
    if (q) {
      if (ch === q) {
        q = null;
        parts.push(cur);
        cur = "";
      } else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}
