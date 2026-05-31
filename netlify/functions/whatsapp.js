// WhatsApp webhook — Netlify Function
// Phase 5b: Claude + reads live inventory from Supabase (products table).
// Conversation memory comes next (Phase 5a).

const GRAPH_VERSION = "v21.0";
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

// Builds the bot's instructions, injecting the live product list.
function buildSystemPrompt(productList) {
  return `Είσαι ο ψηφιακός βοηθός του "Pcverse", επιχείρηση στην Κύπρο που αγοράζει,
πουλάει και επισκευάζει μεταχειρισμένα κινητά (και άλλες συσκευές).

Γενικά:
- Απαντάς πάντα στα Ελληνικά, φιλικά και σύντομα (στιλ WhatsApp, 1-4 προτάσεις).
- Μην εφευρίσκεις ΠΟΤΕ προϊόντα, τιμές ή διαθεσιμότητα που δεν σου δίνονται παρακάτω.

ΑΝ Ο ΠΕΛΑΤΗΣ ΘΕΛΕΙ ΝΑ ΑΓΟΡΑΣΕΙ από εμάς:
- Κοίτα ΜΟΝΟ τη λίστα διαθέσιμου αποθέματος πιο κάτω.
- Αν υπάρχει αυτό που ψάχνει: πες τον τίτλο, βασικά χαρακτηριστικά (αποθηκευτικό, χρώμα, μπαταρία/κατάσταση) και την ΤΙΜΗ. Οι τιμές αυτές είναι σταθερές — τις λες κανονικά.
- Αν ΔΕΝ υπάρχει αυτό που ζητά: πες ευγενικά ότι δεν το έχουμε αυτή τη στιγμή και πρότεινε 1-2 παρόμοια ΔΙΑΘΕΣΙΜΑ από τη λίστα.
- Μην προτείνεις ποτέ κάτι εκτός λίστας.

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

        // Pull live inventory (best effort — if it fails, we still reply)
        let productList = "(Δεν ήταν δυνατή η ανάγνωση αποθέματος.)";
        try {
          const products = await fetchAvailableProducts();
          productList = formatProducts(products);
        } catch (e) {
          console.error("Supabase products error:", e);
        }

        let reply;
        try {
          reply = await askClaude(text, buildSystemPrompt(productList));
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

// Reads available (sold = false) products from Supabase.
async function fetchAvailableProducts() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/products` +
    `?sold=eq.false&select=title,spec_el,price,cat,chips_el`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

// Turns the product rows into a compact text list for Claude.
function formatProducts(products) {
  if (!products || products.length === 0) {
    return "(Κανένα διαθέσιμο προϊόν αυτή τη στιγμή.)";
  }
  return products
    .map((p) => {
      const chips = Array.isArray(p.chips_el) && p.chips_el.length
        ? " · " + p.chips_el.join(", ")
        : "";
      const spec = p.spec_el ? " · " + p.spec_el : "";
      return `- ${p.title}${spec}${chips} · ${p.price}`;
    })
    .join("\n");
}

// Asks Claude for a reply, using the given system prompt.
async function askClaude(userText, systemPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
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
  if (!res.ok) console.error("Send failed:", res.status, await res.text());
}
