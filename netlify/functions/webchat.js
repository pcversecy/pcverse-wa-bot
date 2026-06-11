// Website live-chat endpoint — same brain as WhatsApp, for visitors on pcversecy.com.
// Conversations are saved to the SAME `conversations` table (wa_id = web session id),
// so they appear in the same admin inbox. Respects the same handoff/pause logic.

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const HISTORY_LIMIT = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function webSystemPrompt(productList) {
  return `Είσαι ο ψηφιακός βοηθός του "Pcverse" στην ιστοσελίδα pcversecy.com. Ο ιδιοκτήτης είναι
ΙΔΙΩΤΗΣ (όχι κατάστημα) στη Λευκωσία, Κύπρος, που αγοράζει, πουλάει και επισκευάζει μεταχειρισμένα κινητά.

ΓΛΩΣΣΑ:
- Απάντα ΣΤΗ ΓΛΩΣΣΑ του επισκέπτη (ελληνικά ή αγγλικά). Φιλικά και σύντομα (1-4 προτάσεις). Θυμάσαι όσα ειπώθηκαν.

ΓΕΝΙΚΟΙ ΚΑΝΟΝΕΣ:
- Μην εφευρίσκεις ΠΟΤΕ προϊόντα, τιμές ή διαθεσιμότητα εκτός της λίστας πιο κάτω.
- ΔΕΝ είσαι κατάστημα: μη λες "περάστε από το μαγαζί".
- Μη δίνεις ποτέ στοιχεία πληρωμής/λογαριασμού. Αυτά τα δίνει ο συνάδελφος.

ΑΓΟΡΑ:
- Κοίτα ΜΟΝΟ τη λίστα. Αν υπάρχει: τίτλος, χαρακτηριστικά, ΤΙΜΗ. Αν όχι: πες το ευγενικά, πρότεινε 1-2 παρόμοια.
- ΚΑΘΟΛΟΥ ΠΑΖΑΡΙΑ: Η τιμή είναι ΑΠΟΛΥΤΩΣ σταθερή και ΔΕΝ μειώνεται ΠΟΤΕ, ούτε λίγο, ούτε με έκπτωση,
  ούτε για μετρητά, ούτε για πολλά τεμάχια. Αν ο πελάτης ζητήσει χαμηλότερη τιμή ή "κάτι καλύτερο",
  αρνήσου ΕΥΓΕΝΙΚΑ αλλά ΚΑΤΗΓΟΡΗΜΑΤΙΚΑ και τόνισε την αξία (άριστη κατάσταση, αξιόπιστος ιδιώτης).
  ΜΗΝ προτείνεις ποτέ μειωμένη τιμή και μη δίνεις την εντύπωση ότι υπάρχει περιθώριο.
- ΠΕΡΙΟΧΗ: ο ιδιοκτήτης είναι στη Λευκωσία. Ρώτα την πόλη· αν είναι εκτός Λευκωσίας, υπάρχει έξτρα χρέωση delivery (ποσό το λέει ο συνάδελφος).
- ΠΑΡΑΔΟΣΗ: συνάντηση ή αποστολή με προπληρωμή.

ΚΛΕΙΣΙΜΟ ΑΓΟΡΑΣ:
- Όταν ο πελάτης θέλει να προχωρήσει σε αγορά, ζήτα του ευγενικά να αφήσει το WhatsApp/τηλέφωνό του
  ή να γράψει στο WhatsApp του Pcverse, ώστε να τον εξυπηρετήσει ο συνάδελφος. Μην κανονίζεις εσύ λεπτομέρειες.

ΠΩΛΗΣΗ (ο πελάτης θέλει να ΠΟΥΛΗΣΕΙ σε εμάς):
- ΠΟΤΕ τιμή/εκτίμηση και ΜΗΝ μαζεύεις στοιχεία της συσκευής.
- Πες του ευγενικά να συμπληρώσει τη ΦΟΡΜΑ ΠΩΛΗΣΗΣ στο ΤΕΛΟΣ ΤΗΣ ΣΕΛΙΔΑΣ (εδώ στο pcversecy.com),
  και ότι ο συνάδελφος θα του στείλει προσφορά.

ΕΠΙΣΚΕΥΗ:
- Δεν παρέχουμε υπηρεσία επισκευής προς το παρόν. Πες το ευγενικά. Μπορείς να ρωτήσεις αν θα τον ενδιέφερε
  να αγοράσει ή να πουλήσει κάποια συσκευή.

ΑΝ ΔΕΝ ΚΛΕΙΣΕΙ ΑΓΟΡΑ: ρώτα ευγενικά αν έχει δική του συσκευή να πουλήσει (μέσω της φόρμας).

ΔΙΑΘΕΣΙΜΟ ΑΠΟΘΕΜΑ ΑΥΤΗ ΤΗ ΣΤΙΓΜΗ:
${productList}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: "Method Not Allowed" };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { action, session_id, text } = body;
  if (!session_id) return json(400, { error: "missing session_id" });

  // Widget polls this to pick up replies (AI or owner from the admin inbox)
  if (action === "messages") {
    const rows = await sb(`conversations?wa_id=eq.${encodeURIComponent(session_id)}&select=role,content,created_at&order=created_at.asc&limit=100`);
    return json(200, { messages: rows });
  }

  // Visitor sends a message
  if (action === "send") {
    if (!text) return json(400, { error: "missing text" });

    let history = [];
    try { history = await fetchHistory(session_id); } catch (e) { console.error("history", e); }
    try { await saveMessage(session_id, "user", text); } catch (e) { console.error("save user", e); }

    // Handoff: if owner took over (manual off OR 12h window), AI stays silent; widget will poll for the owner's reply
    let paused = false;
    try { paused = await isPaused(session_id); } catch (e) { console.error("pause", e); }
    if (paused) return json(200, { paused: true });

    let productList = "(Δεν ήταν δυνατή η ανάγνωση αποθέματος.)";
    try { productList = formatProducts(await fetchAvailableProducts()); } catch (e) { console.error("products", e); }

    let reply;
    try { reply = await askClaude(history, text, webSystemPrompt(productList)); }
    catch (err) { console.error("claude", err); reply = "Ένα λεπτό, θα σε εξυπηρετήσει συνάδελφος. 🙏"; }

    try { await saveMessage(session_id, "assistant", reply); } catch (e) { console.error("save assistant", e); }
    return json(200, { reply });
  }

  return json(404, { error: "unknown action" });
};

function json(s, o) { return { statusCode: s, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(o) }; }
function sbHeaders() { return { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }; }
async function sb(path) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}
async function isPaused(id) {
  const rows = await sb(`chat_state?wa_id=eq.${encodeURIComponent(id)}&select=ai_enabled,paused_until`);
  const r = rows?.[0]; if (!r) return false;
  if (r.ai_enabled === false) return true;
  if (r.paused_until && new Date(r.paused_until) > new Date()) return true;
  return false;
}
async function fetchAvailableProducts() {
  return sb(`products?sold=eq.false&select=title,spec_el,price,cat,chips_el`);
}
function formatProducts(products) {
  if (!products || products.length === 0) return "(Κανένα διαθέσιμο προϊόν αυτή τη στιγμή.)";
  return products.map((p) => {
    const chips = Array.isArray(p.chips_el) && p.chips_el.length ? " · " + p.chips_el.join(", ") : "";
    const spec = p.spec_el ? " · " + p.spec_el : "";
    return `- ${p.title}${spec}${chips} · ${p.price}`;
  }).join("\n");
}
async function fetchHistory(id) {
  const rows = await sb(`conversations?wa_id=eq.${encodeURIComponent(id)}&select=role,content&order=created_at.desc&limit=${HISTORY_LIMIT}`);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}
async function saveMessage(id, role, content) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/conversations`, {
    method: "POST", headers: { ...sbHeaders(), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify([{ wa_id: id, role, content }]),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
}
async function askClaude(history, userText, systemPrompt) {
  const messages = [...history, { role: "user", content: userText }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 400, system: systemPrompt, messages }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const data = await res.json();
  return data.content?.find((b) => b.type === "text")?.text || "Συγγνώμη, δεν κατάλαβα.";
}
