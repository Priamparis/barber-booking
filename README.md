# Barber booking

Static customer page on GitHub Pages, Supabase database and Edge Functions for booking/admin actions, and a private notification outbox. `local-demo.html` is the earlier browser-only prototype; `index.html` is the cloud-connected page.

## What the system does

- Offers Strih (60 min), Strih + brada (90 min), and Brada (30 min).
- Barber opens dates and chooses the first and last allowed start. The last start can be 19:00; the service may finish later.
- Lists free starts in chronological order. Whole-hour starts are standard; a half-hour start is added only when it touches another booking.
- Rechecks the selected time inside a database transaction before saving, so two customers cannot reserve the same time concurrently.
- Gives the customer a random, private management link. More than 24 hours before the appointment, changes/cancellations apply directly. Inside 24 hours, a request is queued for barber approval.
- Queues confirmation and 24-hour reminders for the customer's selected contact. E-mail uses Resend; phone-only bookings use Twilio SMS. A scheduled Supabase job drains the queue.
- Keeps customer data in Supabase. The browser receives only the public API key; service-role and messaging keys stay in Supabase secrets.

## Deployment

The repository is prepared for GitHub Actions. It does not contain project URLs, passwords, API keys, or other live credentials.

1. Create a Supabase project and select an EU region for the database. Copy its project URL, project reference, and public/anon key.
2. In the GitHub repository, open **Settings → Secrets and variables → Actions**. Add repository variables `SUPABASE_URL`, `SUPABASE_PUBLIC_KEY`, `SUPABASE_PROJECT_REF`, and `BARBER_SITE_URL`. For a repository named `barber-booking`, the default site URL is `https://Priamparis.github.io/barber-booking/`.
3. Add repository secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`.
4. Run **Actions → Deploy Supabase backend → Run workflow**. It applies the migration and deploys both Edge Functions.
5. In Supabase, invite/create the barber's Auth user. In **SQL Editor**, add that exact login e-mail to the administrator allowlist and set the notification address:

   ```sql
   insert into public.admin_users(email)
   values (lower('BARBER_LOGIN_EMAIL'))
   on conflict (email) do nothing;

   update public.business_settings
   set admin_email = lower('BARBER_NOTIFICATION_EMAIL')
   where singleton = true;
   ```

   The invited barber signs in from the page's **Správa** tab. After the first admin is set, the notification e-mail and allowed login e-mail can be edited there.

6. Configure Edge Function secrets in Supabase: `SITE_URL` and, for email delivery, `RESEND_API_KEY` and `EMAIL_FROM`. Verify the sender domain with the email provider. For phone-only booking and SMS delivery, also configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`. These provider accounts may have their own fees and verification requirements.
7. Enable Supabase `pg_cron`, `pg_net`, and Vault extensions. Add the project URL and service-role key as Vault secrets named `barber_project_url` and `barber_service_key`, then run `supabase/cron.sql`. Never put the service-role key in GitHub variables or `config.js`.
8. The **Publish GitHub Pages** workflow publishes on every push to `main`. Add the repository variables first, then run that workflow so `config.js` receives the public Supabase URL/key. The repository Pages URL is a GitHub subdomain; a custom domain must already be owned and configured with DNS.

## Security notes

- `config.js` contains public values only. It is generated during the Pages workflow from repository variables.
- Database tables have row-level security enabled and are not exposed to browser roles. The Edge Function checks admin identity and calls server-side functions using the private service-role key.
- Customer management uses a random 256-bit secret in the link fragment. Only its SHA-256 hash is stored in the database. The notification worker removes the raw link from the outbox after delivery.
- Before public launch, set the actual barber contact and service-provider credentials and confirm that the scheduled job is delivering messages. The source can be published before configuration, but the booking page stays in setup mode until its Supabase URL/key are present.

## Local demo

Open `local-demo.html` to see the earlier browser-only interaction prototype. It stores data locally in that browser and is not the live shared booking system.
