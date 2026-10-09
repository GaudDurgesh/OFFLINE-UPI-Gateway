CREATE FUNCTION public.get_device_for_verification(
  p_device_id UUID
)
RETURNS TABLE (
  account_id UUID,
  public_key_pem TEXT,
  status TEXT
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    d.account_id,
    d.public_key_pem,
    d.status
  FROM public.devices AS d
  WHERE d.id = p_device_id
  FOR SHARE OF d;
$function$;

REVOKE ALL
ON FUNCTION public.get_device_for_verification(UUID)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.get_device_for_verification(UUID)
TO gateway_runtime;