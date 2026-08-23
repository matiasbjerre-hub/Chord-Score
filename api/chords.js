// Vercel serverless-funktion: slår en sangs akkorder op via Claude Haiku 4.5.
// ANTHROPIC_API_KEY læses fra miljøvariabler på serveren og eksponeres aldrig til klienten.

const SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    t: { type: "string" },
    a: { type: "string" },
    c: { type: "string" },
    bpm: { type: "integer" },
    bpc: { type: "integer" },
  },
  required: ["found", "t", "a", "c", "bpm", "bpc"],
  additionalProperties: false,
};

const SYSTEM = `Du finder akkordrækker til sange til et klaver/guitar-akkordværktøj.
Svar KUN med et JSON-objekt der matcher det angivne skema.
Reglerne for akkordstrengen "c":
- Del sangen op i afsnit med markører i firkantede parenteser før hvert afsnits akkorder, fx:
  "[Intro] C G [Vers] Am F C G [Omkvæd] F G C Am [Bro] Dm G7"
- Brug kun de afsnit sangen faktisk har, med korte danske navne: Intro, Vers, Omkvæd, Bro, Outro
  (udelad afsnit der ikke findes, og udelad markørerne helt hvis sangen kun har ét gennemgående forløb).
- Hvert afsnit har 2-8 akkorder adskilt af mellemrum, i den rækkefølge de typisk optræder.
- Kun disse akkordkvaliteter må bruges: ingen suffiks (dur), m, 7, maj7, m7, dim, aug, sus2, sus4, 6, 9, add9, m7b5, samt skråstregs-bastone som C/E.
- Brug store bogstaver for grundtonen (C, D, Eb, F#, ...).
- "bpm" er et realistisk tempo-gæt mellem 40 og 200. "bpc" er slag pr. akkord: 1, 2 eller 4.
- "t" og "a" ekko'er den angivne titel/kunstner, evt. med korrekt stavning.
Sæt "found": false og lad de øvrige felter være tomme streng/0, hvis du ikke er rimeligt sikker på sangens akkorder. Gæt aldrig useriøst — det er bedre at sige nej.`;

// Simpel, best-effort rate-limiting pr. IP (i hukommelsen — nulstilles ved kolde starter,
// men bremser almindeligt misbrug af et offentligt, unauthenticated endpoint uden ekstern afhængighed).
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 8;
const hits = new Map(); // ip -> {count, windowStart}

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.windowStart >= WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    if (hits.size > 5000) hits.clear(); // simpelt værn mod ubegrænset hukommelsesvækst
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Kun POST er understøttet." });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ error: "For mange AI-opslag lige nu. Vent et minut og prøv igen." });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Serveren mangler ANTHROPIC_API_KEY." });
    return;
  }

  const body = req.body || {};
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  const artist = typeof body.artist === "string" ? body.artist.trim().slice(0, 120) : "";
  if (!title) {
    res.status(400).json({ error: "Titel mangler." });
    return;
  }

  const userMsg = `Sang: "${title}"${artist ? ` af ${artist}` : ""}`;

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: userMsg }],
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      res.status(502).json({ error: "AI-opslag fejlede.", detail: detail.slice(0, 300) });
      return;
    }

    const data = await upstream.json();
    const block = (data.content || []).find((b) => b.type === "text");
    if (!block) {
      res.status(502).json({ error: "Intet svar fra AI." });
      return;
    }

    const parsed = JSON.parse(block.text);
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: "Uventet fejl.", detail: String(err).slice(0, 300) });
  }
}
