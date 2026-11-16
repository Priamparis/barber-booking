import { createClient } from "npm:@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const siteUrl = Deno.env.get("SITE_URL")!;
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const services: Record<string, { name: string; duration: number }> = {
  cut: { name: "Strih", duration: 60 },
  combo: { name: "Strih + brada", duration: 90 },
  beard: { name: "Brada", duration: 30 },
};

function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function fail(message: string, status = 400) { return reply({ error: message }, status); }
function cleanTime(value: string) { return value?.slice(0, 5) ?? ""; }
function minute(value: string) { const [h, m] = value.split(":").map(Number); return h * 60 + m; }
function hhmm(value: number) { return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }
function dateInBratislava(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bratislava", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function minuteInBratislava(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bratislava", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}
async function tokenHash(token: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
function requiredString(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${label} je povinné.`);
  return value.trim();
}
function checkDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Neplatný dátum.");
  return value;
}
function checkService(value: unknown) {
  if (typeof value !== "string" || !services[value]) throw new Error("Vyberte platnú službu.");
  return value;
}
function emailOrPhone(email: unknown, phone: unknown) {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  const p = typeof phone === "string" ? phone.trim() : "";
  if (e && (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error("Skontrolujte e-mailovú adresu.");
  if (p && !/^\+?[0-9 ()-]{7,24}$/.test(p)) throw new Error("Skontrolujte telefónne číslo.");
  if (!e && !p) throw new Error("Zadajte e-mail alebo telefón.");
  return { email: e || null, phone: p || null };
}
async function requireAdmin(req: Request) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) throw new Error("Prihláste sa do administrácie.");
  const authClient = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await authClient.auth.getUser(bearer);
  if (error || !data.user?.email) throw new Error("Prihlásenie vypršalo. Prihláste sa znova.");
  const { data: admin, error: adminError } = await db.from("admin_users").select("email")
    .eq("email", data.user.email.toLowerCase()).maybeSingle();
  if (adminError || !admin) throw new Error("Tento účet nemá prístup do administrácie.");
  return data.user;
}

async function publicDays() {
  const today = dateInBratislava();
  const end = new Date(`${today}T12:00:00+01:00`); end.setDate(end.getDate() + 180);
  const endKey = end.toISOString().slice(0, 10);
  const { data, error } = await db.from("open_days").select("day,first_start,last_start")
    .gte("day", today).lte("day", endKey).order("day");
  if (error) throw error;
  return (data ?? []).map((d: any) => ({ date: d.day, opens: cleanTime(d.first_start), lastStart: cleanTime(d.last_start) }));
}

async function publicSlots(day: string, service: string, excludeId?: string) {
  const { data: open, error: dayError } = await db.from("open_days").select("day,first_start,last_start")
    .eq("day", day).maybeSingle();
  if (dayError) throw dayError;
  if (!open) return [];
  let query = db.from("appointments").select("id,starts_at,duration_minutes")
    .eq("booking_day", day).eq("status", "confirmed").order("starts_at");
  if (excludeId) query = query.neq("id", excludeId);
  const { data: booked, error } = await query;
  if (error) throw error;
  const duration = services[service].duration;
  const opening = minute(cleanTime(open.first_start));
  const last = minute(cleanTime(open.last_start));
  const starts = new Set<number>();
  for (let t = Math.ceil(opening / 60) * 60; t <= last; t += 60) starts.add(t);
  for (const b of booked ?? []) {
    const occupiedStart = minute(cleanTime(b.starts_at));
    const end = occupiedStart + b.duration_minutes;
    for (const candidate of [end, occupiedStart - duration]) {
      if (candidate % 60 === 30 && candidate <= last) starts.add(candidate);
    }
  }
  const now = dateInBratislava();
  const currentMinute = day === now ? minuteInBratislava() : -1;
  return [...starts].sort((a, b) => a - b).filter(t => {
    if (t < opening || t > last || t <= currentMinute) return false;
    return !(booked ?? []).some((b: any) => {
      const s = minute(cleanTime(b.starts_at));
      return t < s + b.duration_minutes && t + duration > s;
    });
  }).map(hhmm);
}

async function adminAction(body: any) {
  switch (body.action) {
    case "admin_list": {
      const [days, bookings, requests, settings] = await Promise.all([
        db.from("open_days").select("day,first_start,last_start").order("day"),
        db.from("appointments").select("id,reference,customer_name,email,phone,service,duration_minutes,booking_day,starts_at,status")
          .order("booking_day").order("starts_at"),
        db.from("change_requests").select("id,appointment_id,action,new_service,new_day,new_start,status,created_at")
          .order("created_at", { ascending: false }),
        db.from("business_settings").select("admin_email,timezone").eq("singleton", true).single(),
      ]);
      for (const result of [days, bookings, requests, settings]) if (result.error) throw result.error;
      return { days: days.data, bookings: bookings.data, requests: requests.data, settings: settings.data };
    }
    case "admin_set_day": {
      const day = checkDate(body.date);
      const opens = requiredString(body.opens, "Prvý začiatok", 5);
      const last = requiredString(body.lastStart, "Posledný začiatok", 5);
      if (!/^\d{2}:\d{2}$/.test(opens) || !/^\d{2}:\d{2}$/.test(last) || minute(last) < minute(opens)) throw new Error("Skontrolujte časové rozmedzie.");
      const { data: existing, error: checkError } = await db.from("appointments").select("starts_at")
        .eq("booking_day", day).eq("status", "confirmed");
      if (checkError) throw checkError;
      if ((existing ?? []).some((b: any) => minute(cleanTime(b.starts_at)) < minute(opens) || minute(cleanTime(b.starts_at)) > minute(last))) {
        throw new Error("Nové rozmedzie by vylúčilo už rezervovaný začiatok.");
      }
      const { error } = await db.from("open_days").upsert({ day, first_start: opens, last_start: last });
      if (error) throw error;
      return { ok: true };
    }
    case "admin_close_day": {
      const day = checkDate(body.date);
      const { count, error: countError } = await db.from("appointments").select("id", { count: "exact", head: true })
        .eq("booking_day", day).eq("status", "confirmed");
      if (countError) throw countError;
      if (count) throw new Error("Najprv zrušte alebo presuňte rezervácie v daný deň.");
      const { error } = await db.from("open_days").delete().eq("day", day);
      if (error) throw error;
      return { ok: true };
    }
    case "admin_resolve": {
      const { data: request, error: requestError } = await db.from("change_requests").select("appointment_id")
        .eq("id", body.requestId).maybeSingle();
      if (requestError) throw requestError;
      if (!request) throw new Error("Žiadosť sa nenašla.");
      const { data: appointment, error: appointmentError } = await db.from("appointments").select("email,phone")
        .eq("id", request.appointment_id).maybeSingle();
      if (appointmentError) throw appointmentError;
      if (appointment?.email && (!Deno.env.get("RESEND_API_KEY") || !Deno.env.get("EMAIL_FROM"))) throw new Error("Najprv nastavte e-mailovú službu Resend.");
      if (!appointment?.email && (!Deno.env.get("TWILIO_ACCOUNT_SID") || !Deno.env.get("TWILIO_AUTH_TOKEN") || !Deno.env.get("TWILIO_FROM_NUMBER"))) throw new Error("Najprv nastavte SMS službu Twilio.");
      const { data, error } = await db.rpc("admin_resolve_request", {
        p_request_id: body.requestId, p_approve: body.approve === true,
      });
      if (error) throw error;
      return { result: data };
    }
    case "admin_settings": {
      const email = typeof body.adminEmail === "string" ? body.adminEmail.trim().toLowerCase() : "";
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Skontrolujte e-mailovú adresu.");
      const { error } = await db.from("business_settings").update({ admin_email: email || null }).eq("singleton", true);
      if (error) throw error;
      if (body.adminUserEmail) {
        const adminEmail = requiredString(body.adminUserEmail, "E-mail barbera", 254).toLowerCase();
        const { error: upsertError } = await db.from("admin_users").upsert({ email: adminEmail });
        if (upsertError) throw upsertError;
      }
      return { ok: true };
    }
    default: throw new Error("Neznáma administrátorská akcia.");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("Použite POST.", 405);
  try {
    const body = await req.json();
    if (typeof body.action !== "string") return fail("Chýba akcia.");
    if (body.action.startsWith("admin_")) {
      await requireAdmin(req);
      return reply(await adminAction(body));
    }
    switch (body.action) {
      case "days": return reply({ days: await publicDays() });
      case "slots": {
        const day = checkDate(body.date), service = checkService(body.service);
        return reply({ slots: await publicSlots(day, service, typeof body.excludeId === "string" ? body.excludeId : undefined) });
      }
      case "create": {
        const name = requiredString(body.name, "Meno", 80);
        const { email, phone } = emailOrPhone(body.email, body.phone);
        if (email && (!Deno.env.get("RESEND_API_KEY") || !Deno.env.get("EMAIL_FROM"))) throw new Error("Automatické e-maily ešte nie sú nastavené. Skúste to neskôr alebo kontaktujte barber shop.");
        if (!email && (!Deno.env.get("TWILIO_ACCOUNT_SID") || !Deno.env.get("TWILIO_AUTH_TOKEN") || !Deno.env.get("TWILIO_FROM_NUMBER"))) throw new Error("SMS potvrdenia ešte nie sú nastavené. Zadajte e-mail alebo kontaktujte barber shop.");
        const service = checkService(body.service), day = checkDate(body.date);
        const start = requiredString(body.time, "Čas", 5);
        if (!/^\d{2}:\d{2}$/.test(start)) throw new Error("Neplatný čas.");
        const token = randomToken();
        if (!siteUrl?.startsWith("https://")) throw new Error("Administrátor ešte nenastavil adresu zverejnenej stránky.");
        const manageUrl = `${siteUrl.replace(/\/$/, "")}/#manage=${token}`;
        const { data, error } = await db.rpc("create_booking", {
          p_name: name, p_email: email, p_phone: phone, p_service: service,
          p_day: day, p_start: start, p_token_hash: await tokenHash(token), p_manage_url: manageUrl,
        });
        if (error) throw error;
        const row = data?.[0];
        return reply({ reference: row.booking_reference, token, date: day, time: start,
          service, duration: row.duration_minutes, name });
      }
      case "manage_details": {
        const token = requiredString(body.token, "Odkaz na rezerváciu", 100);
        const { data, error } = await db.rpc("customer_booking", { p_token_hash: await tokenHash(token) });
        if (error) throw error;
        if (!data?.length) return fail("Rezervácia sa nenašla.", 404);
        return reply({ booking: data[0] });
      }
      case "manage": {
        const token = requiredString(body.token, "Odkaz na rezerváciu", 100);
        const action = body.manageAction === "cancel" ? "cancel" : body.manageAction === "reschedule" ? "reschedule" : "";
        if (!action) throw new Error("Neznáma požiadavka.");
        if (!Deno.env.get("RESEND_API_KEY") || !Deno.env.get("EMAIL_FROM")) throw new Error("E-mailové upozornenia ešte nie sú nastavené.");
        const hash = await tokenHash(token);
        const { data: booking, error: bookingError } = await db.rpc("customer_booking", { p_token_hash: hash });
        if (bookingError) throw bookingError;
        if (!booking?.length) throw new Error("Rezervácia sa nenašla.");
        if (booking[0].email && (!Deno.env.get("RESEND_API_KEY") || !Deno.env.get("EMAIL_FROM"))) throw new Error("E-mailové upozornenia ešte nie sú nastavené.");
        if (!booking[0].email && (!Deno.env.get("TWILIO_ACCOUNT_SID") || !Deno.env.get("TWILIO_AUTH_TOKEN") || !Deno.env.get("TWILIO_FROM_NUMBER"))) throw new Error("SMS upozornenia ešte nie sú nastavené.");
        const p = { p_token_hash: await tokenHash(token), p_action: action,
          p_new_service: action === "reschedule" ? checkService(body.service) : null,
          p_new_day: action === "reschedule" ? checkDate(body.date) : null,
          p_new_start: action === "reschedule" ? requiredString(body.time, "Čas", 5) : null };
        const { data, error } = await db.rpc("manage_booking", p);
        if (error) throw error;
        return reply({ result: data?.[0]?.result, reference: data?.[0]?.booking_reference });
      }
      default: return fail("Neznáma akcia.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nepodarilo sa spracovať požiadavku.";
    const status = message.includes("Prihláste sa") || message.includes("účet nemá") ? 401 : 400;
    return fail(message, status);
  }
});
