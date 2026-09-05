// Vercel serverless-funktion: hent eller opdatér den indloggede brugers gemte data
// (favoritter, transponeringer, egne uploads, afsnitsrettelser). Gæster har ingen konto —
// de får {guest:true}, og appen falder tilbage til localStorage i browseren for dem.
import { getUserIdFromRequest } from "../lib/cookie.js";
import { getUser, saveUser } from "../lib/store.js";

const SAVE_KEYS = ["favorites", "songOverrides", "uploads"];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

export default async function handler(req, res) {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    res.status(200).json({ guest: true });
    return;
  }

  try {
    if (req.method === "GET") {
      const user = await getUser(userId);
      if (!user) {
        res.status(200).json({ guest: true });
        return;
      }
      res.status(200).json({ guest: false, name: user.name, ...pick(user, SAVE_KEYS) });
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      if (JSON.stringify(body).length > 200_000) {
        res.status(413).json({ error: "For meget data at gemme på én gang." });
        return;
      }
      const user = await getUser(userId);
      if (!user) {
        res.status(401).json({ error: "Ukendt bruger." });
        return;
      }
      for (const key of SAVE_KEYS) {
        if (key in body) user[key] = body[key];
      }
      await saveUser(userId, user);
      res.status(200).json({ guest: false, name: user.name, ...pick(user, SAVE_KEYS) });
      return;
    }

    res.status(405).json({ error: "Kun GET/POST er understøttet." });
  } catch (err) {
    res.status(500).json({ error: "Uventet fejl.", detail: String(err).slice(0, 300) });
  }
}
