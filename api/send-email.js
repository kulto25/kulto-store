// Vercel serverless function. Runs on the server, never in the browser, so
// the Resend API key stays secret. Set RESEND_API_KEY in Vercel's
// Environment Variables (Project -> Settings -> Environment Variables).
//
// Get a key at https://resend.com (free plan: 3.000 mails/mes, alcanza de
// sobra para confirmaciones de cuenta y avisos de compra).
//
// RESEND_FROM_EMAIL es opcional — la dirección desde la que salen los mails.
// Hasta que verifiques tu propio dominio en Resend (Domains -> Add Domain),
// dejala vacía y se usa "onboarding@resend.dev", que funciona para probar
// pero puede caer en spam. Una vez que verifiques tu dominio, poné algo como
// RESEND_FROM_EMAIL="Kulto <pedidos@tudominio.com>".

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "Falta configurar RESEND_API_KEY en el servidor. Mirá el README para activarlo.",
    });
    return;
  }

  try {
    const { to, subject, html } = req.body || {};
    if (!to || typeof to !== "string") {
      res.status(400).json({ error: "Falta el destinatario del mail." });
      return;
    }
    if (!subject || !html) {
      res.status(400).json({ error: "Falta el asunto o el contenido del mail." });
      return;
    }

    const from = process.env.RESEND_FROM_EMAIL || "Kulto <onboarding@resend.dev>";

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      res.status(response.status).json({ error: data?.message || "No se pudo enviar el mail." });
      return;
    }

    res.status(200).json({ ok: true, id: data?.id || null });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Error enviando el mail." });
  }
}
