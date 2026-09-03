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
    form: { type: "array", items: { type: "string" } },
  },
  required: ["found", "t", "a", "c", "bpm", "bpc", "form"],
  additionalProperties: false,
};

const SYSTEM = `Du finder akkordrækker til sange til et klaver/guitar-akkordværktøj.
Svar KUN med et JSON-objekt der matcher det angivne skema.

Grundprincip: "bpc" (slag pr. akkord) er hvor mange slag HVER enkelt akkord i strengen "c" repræsenterer.
Antag 4/4-taktart (4 slag pr. takt), medmindre sangen tydeligvis har en anden taktart.
Akkordstrengen skal være TAKTNØJAGTIG: en akkord der reelt holdes i N takter skal gentages
N×4/bpc gange i træk — ikke forkortes til én enkelt forekomst.
Eksempel: et vers på 8 takter der starter 2 takter C, så 2 takter Am, så 4 takter F, med bpc=4:
  "C C Am Am F F F F" (8 akkorder = 8 takter).
Samme vers med bpc=2 (dobbelt opløsning): "C C C C Am Am Am Am F F F F F F F F" (16 akkorder).
Vælg "bpc" så akkordantallet pr. afsnit bliver til at overskue — foretræk 4, brug 2 ved hurtigere
akkordskift, og kun 1 ved meget hurtige skift. Skift ikke bpc undervejs i sangen.

Reglerne for akkordstrengen "c":
- Del sangen op i afsnit med markører i firkantede parenteser før hvert afsnits akkorder, fx:
  "[Intro] C C G G [Vers] Am Am F F C C G G [Omkvæd] F F G G C C Am Am [Bro] Dm Dm G7 G7"
- Brug kun de afsnit sangen faktisk har, med korte danske navne: Intro, Vers, Omkvæd, Bro, Outro
  (udelad afsnit der ikke findes, og udelad markørerne helt hvis sangen kun har ét gennemgående forløb).
- Skriv hvert afsnit taktnøjagtigt ud ÉN gang i "c", uanset om sangen reelt gentager afsnittet flere
  gange (fx to vers med samme akkorder) — gentag ikke selve afsnittet i "c".
- Kun disse akkordkvaliteter må bruges: ingen suffiks (dur), m, 7, maj7, M7, m7, min, min7, dim, dim7, aug, sus2, sus4, sus,
  6, m6, 6/9, m6/9, 9, maj9, m9, 11, maj11, m11, 13, maj13, m13, add9, madd9, add11, add13, madd11,
  m7b5, 7sus4, 9sus4, 7b5, 7#5, 7b9, 7#9, 7#11, maj7#5, maj7b5, m7#5, samt skråstregs-bastone som C/E.
- Brug store bogstaver for grundtonen (C, D, Eb, F#, ...).

Feltet "form" er sangens FULDE reelle forløb: en liste af afsnitsnavne (samme navne som brugt i "c",
uden firkantede parenteser) i den rækkefølge de rent faktisk synges/spilles, inkl. gentagelser, fx
["Intro","Vers","Omkvæd","Vers","Omkvæd","Bro","Omkvæd","Outro"]. Har sangen intet afsnit i "c"
(ét gennemgående forløb), så returnér "form" som en tom liste [].

- "bpm" er et realistisk tempo-gæt mellem 40 og 200.
- "t" og "a" ekko'er den angivne titel/kunstner, evt. med korrekt stavning.
Sæt "found": false og lad de øvrige felter være tomme streng/0/[] , hvis du ikke er rimeligt sikker på sangens akkorder eller taktopbygning. Gæt aldrig useriøst — det er bedre at sige nej.`;

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
        max_tokens: 2000,
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
