-- Run after enabling the pg_cron, pg_net and Vault extensions in Supabase.
-- Create both Vault secrets in the dashboard first:
--   name: barber_project_url     value: https://YOUR-PROJECT-REF.supabase.co
--   name: barber_service_key    value: the project's service_role key
-- Never commit those values to GitHub.

select cron.schedule(
  'barber-dispatch-notifications',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'barber_project_url') || '/functions/v1/dispatch-notifications',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'barber_service_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    ) as request_id;
  $$
);
