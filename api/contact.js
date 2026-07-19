// api/contact.js
// Deploy this file at that exact path in a Vercel project and it becomes
// the endpoint POST /api/contact automatically. No extra config needed.
//
// ── ONE-TIME SETUP ────────────────────────────────────────────────────
// 1. In Brevo: Settings → SMTP & API → API Keys → create a key.
//    In Vercel: Project → Settings → Environment Variables, add:
//      BREVO_API_KEY      = <your Brevo API key>
//      NOTIFY_EMAIL       = ask@sgcvhub.com   (where you want to be alerted)
//      BREVO_SENDER_EMAIL = a verified sender in Brevo (Settings → Senders)
//      BREVO_LIST_ID      = the numeric ID of a Brevo contact list to add
//                           leads to (Contacts → Lists → click a list, the
//                           ID is in the URL)
// 2. In Brevo: Contacts → Settings → Contact Attributes, add these as
//    "Normal" text attributes if they don't already exist:
//      COMPANY, PHONE, ENQUIRY, MODEL_INTEREST, VEHICLE_NUMBER, MESSAGE
//    (FIRSTNAME/LASTNAME/EMAIL already exist by default.)
// 3. Never put BREVO_API_KEY in the HTML/JS that runs in the browser —
//    it must only live here, server-side.
// ─────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    reason,
    companyName,
    contactName,
    email,
    contactNumber,
    modelInterest,
    vehicleNumber,
    accessCode,
    message
  } = req.body || {};

  // ── Basic server-side validation (never trust the client alone) ──
  if (!reason || !companyName || !contactName || !email || !contactNumber) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  if (reason === 'Trade-in / Scrapping' && (!vehicleNumber || !accessCode)) {
    return res.status(400).json({ error: 'Missing trade-in details' });
  }
  if ((reason === 'Brochure request' || reason === 'Spec sheet request') && !modelInterest) {
    return res.status(400).json({ error: 'Missing model selection' });
  }

  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
  const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;
  const LIST_ID = process.env.BREVO_LIST_ID ? Number(process.env.BREVO_LIST_ID) : undefined;

  if (!BREVO_API_KEY || !NOTIFY_EMAIL || !SENDER_EMAIL) {
    console.error('Missing Brevo environment variables');
    return res.status(500).json({ error: 'Server not configured' });
  }

  const [firstName, ...rest] = contactName.trim().split(' ');
  const lastName = rest.join(' ') || '-';

  try {
    // ── 1. Upsert the lead into Brevo Contacts (for CRM/automation) ──
    // Deliberately NOT storing accessCode here — it's a one-time
    // credential-adjacent value, not something that belongs sitting in a
    // marketing contact list long-term.
    const contactPayload = {
      email,
      attributes: {
        FIRSTNAME: firstName,
        LASTNAME: lastName,
        COMPANY: companyName,
        PHONE: contactNumber,
        ENQUIRY: reason,
        MODEL_INTEREST: modelInterest || '',
        VEHICLE_NUMBER: vehicleNumber || '',
        MESSAGE: message || ''
      },
      updateEnabled: true
    };
    if (LIST_ID) contactPayload.listIds = [LIST_ID];

    const contactRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(contactPayload)
    });

    // Brevo returns 204 on update, 201 on create, 400 with "duplicate_parameter"
    // if the contact already exists but updateEnabled wasn't set — with
    // updateEnabled:true this path is fine either way. Only hard-fail on
    // genuinely unexpected errors.
    if (!contactRes.ok && contactRes.status !== 204) {
      const errText = await contactRes.text();
      console.error('Brevo contact upsert failed:', errText);
    }

    // ── 2. Send yourself a transactional email notification ──
    // This is how the access code reaches you: once, by email, not stored
    // as a persistent CRM field.
    const isTradeIn = reason === 'Trade-in / Scrapping';
    const htmlContent = `
      <h2>New ${reason} enquiry — SgCVhub</h2>
      <p><strong>Company:</strong> ${escapeHtml(companyName)}<br>
      <strong>Contact:</strong> ${escapeHtml(contactName)}<br>
      <strong>Email:</strong> ${escapeHtml(email)}<br>
      <strong>Phone:</strong> ${escapeHtml(contactNumber)}</p>
      ${modelInterest ? `<p><strong>Model interested in:</strong> ${escapeHtml(modelInterest)}</p>` : ''}
      ${isTradeIn ? `
        <p><strong>Vehicle number:</strong> ${escapeHtml(vehicleNumber)}<br>
        <strong>LTA Access Code:</strong> ${escapeHtml(accessCode)}</p>
        <p style="color:#C0392B;font-size:13px;">Reminder: use this code promptly and don't forward or store it beyond what's needed for the valuation — it's tied to the customer's OneMotoring account.</p>
      ` : ''}
      ${message ? `<p><strong>Message:</strong><br>${escapeHtml(message).replace(/\n/g, '<br>')}</p>` : ''}
    `;

    const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'SgCVhub Website', email: SENDER_EMAIL },
        to: [{ email: NOTIFY_EMAIL }],
        replyTo: { email, name: contactName },
        subject: `New ${reason} — ${companyName}`,
        htmlContent
      })
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error('Brevo transactional email failed:', errText);
      // Contact was still saved to the CRM even if the email alert failed,
      // so we don't necessarily need to fail the whole request — but for
      // a solo operator relying on the email alert to know a lead came in,
      // safer to surface the failure.
      return res.status(502).json({ error: 'Notification email failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Contact form submission error:', err);
    return res.status(500).json({ error: 'Unexpected server error' });
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
