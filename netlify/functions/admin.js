// Admin API — Netlify Function
// Powers the admin inbox: login, list conversations, read a chat, send a reply.
// When the owner sends a reply, the AI is paused for that customer for PAUSE_HOURS.

const GRAPH_VERSION = "v21.0";
const PAUSE_HOURS = 12;

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const params = event.queryStringParameters || {};
  const action = params.action || body.action;

  // --- Login (no key required) ---
  if (event.httpMethod === "POST" && action === "login") {
    if (body.email === process.env.ADMIN_EMAIL && body.password === process.env.ADMIN_PASSWORD) {
      return json(200, { ok: true });
    }
    return json(401, { ok: false, error: "Λάθος στοιχεία" });
  }

  // --- Everything else needs the admin key ---
  const key = event.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_PASSWORD) {
    return json(401, { error: "Unauthorized" });
  }

  // --- List conversations ---
  if (event.httpMethod === "GET" && action === "conversations") {
    const msgs = await sb(`conversations?select=wa_id,role,content,created_at&order=created_at.desc&limit=400`);
    const states = await sb(`chat_state?select=wa_id,paused_until`);
    const pausedMap = {};
    states.forEach((s) => { pausedMap[s.wa_id] = s.paused_until && new Date(s.paused_until) > new Date(); });

    const seen = {};
    const list = [];
    for (const m of msgs) {
      if (seen[m.wa_id]) continue;
      seen[m.wa_id] = true;
      list.push({ wa_id: m.wa_id, last: m.content, at: m.created_at, paused: !!pausedMap[m.wa_id] });
    }
    return json(200, { conversations: list });
  }

  // --- Read one chat ---
  if (event.httpMethod === "GET" && action === "messages") {
    const waId = params.wa_id;
    if (!waId) return json(400, { error: "missing wa_id" });
    const rows = await sb(`conversations?wa_id=eq.${encodeURIComponent(waId)}&select=role,content,created_at&order=created_at.asc`);
    return json(200, { messages: rows });
  }

  // --- Send a reply (and pause the AI) ---
  if (event.httpMethod === "POST" && action === "send") {
    const { wa_id, text } = body;
    if (!wa_id || !text) return json(400, { error: "missing wa_id/text" });

    await sendWhatsApp(wa_id, text);
    await sbInsert("conversations", [{ wa_id, role: "assistant", content: text }]);

    const until = new Date(Date.now() + PAUSE_HOURS * 3600 * 1000).toISOString();
    await sbUpsert("chat_state", { wa_id, paused_until: until, updated_at: new Date().toISOString() }, "wa_id");

    return json(200, { ok: true });
  }

  return json(404, { error: "unknown action" });
};

// ---- helpers ----
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
function sbHeaders() {
  return { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
}
async function sb(path) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}
async function sbInsert(table, rows) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}
async function sbUpsert(table, row, onConflict) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { ...sbHeaders(), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}
async function sendWhatsApp(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${await res.text()}`);
}
