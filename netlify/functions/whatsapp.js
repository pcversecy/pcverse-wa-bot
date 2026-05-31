// WhatsApp webhook — Netlify Function
// Phase 5 + tuned persona: Claude + inventory + memory, with Pcverse sales rules.

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
- Κοίτα ΜΟΝΟ τη λίστα αποθέματος. Αν υπάρχει: πες τίτλο, βασικά χαρακτηριστικά (αποθηκευτικό, χρώμα, μπαταρία/κατάσταση) και ΤΙΜΗ.
- Αν δεν υπάρχει: πες το ευγενικά και πρότεινε 1-2 παρόμοια διαθέσιμα από τη λίστα.
- ΟΧΙ ΠΑΖΑΡΙΑ: η τιμή είναι σταθερή. Αν ζητήσει έκπτωση/"κάτι καλύτερο", μην κατεβάζεις τιμή.
  Κράτα την ευγενικά και τόνισε την αξία (άριστη κατάσταση, μπαταρία, με κουτί, αξιόπιστος ιδιώτης).
- ΠΕΙΘΕ ΣΩΣΤΑ: ανάδειξε τα δυνατά σημεία της συσκευής, χωρίς πίεση ή υπερβολές.
- ΠΑΡΑΔΟΣΗ: δύο τρόποι — (α) συνάντηση σε σημείο, ή (β) αποστολή. Για αποστολή, η πληρωμή
  γίνεται πρώτα (Revolut ή Eurobank) και μετά στέλνεται η συσκευή. Πες το ως κανονική, ασφαλή διαδικασία.
- ΠΕΡΙΟΧΗ/ΧΡΕΩΣΗ: ο ιδιοκτήτης είναι στη Λευκωσία. Ρώτα διακριτικά σε ποια πόλη είναι ο πελάτης.
  Αν είναι ΕΚΤΟΣ Λευκωσίας, ενημέρωσε ότι υπάρχει έξτρα χρέωση για delivery (το ακριβές ποσό το λέει ο συνάδελφος).
- ΟΤΑΝ ΚΛΕΙΝΕΙ DEAL (ο πελάτης λέει ναι/θέλω να το πάρω): μην κανονίζεις εσύ λεπτομέρειες.
  Πες ότι θα επικοινωνήσει ο συνάδελφος για να τα κανονίσετε.

ΑΝ ΔΕΝ ΚΛΕΙΣΕΙ ΑΓΟΡΑ (αρνείται, διστάζει, ή φεύγει η κουβέντα):
- Ρώτα ευγενικά αν έχει κάποιο δικό του iPhone (ή άλλη συσκευή) που θέλει να ΠΟΥΛΗΣΕΙ.

ΑΝ Ο ΠΕΛΑΤΗΣ ΘΕΛΕΙ ΝΑ ΠΟΥΛΗΣΕΙ σε εμάς:
- ΠΟΤΕ μη δίνεις τιμή/εκτίμηση — εξαρτάται από την κατάσταση.
- Μάζεψε: μοντέλο, αποθηκευτικό χώρο, κατάσταση (γρατζουνιές/οθόνη), υγεία μπαταρίας.
- Μετά πες ότι ο συνάδελφος θα στείλει προσφορά σύντομα.

ΑΝ ΘΕΛΕΙ ΕΠΙΣΚΕΥΗ:
- Ρώτα συσκευή και πρόβλημα, και πες ότι θα επικοινωνήσει ο συνάδελφος.

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

        let productList = "(Δεν ήταν δυνατή η ανάγνωση αποθέματος.)";
        try { productList = formatProducts(await fetchAvailableProducts()); }
        catch (e) { console.error("Supabase products error:", e); }

        let history = [];
        try { history = await fetchHistory(from); }
        catch (e) { console.error("History read error:", e); }

        let reply;
        try { reply = await askClaude(history, text, buildSystemPrompt(productList)); }
        catch (err) { console.error("Claude error:", err); reply = "Ένα λεπτό, σε συνδέω με συνάδελφο να σε εξυπηρετήσει. 🙏"; }

        await sendWhatsAppMessage(from, reply);

        try { await saveMessages(from, text, reply); }
        catch (e) { console.error("History save error:", e); }
      }

      return { statusCode: 200, body: "EVENT_RECEIVED" };
    } catch (err) {
      console.error("Webhook error:", err);
      return { statusCode: 200, body: "EVENT_RECEIVED" };
    }
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};

async function fetchAvailableProducts() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/products?sold=eq.false&select=title,spec_el,price,cat,chips_el`;
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

async function fetchHistory(waId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/conversations?wa_id=eq.${encodeURIComponent(waId)}&select=role,content&order=created_at.desc&limit=${HISTORY_LIMIT}`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = await res.json();
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
  return { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
}

async function askClaude(history, userText, systemPrompt) {
  const messages = [...history, { role: "user", content: userText }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 400, system: systemPrompt, messages }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  return textBlock?.text || "Συγγνώμη, δεν κατάλαβα. Μπορείς να το πεις αλλιώς;";
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
