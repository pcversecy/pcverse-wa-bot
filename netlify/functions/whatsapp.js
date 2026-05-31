// WhatsApp webhook — Netlify Function
// Phase 4: replies using Claude (Anthropic) instead of a fixed echo.
// Note: this version handles one message at a time (no memory yet).
// Conversation memory + owner notifications come in Phase 5.

const GRAPH_VERSION = "v21.0";
const CLAUDE_MODEL = "claude-haiku-4-5-20251001"; // cheap + fast, good for this

// The "character" of the bot — what Claude knows and how it behaves.
const SYSTEM_PROMPT = `Είσαι ο ψηφιακός βοηθός του "Pcverse", μιας επιχείρησης στην Κύπρο που
αγοράζει, πουλάει και επισκευάζει μεταχειρισμένα κινητά.

Κανόνες:
- Απαντάς πάντα στα Ελληνικά, φιλικά και σύντομα (στιλ WhatsApp, 1-3 προτάσεις).
- Βοηθάς με τρία πράγματα: αγορά μεταχειρισμένου κινητού, πώληση της συσκευής του πελάτη σε εμάς, και επισκευές.
- ΠΟΤΕ μη δίνεις τιμές, ούτε εκτιμήσεις τιμών. Σε μεταχειρισμένα η τιμή εξαρτάται από την κατάσταση.
  Αντί για τιμή, μάζεψε τα στοιχεία και πες ότι ένας συνάδελφος θα επιβεβαιώσει σύντομα.
- Αν θέλει να ΑΓΟΡΑΣΕΙ: ρώτα ποιο μοντέλο/αποθηκευτικό χώρο ψάχνει, και πες ότι θα επιβεβαιωθεί διαθεσιμότητα & τιμή.
- Αν θέλει να ΠΟΥΛΗΣΕΙ: μάζεψε μοντέλο, αποθηκευτικό χώρο, κατάσταση (γρατζουνιές/οθόνη) και υγεία μπαταρίας. Μετά πες ότι θα του στείλουμε προσφορά.
- Αν θέλει ΕΠΙΣΚΕΥΗ: ρώτα συσκευή και τι πρόβλημα έχει.
- Μην εφευρίσκεις απόθεμα, τιμές ή λεπτομέρειες που δεν ξέρεις. Αν δεν είσαι σίγουρος, πες ότι θα βοηθήσει ένας συνάδελφος.
- Όταν μαζέψεις αρκετά στοιχεία, κλείσε λέγοντας ότι ένας συνάδελφος θα επικοινωνήσει σύντομα.`;

exports.handler = async (event) => {
  // 1) Webhook verification (GET)
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    if (params["hub.mode"] === "subscribe" && params["hub.verify_token"] === process.env.VERIFY_TOKEN) {
      return { statusCode: 200, body: params["hub.challenge"] };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  // 2) Incoming messages (POST)
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const value = body.entry?.[0]?.changes?.[0]?.value;
      const message = value?.messages?.[0];

      if (message && message.type === "text") {
        const from = message.from;
        const text = message.text.body;

        let reply;
        try {
          reply = await askClaude(text);
        } catch (err) {
          console.error("Claude error:", err);
          reply = "Ένα λεπτό, σε συνδέω με συνάδελφο να σε εξυπηρετήσει. 🙏";
        }

        await sendWhatsAppMessage(from, reply);
      }

      return { statusCode: 200, body: "EVENT_RECEIVED" };
    } catch (err) {
      console.error("Webhook error:", err);
      return { statusCode: 200, body: "EVENT_RECEIVED" };
    }
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};

// Asks Claude for a reply to the customer's message.
async function askClaude(userText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  return textBlock?.text || "Συγγνώμη, δεν κατάλαβα. Μπορείς να το πεις αλλιώς;";
}

// Sends a plain text WhatsApp message back to the customer.
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  if (!res.ok) {
    console.error("Send failed:", res.status, await res.text());
  }
}
