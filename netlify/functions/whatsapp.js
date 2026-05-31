// WhatsApp webhook — Netlify Function
// Phase 5 (complete): Claude + live inventory (Supabase) + conversation memory.

const GRAPH_VERSION = "v21.0";
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const HISTORY_LIMIT = 20; // how many past messages to remember per customer

function buildSystemPrompt(productList) {
  return `Είσαι ο ψηφιακός βοηθός του "Pcverse", επιχείρηση στην Κύπρο που αγοράζει,
πουλάει και επισκευάζει μεταχειρισμένα κινητά (και άλλες συσκευές).

Γενικά:
- Απαντάς πάντα στα Ελληνικά, φιλικά και σύντομα (στιλ WhatsApp, 1-4 προτάσεις).
- Θυμάσαι τι έχει ειπωθεί πιο πάνω στη συνομιλία και απαντάς με βάση αυτό.
- Μην εφευρίσκεις ΠΟΤΕ προϊόντα, τιμές ή διαθεσιμότητα που δεν σου δίνονται παρακάτω.

ΑΝ Ο ΠΕΛΑΤΗΣ ΘΕΛΕΙ ΝΑ ΑΓΟΡΑΣΕΙ από εμάς:
- Κοίτα ΜΟΝΟ τη λίστα διαθέσιμου αποθέματος πιο κάτω.
- Αν υπάρχει αυτό που ψάχνει: πες τον τίτλο, βασικά χαρακτηριστικά (αποθηκευτικό, χρώμα, μπαταρία/κατάσταση) και την ΤΙΜΗ. Οι τιμές είναι σταθερές — τις λες κανονικά.
- Αν ΔΕΝ υπάρχει αυτό που ζητά: πες ευγενικά ότι δεν το έχουμε αυτή τη στιγμή και πρότεινε 1-2 παρόμοια ΔΙΑΘΕΣΙΜΑ από τη λίστα.
- Μην προτείνεις ποτέ κάτι εκτός λίστας.
- Αν ο πελάτης ζητά έκπτωση ή "κάτι καλύτερο" στην τιμή: μην κατεβάζεις τιμή μόνος σου. Πες ότι θα το δει συνάδελφος και θα επικοινωνήσει.

ΑΝ Ο ΠΕΛΑΤΗΣ ΘΕΛΕΙ ΝΑ ΠΟΥΛΗΣΕΙ σε εμάς τη συσκευή του:
- ΠΟΤΕ μη δίνεις τιμή ή εκτίμηση — εξαρτάται από την κατάσταση.
- Μάζεψε: μοντέλο, αποθηκευτικό χώρο, κατάσταση (γρατζουνιές/οθόνη), υγεία μπαταρίας.
- Μετά πες ότι ένας συνάδελφος θα του στείλει προσφορά σύντομα.

ΑΝ ΘΕΛΕΙ ΕΠΙΣΚΕΥΗ:
- Ρώτα συσκευή και τι πρόβλημα έχει, και πες ότι θα επικοινωνήσει συνάδελφος.

ΔΙΑΘΕΣΙΜΟ ΑΠΟΘΕΜΑ ΑΥΤΗ ΤΗ ΣΤΙΓΜΗ:
${productList}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    if (params["hub.mode"] === "subscribe" && params["hub.verify_token"] === process.env.VERIFY_TOKEN) {
      return { statusCode: 200, body: params["hub.challenge"] };
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

        // Inventory (best effort)
        let productList = "(Δεν ήταν δυνατή η ανάγνωση αποθέματος.)";
        try {
          productList = formatProducts(await fetchAvailableProducts());
        } catch (e) {
          console.error("Supabase products error:", e);
        }

        // Conversation history (best effort)
        let history = [];
        try {
          history = await fetchHistory(from);
        } catch (e) {
          console.error("History read error:", e);
        }

        // Ask Claude with history + the new message
        let reply;
        try {
          reply = await askClaude(history, text, buildSystemPrompt(productList));
        } catch (err) {
          console.error("Claude error:", err);
          reply = "Ένα λεπτό, σε συνδέω με συνάδελφο να σε εξυπηρετήσει. 🙏";
        }

        await sendWhatsAppMessage(from, reply);

        // Save both messages (best effort)
        try {
          await saveMessages(from, text, reply);
        } catch (e) {
          console.error("History save error:", e);
        }
      }

      return { statusCode: 200, body: "EVENT_RECEIVED" };
    } catch (err) {
      console.error("Webhook error:", err);
      return { statusCode: 200, body: "EVENT_RECEIVED" };
    }
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};

// ---- Supabase: products ----
async function fetchAvailableProducts() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/products` +
    `?sold=eq.false&select=title,spec_el,price,cat,chips_el`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
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

// ---- Supabase: conversation memory ----
async function fetchHistory(waId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/conversations` +
    `?wa_id=eq.${encodeURIComponent(waId)}&select=role,content` +
    `&order=created_at.desc&limit=${HISTORY_LIMIT}`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  // came newest-first → reverse to oldest-first for Claude
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

async function saveMessages(waId, userText, assistantText) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/conversations`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...supabaseHeaders(), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify([
      { wa_id: waId, role: "user", content: userText },
      { wa_id: waId, role: "assistant", content: assistantText },
    ]),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

function supabaseHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  };
}

// ---- Claude ----
async function askClaude(history, userText, systemPrompt) {
  const messages = [...history, { role: "user", content: userText }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 400, system: systemPrompt, messages }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  return textBlock?.text || "Συγγνώμη, δεν κατάλαβα. Μπορείς να το πεις αλλιώς;";
}

// ---- WhatsApp send ----
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  if (!res.ok) console.error("Send failed:", res.status, await res.text());
}
