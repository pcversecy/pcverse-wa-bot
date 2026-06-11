// WhatsApp webhook — Netlify Function
// Phase 6+: Claude + inventory + memory + handoff.
// Handoff = manual switch (ai_enabled) OR temporary 12h window (paused_until).

const GRAPH_VERSION = "v21.0";
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const HISTORY_LIMIT = 20;

function buildSystemPrompt(productList) {
  return `Είσαι ο ψηφιακός βοηθός του "Pcverse". Ο ιδιοκτήτης είναι ΙΔΙΩΤΗΣ (όχι κατάστημα)
στη Λευκωσία, Κύπρος, που αγοράζει, πουλάει και επισκευάζει μεταχειρισμένα κινητά.

ΓΛΩΣΣΑ:
- Απάντα ΣΤΗ ΓΛΩΣΣΑ του πελάτη: αν γράψει αγγλικά, απάντα αγγλικά· αν ελληνικά, ελληνικά.
- Πάντα φιλικά και σύντομα (στιλ WhatsApp, 1-4 προτάσεις). Θυμάσαι όσα ειπώθηκαν πιο πάνω.

ΓΕΝΙΚΟΙ ΚΑΝΟΝΕΣ:
- Μην εφευρίσκεις ΠΟΤΕ προϊόντα, τιμές ή διαθεσιμότητα εκτός της λίστας πιο κάτω.
- ΔΕΝ είσαι κατάστημα: μη λες ποτέ "περάστε από το μαγαζί".
- Μη δίνεις ποτέ στοιχεία πληρωμής/λογαριασμού (Revolut/τράπεζα). Αυτά τα δίνει ο συνάδελφος.

ΑΝ Ο ΠΕΛΑΤΗΣ ΘΕΛΕΙ ΝΑ ΑΓΟΡΑΣΕΙ:
- Κοίτα ΜΟΝΟ τη λίστα αποθέματος. Αν υπάρχει: πες τίτλο, χαρακτηριστικά (αποθηκευτικό, χρώμα, μπαταρία/κατάσταση) και ΤΙΜΗ.
- Αν δεν υπάρχει: πες το ευγενικά και πρότεινε 1-2 παρόμοια διαθέσιμα.
- ΟΧΙ ΠΑΖΑΡΙΑ: η τιμή είναι σταθερή. Κράτα την ευγενικά, τόνισε την αξία.
- ΠΕΡΙΟΧΗ: ο ιδιοκτήτης είναι στη Λευκωσία. Ρώτα διακριτικά την πόλη του πελάτη. Αν είναι εκτός Λευκωσίας, πες ότι υπάρχει έξτρα χρέωση για delivery (ποσό το λέει ο συνάδελφος).
- ΠΑΡΑΔΟΣΗ: (α) συνάντηση σε σημείο, ή (β) αποστολή με προπληρωμή (Revolut/Eurobank) και μετά αποστολή.
- ΟΤΑΝ ΚΛΕΙΝΕΙ DEAL: μην κανονίζεις λεπτομέρειες — πες ότι θα επικοινωνήσει ο συνάδελφος.

ΑΝ ΔΕΝ ΚΛΕΙΣΕΙ ΑΓΟΡΑ: ρώτα ευγενικά αν έχει δικό του iPhone/συσκευή να ΠΟΥΛΗΣΕΙ.

ΑΝ ΘΕΛΕΙ ΝΑ ΠΟΥΛΗΣΕΙ: ΠΟΤΕ τιμή/εκτίμηση. Μάζεψε μοντέλο, αποθηκευτικό, κατάσταση, μπαταρία· μετά πες ότι θα στείλει προσφορά ο συνάδελφος.

ΑΝ ΘΕΛΕΙ ΕΠΙΣΚΕΥΗ: ρώτα συσκευή+πρόβλημα, και πες ότι θα επικοινωνήσει ο συνάδελφος.

ΔΙΑΘΕΣΙΜΟ ΑΠΟΘΕΜΑ ΑΥΤΗ ΤΗ ΣΤΙΓΜΗ:
${productList}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    const p = event.queryStringParameters || {};
    if (p["hub.mode"] === "subscribe" && p["hub.verify_token"] === process.env.VERIFY_TOKEN) {
      return { statusCode: 200, body: p["hub.challenge"] };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const value = body.entry?.[0]?.changes?.[0]?.value;
      const message = value?.messages?.[0];

      if (message && message.type === "text") {
        const from = message.from;
        const text = message.text.body;

        let history = [];
        try { history = await fetchHistory(from); } catch (e) { console.error("history read", e); }
        try { await saveMessage(from, "user", text); } catch (e) { console.error("save user", e); }

        // HANDOFF: AI stays silent if manually switched off OR within the 12h window
        let paused = false;
        try { paused = await isPaused(from); } catch (e) { console.error("pause check", e); }
        if (paused) return { statusCode: 200, body: "EVENT_RECEIVED" };

        let productList = "(Δεν ήταν δυνατή η ανάγνωση αποθέματος.)";
        try { productList = formatProducts(await fetchAvailableProducts()); } catch (e) { console.error("products", e); }

        let reply;
        try { reply = await askClaude(history, text, buildSystemPrompt(productList)); }
        catch (err) { console.error("claude", err); reply = "Ένα λεπτό, σε συνδέω με συνάδελφο. 🙏"; }

        await sendWhatsAppMessage(from, reply);
        try { await saveMessage(from, "assistant", reply); } catch (e) { console.error("save assistant", e); }
      }

      return { statusCode: 200, body: "EVENT_RECEIVED" };
    } catch (err) {
      console.error("Webhook error:", err);
      return { statusCode: 200, body: "EVENT_RECEIVED" };
    }
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};

async function isPaused(waId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/chat_state?wa_id=eq.${encodeURIComponent(waId)}&select=ai_enabled,paused_until`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) return false;
  const r = (await res.json())?.[0];
  if (!r) return false;
  if (r.ai_enabled === false) return true;                                  // manual switch off
  if (r.paused_until && new Date(r.paused_until) > new Date()) return true; // 12h window
  return false;
}

async function fetchAvailableProducts() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/products?sold=eq.false&select=title,spec_el,price,cat,chips_el`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

function formatProducts(products) {
  if (!products || products.length === 0) return "(Κανένα διαθέσιμο προϊόν αυτή τη στιγμή.)";
  return products.map((p) => {
    const chips = Array.isArray(p.chips_el) && p.chips_el.length ? " · " + p.chips_el.join(", ") : "";
    const spec = p.spec_el ? " · " + p.spec_el : "";
    return `- ${p.title}${spec}${chips} · ${p.price}`;
  }).join("\n");
}

async function fetchHistory(waId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/conversations?wa_id=eq.${encodeURIComponent(waId)}&select=role,content&order=created_at.desc&limit=${HISTORY_LIMIT}`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  const rows = await res.json();
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

async function saveMessage(waId, role, content) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/conversations`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...supabaseHeaders(), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify([{ wa_id: waId, role, content }]),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
}

function supabaseHeaders() {
  return { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
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

async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  if (!res.ok) console.error("Send failed:", res.status, await res.text());
}
