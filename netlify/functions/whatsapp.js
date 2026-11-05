import { getStore } from "@netlify/blobs";
import { SYSTEM_PROMPT } from "./prompt.js";

const GRAPH = "https://graph.facebook.com/v25.0";
const MAX_HISTORY = 50; // pichle 50 messages yaad rakhta hai

// Menu ki photos: yeh files "public" folder mein honi chahiyein.
// Ek se zyada page hon to naam yahan add karein, jaise ["menu.jpg", "menu2.jpg"]
const MENU_IMAGES = ["menu.jpg"];

export const config = { path: "/webhook" };

export default async (req) => {
  // 1) Meta webhook verification (sirf pehli baar)
  if (req.method === "GET") {
    const url = new URL(req.url);
    if (
      url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === process.env.VERIFY_TOKEN
    ) {
      return new Response(url.searchParams.get("hub.challenge"), { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("ok");

  // 2) Naya message
  try {
    const body = await req.json();
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return new Response("ok"); // delivery status wagera, ignore

    const from = msg.from;

    if (msg.type !== "text") {
      await sendText(from, "Meharbani karke apna paigham text mein likh kar bhejein.");
      return new Response("ok");
    }

    const store = getStore("chats");
    const chat = (await store.get(from, { type: "json" })) || { history: [], lastId: null };

    // WhatsApp kabhi kabhi wohi message dobara bhejta hai
    if (chat.lastId === msg.id) return new Response("ok");

    const messages = [...chat.history, { role: "user", content: msg.text.body }];
    const raw = await askAI(messages);
    const wantsMenuImage = raw.includes("[SEND_MENU_IMAGE]");
    const cleaned = raw.replace(/\[SEND_MENU_IMAGE\]/g, "").trim();
    const { reply, kind, data } = extractTag(cleaned);

    if (reply) await sendText(from, reply);

    if (wantsMenuImage) {
      const base = process.env.MENU_BASE_URL || new URL(req.url).origin;
      for (const file of MENU_IMAGES) {
        await sendImage(from, `${base}/${file}`);
      }
    }

    // History save (user + assistant ka jora, taake hamesha user se shuru ho)
    chat.history = [...messages, { role: "assistant", content: raw }].slice(-MAX_HISTORY);
    chat.lastId = msg.id;
    await store.setJSON(from, chat);

    // Order ya booking confirm hui to owner ko alert
    if (kind && data && process.env.OWNER_NUMBER) {
      await sendText(process.env.OWNER_NUMBER, ownerAlert(kind, data, from));
    }
  } catch (err) {
    console.error("Bot error:", err);
  }

  return new Response("ok");
};

// AI_PROVIDER = "gemini" (default, free tier) ya "claude"
async function askAI(messages) {
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  return provider === "claude" ? askClaude(messages) : askGemini(messages);
}

async function askGemini(messages) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: 2000 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();
  if (!text) throw new Error("Gemini returned an empty reply: " + JSON.stringify(data).slice(0, 300));
  return text;
}

async function askClaude(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-haiku-5-5",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// ORDER_JSON / BOOKING_JSON wali akhri line alag karta hai
function extractTag(text) {
  const m = text.match(/(ORDER|BOOKING)_JSON:\s*(\{[\s\S]*\})\s*$/);
  if (!m) return { reply: text.trim(), kind: null, data: null };
  let data = null;
  try { data = JSON.parse(m[2]); } catch { /* ignore */ }
  return { reply: text.slice(0, m.index).trim(), kind: m[1].toLowerCase(), data };
}

function ownerAlert(kind, d, customerNumber) {
  if (kind === "booking") {
    return `NEW BOOKING\nName: ${d.name}\nDate: ${d.date}\nTime: ${d.time}\nGuests: ${d.guests}\nWhatsApp: +${customerNumber}`;
  }
  const items = (d.items || []).map((i) => `- ${i.qty} x ${i.name} (Rs ${i.price})`).join("\n");
  return (
    `NEW ORDER (${d.type})\nName: ${d.name}\nWhatsApp: +${customerNumber}\n` +
    (d.address ? `Address: ${d.address}\n` : "") +
    `${items}\nSubtotal: Rs ${d.subtotal}\nDelivery: Rs ${d.delivery_charge}\n` +
    (d.delivery_note ? `Delivery note: ${d.delivery_note}\n` : "") +
    `Total: Rs ${d.total}\nPayment: ${d.payment || "Cash"}`
  );
}

async function sendText(to, text) {
  const res = await fetch(`${GRAPH}/${process.env.PHONE_NUMBER_ID}/messages`, {
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
  if (!res.ok) console.error("WhatsApp send error:", await res.text());
}

async function sendImage(to, link) {
  const res = await fetch(`${GRAPH}/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link },
    }),
  });
  if (!res.ok) console.error("WhatsApp image error:", await res.text());
}
