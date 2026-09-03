// Vercel serverless-funktion: læser en PDF som brugeren selv har uploadet (fx et akkordark/lead sheet)
// og udtrækker akkorder + den sangtekst der allerede står i dokumentet, via Claude Haiku 4.5.
// ANTHROPIC_API_KEY læses fra miljøvariabler på serveren og eksponeres aldrig til klienten.
//
// VIGTIGT: Denne funktion transskriberer kun tekst der allerede findes i det dokument brugeren
// selv har uploadet — den finder eller gætter ALDRIG sangtekst ud fra egen viden (i modsætning til
// /api/chords, som kun bruger AI'ens egen viden om akkorder og aldrig håndterer sangtekst).

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
    lyrics: { type: "array", items: { type: "string" } },
  },
  required: ["found", "t", "a", "c", "bpm", "bpc", "form", "lyrics"],
  additionalProperties: false,
};

const SYSTEM = `Du læser et akkordark/lead sheet som brugeren selv har uploadet som PDF, og omsætter det til
et JSON-objekt der matcher det angivne skema. Svar KUN med JSON-objektet.

Reglerne for akkordstrengen "c" (samme format som resten af værktøjet):
- Del sangen op i afsnit med markører i firkantede parenteser, fx "[Intro] C G [Vers] Am F C G".
- Brug de afsnitsnavne dokumentet selv bruger, ellers korte danske navne: Intro, Vers, Omkvæd, Bro, Outro.
- Vær taktnøjagtig ud fra dokumentets egen notation: gentag en akkord det antal gange den reelt
  holdes/gentages ifølge dokumentet (antag 4/4-takt og "bpc" slag pr. akkord-token, medmindre andet
  fremgår). Skriv hvert afsnit kun én gang i "c" selvom sangen gentager det (brug "form" til det).
- Kun disse akkordkvaliteter må bruges: ingen suffiks (dur), m, 7, maj7, m7, dim, aug, sus2, sus4, sus,
  6, m6, 6/9, m6/9, 9, maj9, m9, 11, maj11, m11, 13, maj13, m13, add9, madd9, add11, add13, madd11,
  m7b5, 7sus4, 9sus4, 7b5, 7#5, 7b9, 7#9, 7#11, maj7#5, maj7b5, m7#5, samt skråstregs-bastone som C/E.
  Runder du en akkord dokumentet bruger til nærmeste understøttede type, hvis den ikke findes i listen.
- Brug store bogstaver for grundtonen (C, D, Eb, F#, ...).

Feltet "form" er sangens fulde forløb: en liste af afsnitsnavne i den rækkefølge dokumentet viser dem,
inkl. gentagelser. Tomt [] hvis dokumentet kun har ét gennemgående forløb uden afsnit.

Feltet "lyrics" skal have PRÆCIS ét element for hvert akkord-token i "c", i samme rækkefølge (tæl
akkord-tokens, ikke afsnitsmarkører — dette er en hård regel, tjek antallet før du svarer).
For hvert akkord-token: saml ALT tekst der hører til den akkord (til næste akkord starter) i ÉT
element — flere ord/stavelser under samme akkord bliver ét element, ikke ét element pr. ord.
Brug tom streng "" hvis akkorden ikke har nogen tekst ud for sig (fx en instrumental intro/outro-akkord).
Eksempel: hvis "c" er "C G Am F" og dokumentet viser ordene "Her går" under C, "vi nu" under G, intet
under Am, og "sammen" under F, skal "lyrics" være ["Her går","vi nu","","sammen"] — fire elementer,
ét pr. akkord, aldrig flere eller færre.
TRANSSKRIBÉR TEKSTEN PRÆCIS SOM DEN STÅR I DOKUMENTET — opfind, ret eller udvid ALDRIG tekst der ikke
allerede findes i det uploadede dokument.

- "bpm" er et realistisk tempo-gæt ud fra dokumentet (evt. eksplicit angivet), ellers 40-200.
- "t" og "a" er titel/kunstner hvis dokumentet angiver dem, ellers tomme strenge.
Sæt "found": false og lad de øvrige felter være tomme/0/[] , hvis dokumentet ikke indeholder et
genkendeligt akkordark (fx hvis det er en helt anden slags PDF).`;

// Delt, best-effort rate-limiting pr. IP (separat pulje fra /api/chords, da PDF-kald er dyrere).
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 4;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.windowStart >= WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_PER_WINDOW;
}

export const config = {
  api: { bodyParser: { sizeLimit: "8mb" } },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Kun POST er understøttet." });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ error: "For mange PDF-opslag lige nu. Vent et minut og prøv igen." });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Serveren mangler ANTHROPIC_API_KEY." });
    return;
  }

  const body = req.body || {};
  const pdfBase64 = typeof body.pdf === "string" ? body.pdf : "";
  if (!pdfBase64) {
    res.status(400).json({ error: "PDF mangler." });
    return;
  }
  if (pdfBase64.length > 7_000_000) {
    res.status(413).json({ error: "PDF'en er for stor (maks ca. 5 MB)." });
    return;
  }

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
        max_tokens: 4000,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
              { type: "text", text: "Udtræk akkorder, afsnit og sangtekst fra dette dokument." },
            ],
          },
        ],
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      res.status(502).json({ error: "PDF-læsning fejlede.", detail: detail.slice(0, 300) });
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
