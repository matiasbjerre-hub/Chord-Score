// Vercel serverless-funktion: opret bruger (personlig kode) eller log ind med en eksisterende kode.
// Ingen adgangskoder eller mails — kun et navn og en kode brugeren får vist én gang og selv
// gemmer, ligesom Production Planner. Gæster bruger appen helt uden at kalde denne funktion.
import { sessionCookieHeader, clearSessionCookieHeader } from "../lib/cookie.js";
import { createUser, getUserIdByCode, getUser } from "../lib/store.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Kun POST er understøttet." });
    return;
  }

  const body = req.body || {};
  const action = body.action;

  try {
    if (action === "signup") {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
      if (!name) {
        res.status(400).json({ error: "Navn mangler." });
        return;
      }
      const { userId, code } = await createUser(name);
      res.setHeader("Set-Cookie", sessionCookieHeader(userId));
      res.status(200).json({ name, code });
      return;
    }

    if (action === "login") {
      const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
      if (!code) {
        res.status(400).json({ error: "Kode mangler." });
        return;
      }
      const userId = await getUserIdByCode(code);
      if (!userId) {
        res.status(401).json({ error: "Forkert kode." });
        return;
      }
      const user = await getUser(userId);
      res.setHeader("Set-Cookie", sessionCookieHeader(userId));
      res.status(200).json({ name: user?.name || "" });
      return;
    }

    if (action === "logout") {
      res.setHeader("Set-Cookie", clearSessionCookieHeader());
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: "Ukendt handling." });
  } catch (err) {
    res.status(500).json({ error: "Uventet fejl.", detail: String(err).slice(0, 300) });
  }
}
