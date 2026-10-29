// Automatic translation of the guides into a language that has no ready-made translation.
// GET /api/translate?ping=1                      -> {ok: true|false}  (is a key configured?)
// GET /api/translate?lang=sw&part=ui|<appliance>&v=<version>
// The English source is /i18n/en.json. Answers are cached by Vercel's CDN, so each language is translated once per guide version.
// Needs ANTHROPIC_API_KEY in the Vercel project settings.
import Anthropic from "@anthropic-ai/sdk";

const MAX_PER_HOUR = 40; // per visitor IP, best effort
const hits = new Map();
const EN_NAMES = new Intl.DisplayNames(["en"], { type: "language" });

const SYSTEM = `You translate appliance guides for apartment tenants from English.
You get a JSON object of English strings and return a JSON object with exactly the same keys, every value translated.
Rules:
- Plain, simple words a tenant understands. Keep sentences short.
- Keep every HTML tag and attribute exactly as it is (for example <strong> and <span class="c-red">), translating only the text between tags.
- Names of buttons, knob positions, cycles, options, settings, lights and display messages stay in English exactly as printed on the appliance (for example Start/Pause, Normal, Tub Clean, Control Lock, Done, Water supply). You may add a short translation in brackets after a cycle name when it helps.
- Keep all numbers, measurements, model numbers and error codes unchanged.
- Never leave out or soften a safety warning.
- Return only the JSON object, with no code fences and no comments.`;

function flatten(obj, prefix, out) {
  if (typeof obj === "string") { if (obj.trim()) out[prefix] = obj; return out; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => flatten(v, `${prefix}.${i}`, out)); return out; }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (["img", "w", "h", "pdf", "pages", "kb"].includes(k)) continue;
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

function apply(obj, prefix, tr) {
  if (typeof obj === "string") return typeof tr[prefix] === "string" ? tr[prefix] : obj;
  if (Array.isArray(obj)) return obj.map((v, i) => apply(v, `${prefix}.${i}`, tr));
  if (obj && typeof obj === "object") {
    const o = {};
    for (const [k, v] of Object.entries(obj)) {
      o[k] = ["img", "w", "h", "pdf", "pages", "kb"].includes(k) ? v : apply(v, prefix ? `${prefix}.${k}` : k, tr);
    }
    return o;
  }
  return obj;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (req.query.ping) {
    res.setHeader("Cache-Control", "public, s-maxage=300, max-age=60");
    return res.status(200).json({ ok: Boolean(process.env.ANTHROPIC_API_KEY) });
  }
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.ANTHROPIC_API_KEY) return res.status(501).json({ error: "not configured" });

  const lang = String(req.query.lang || "").toLowerCase();
  const part = String(req.query.part || "");
  const v = String(req.query.v || "");
  if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(lang) || lang === "en") return res.status(400).json({ error: "bad lang" });
  let langName;
  try { langName = EN_NAMES.of(lang); } catch { langName = ""; }
  if (!langName || langName.toLowerCase() === lang) return res.status(400).json({ error: "unknown lang" });
  if (!/^[a-z0-9-]{2,60}$/.test(part)) return res.status(400).json({ error: "bad part" });

  let en;
  try {
    const r = await fetch(`https://${req.headers.host}/i18n/en.json`);
    if (!r.ok) return res.status(502).json({ error: "source not available" });
    en = await r.json();
  } catch {
    return res.status(502).json({ error: "source not available" });
  }
  if (v !== en.ver) return res.status(409).json({ error: "old version" });
  const src = part === "ui" ? en.ui : en.apps[part];
  if (!src) return res.status(404).json({ error: "unknown part" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= MAX_PER_HOUR) return res.status(429).json({ error: "too many requests" });
  recent.push(now);
  hits.set(ip, recent);

  const flat = flatten(src, "", {});
  const client = new Anthropic();
  try {
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 32000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: `Translate into ${langName} (language code ${lang}).\n\n${JSON.stringify(flat)}` }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") return res.status(502).json({ error: "not translated" });
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let tr;
    try { tr = JSON.parse(text); } catch { return res.status(502).json({ error: "not translated" }); }
    const done = Object.keys(flat).filter((k) => typeof tr[k] === "string").length;
    if (done < Object.keys(flat).length * 0.9) return res.status(502).json({ error: "incomplete" });
    res.setHeader("Cache-Control", "public, s-maxage=31536000, max-age=86400");
    return res.status(200).json({ lang, part, data: apply(src, "", tr) });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "busy" });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ error: "ai unavailable" });
    return res.status(500).json({ error: "failed" });
  }
}
