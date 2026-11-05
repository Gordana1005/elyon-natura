-- Telephony on the Macedonian PBX (Makedonski Telekom SIP trunk, 04.11.2026).
-- telephony_extensions was inherited from Bulgaria with the Sofia line as the
-- default caller-ID. The MK default is the main published line 02 512 8888.
-- The 30 pool rows (1001–1030) with their SIP secrets are loaded separately,
-- never through a migration (secrets stay out of the repo).

ALTER TABLE public.telephony_extensions
  ALTER COLUMN primary_caller_id SET DEFAULT '+38925128888';

COMMENT ON COLUMN public.telephony_extensions.primary_caller_id IS
  'What the main Call button presents — one of the Telekom trunk''s +389 numbers; default 02 512 8888. The PBX pulls it every 2 min (GET /api/voip/cid-map).';
