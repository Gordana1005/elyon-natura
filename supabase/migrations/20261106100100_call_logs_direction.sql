-- call_logs.direction (05.11.2026): 'inbound' = PBX queue 700 "Teleshop In" rang the softphone and the agent answered
-- in the browser; 'outbound' = every dial (and the whole history). A constant default is metadata-only on PG >= 11.
BEGIN;

ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outbound';
ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_direction_check;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_direction_check CHECK (direction IN ('outbound', 'inbound'));
COMMENT ON COLUMN public.call_logs.direction IS
  'inbound = the Teleshop In queue (02 512 8888 / 02 620 2515) rang the browser and the agent answered (05.11.2026); outbound = every dial.';

COMMIT;

NOTIFY pgrst, 'reload schema';
-- Rollback: ALTER TABLE public.call_logs DROP COLUMN direction;
