import { createClient } from "npm:@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const serviceNames: Record<string, string> = { cut: "Strih", combo: "Strih + brada", beard: "Brada" };

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function dateText(value: unknown) {
  const date = new Date(`${String(value)}T12:00:00Z`);
  return new Intl.DateTimeFormat("sk-SK", { timeZone: "Europe/Bratislava", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
}
function details(payload: Record<string, unknown>) {
  return `${dateText(payload.day)} o ${String(payload.start ?? "").slice(0, 5)} · ${serviceNames[String(payload.service)] ?? String(payload.service ?? "")}`;
}
function mailContent(kind: string, p: Record<string, unknown>) {
  const name = escapeHtml(p.name ?? "");
  const reference = escapeHtml(p.reference ?? "");
  const when = escapeHtml(details(p));
  const manage = typeof p.manage_url === "string" ? `<p><a href="${escapeHtml(p.manage_url)}">Spravovať rezerváciu</a></p>` : "";
  const textManage = typeof p.manage_url === "string" ? `\nSpráva rezervácie: ${p.manage_url}` : "";
  const templates: Record<string, { subject: string; title: string; message: string }> = {
    confirmation: { subject: `Potvrdená rezervácia ${p.reference}`, title: "Rezervácia je potvrdená", message: `Tešíme sa na vás ${when}. Kód rezervácie: ${reference}.` },
    reminder: { subject: `Pripomienka termínu ${p.reference}`, title: "Zajtra sa vidíme", message: `Pripomíname váš termín: ${when}. Kód rezervácie: ${reference}.` },
    cancelled: { subject: `Zrušený termín ${p.reference}`, title: "Rezervácia je zrušená", message: `Termín ${when} bol zrušený.` },
    rescheduled: { subject: `Zmenený termín ${p.reference}`, title: "Rezervácia bola zmenená", message: `Nový termín: ${when}. Kód rezervácie: ${reference}.` },
    request_declined: { subject: `Aktualizácia rezervácie ${p.reference}`, title: "Žiadosť nebola schválená", message: `Vaša žiadosť k rezervácii ${reference} nebola schválená. Pôvodný termín zostáva v platnosti.` },
    barber_request: { subject: `Žiadosť klienta ${p.reference}`, title: "Žiadosť o zmenu termínu", message: `${escapeHtml(p.name)} žiada o ${p.action === "cancel" ? "zrušenie" : "zmenu"} rezervácie ${reference}. Pôvodný termín: ${escapeHtml(dateText(p.old_day))} o ${escapeHtml(String(p.old_start ?? "").slice(0, 5))}.${p.action === "reschedule" ? ` Navrhovaný termín: ${escapeHtml(dateText(p.new_day))} o ${escapeHtml(String(p.new_start ?? "").slice(0, 5))} (${escapeHtml(serviceNames[String(p.new_service)] ?? p.new_service)}).` : ""}` },
  };
  const t = templates[kind] ?? { subject: `Rezervácia ${p.reference ?? ""}`, title: "Informácia k rezervácii", message: "Aktualizácia rezervácie." };
  return {
    subject: t.subject,
    text: `Dobrý deň${p.name ? ` ${p.name}` : ""},\n\n${t.message}${textManage}\n\nBarber booking`,
    html: `<div style="font-family:Arial,sans-serif;color:#171714;max-width:560px"><p>Dobrý deň${name ? ` ${name}` : ""},</p><h1 style="font-size:24px">${t.title}</h1><p>${t.message}</p>${manage}<p style="color:#777">Barber booking</p></div>`,
  };
}

async function sendEmail(to: string, kind: string, payload: Record<string, unknown>) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");
  if (!apiKey || !from) throw new Error("Chýba RESEND_API_KEY alebo EMAIL_FROM.");
  const content = mailContent(kind, payload);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], ...content }),
  });
  if (!response.ok) throw new Error(`E-mail služba vrátila ${response.status}.`);
}

function smsText(kind: string, p: Record<string, unknown>) {
  const ref = String(p.reference ?? "");
  const when = details(p);
  switch (kind) {
    case "confirmation": return `Rezervácia ${ref} potvrdená: ${when}. Správa: ${String(p.manage_url ?? "")}`;
    case "reminder": return `Pripomienka ${ref}: zajtra ${when}. Správa: ${String(p.manage_url ?? "")}`;
    case "cancelled": return `Rezervácia ${ref} na ${when} bola zrušená.`;
    case "rescheduled": return `Rezervácia ${ref} zmenená: ${when}.`;
    case "request_declined": return `Žiadosť pri rezervácii ${ref} nebola schválená. Pôvodný termín zostáva.`;
    default: return `Nová žiadosť klienta k rezervácii ${ref}.`;
  }
}

async function sendSms(to: string, kind: string, payload: Record<string, unknown>) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const auth = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !auth || !from) throw new Error("Chýba nastavenie Twilio SMS.");
  const credentials = btoa(`${sid}:${auth}`);
  const body = new URLSearchParams({ To: to, From: from, Body: smsText(kind, payload) });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST", headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!response.ok) throw new Error(`SMS služba vrátila ${response.status}.`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!serviceKey || bearer !== serviceKey) return new Response("Unauthorized", { status: 401 });
  try {
    const { data: notifications, error } = await db.rpc("claim_notifications", { p_limit: 30 });
    if (error) throw error;
    let sent = 0, failed = 0;
    for (const item of notifications ?? []) {
      try {
        if (item.channel === "email") await sendEmail(item.recipient, item.kind, item.payload);
        else if (item.channel === "sms") await sendSms(item.recipient, item.kind, item.payload);
        else throw new Error("Neznámy kanál oznámenia.");
        const { error: finishError } = await db.rpc("finish_notification", { p_id: item.id, p_sent: true, p_error: null });
        if (finishError) throw finishError;
        sent++;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Odoslanie zlyhalo.";
        await db.rpc("finish_notification", { p_id: item.id, p_sent: false, p_error: message });
        failed++;
      }
    }
    return Response.json({ processed: notifications?.length ?? 0, sent, failed });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Dispatch failed." }, { status: 500 });
  }
});
