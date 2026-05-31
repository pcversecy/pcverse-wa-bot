// WhatsApp webhook — Netlify Function
// Phase 3: receives incoming messages and replies with a test echo.
// (Claude AI is added in Phase 4.)

const GRAPH_VERSION = "v21.0"; // if Meta's console shows a newer version, you can change this

exports.handler = async (event) => {
  // 1) Webhook verification — Meta sends a GET request when you connect the webhook
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    const mode = params["hub.mode"];
    const token = params["hub.verify_token"];
    const challenge = params["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      // Verification passed — echo the challenge back
      return { statusCode: 200, body: challenge };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  // 2) Incoming messages — Meta sends a POST request for each new message
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const value = body.entry?.[0]?.changes?.[0]?.value;
      const message = value?.messages?.[0];

      // Only handle text messages for now
      if (message && message.type === "text") {
        const from = message.from;          // the customer's WhatsApp number
        const text = message.text.body;      // what they wrote

        await sendWhatsAppMessage(from, `Έλαβα το μήνυμά σου: "${text}" 👍`);
      }

      // Always reply 200 fast, so Meta does not retry the webhook
      return { statusCode: 200, body: "EVENT_RECEIVED" };
    } catch (err) {
      console.error("Webhook error:", err);
      return { statusCode: 200, body: "EVENT_RECEIVED" };
    }
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};

// Sends a plain text WhatsApp message back to the customer.
// Note: free-form text only works within 24h of the customer's last message.
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
