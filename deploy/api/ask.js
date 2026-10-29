// "Ask about a problem" box on the Troubleshooting tab.
// Answers only from that appliance's manual troubleshooting pages and tenant guides (served at /kb/<slug>.json).
// Needs ANTHROPIC_API_KEY in the Vercel project settings; without it the page falls back to its own search.
import Anthropic from "@anthropic-ai/sdk";

const MAX_PER_HOUR = 15; // per visitor IP, best effort (resets when the function restarts)
const hits = new Map();

const SYSTEM = `You help apartment tenants with a problem on one appliance.
Answer ONLY from the manual and guide excerpts provided. Do not use outside knowledge and do not guess.
Write for a tenant on a phone: plain words, at most about 120 words, short steps as a "- " list when there are steps. No headings.
Only suggest things a tenant can safely do (settings, cleaning, loading, checking the door, filters, detergent). Never suggest opening panels, moving the appliance, touching wiring, plumbing or repairs.
If the excerpts mention calling for service or a technician, say to contact property management instead.
For water leaking or overflowing, a burning smell, smoke, sparks, or an error code that means service: tell them to stop using the appliance and contact property management.
If the excerpts do not cover the problem, say you could not find it in the manual and suggest contacting property management.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(501).json({ error: "not configured" });

  const { appliance, question, lang } = req.body || {};
  const LANGS = { tr: "Turkish" };
  const answerIn = LANGS[lang] || "";
  if (typeof appliance !== "string" || !/^[a-z0-9-]{2,60}$/.test(appliance)) return res.status(400).json({ error: "bad appliance" });
  if (typeof question !== "string" || !question.trim() || question.length > 300) return res.status(400).json({ error: "bad question" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= MAX_PER_HOUR) return res.status(429).json({ error: "too many questions" });
  recent.push(now);
  hits.set(ip, recent);

  let kb;
  try {
    const r = await fetch(`https://${req.headers.host}/kb/${appliance}.json`);
    if (!r.ok) return res.status(404).json({ error: "unknown appliance" });
    kb = await r.json();
  } catch {
    return res.status(502).json({ error: "manual not available" });
  }

  const chunks = kb.chunks.filter((c) => !c.lang || c.lang === lang || (!answerIn && c.lang === "en"));
  const excerpts = chunks.map((c, i) => `[${i + 1}] (${c.src}${c.title ? ", " + c.title : ""}) ${c.text}`).join("\n\n");
  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 1500,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `Appliance: ${kb.appliance}\n\nExcerpts:\n${excerpts}\n\nTenant's problem: ${question.trim()}\n\nAfter your answer, on a last line write SOURCES: followed by the excerpt numbers you used, comma separated.${answerIn ? `\n\nWrite your answer in ${answerIn} (keep button and display names exactly as they appear on the appliance). Keep the SOURCES line in English.` : ""}`,
      }],
    });
    if (response.stop_reason === "refusal") return res.status(200).json({ answer: "" });
    let text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    let sources = [];
    const m = text.match(/\n?SOURCES:\s*([\d,\s]*)$/i);
    if (m) {
      text = text.slice(0, m.index).trim();
      const srcs = m[1].split(",").map((n) => chunks[parseInt(n, 10) - 1]?.src).filter(Boolean);
      sources = [...new Set(srcs)];
    }
    return res.status(200).json({ answer: text, sources });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "busy" });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ error: "ai unavailable" });
    return res.status(500).json({ error: "failed" });
  }
}
