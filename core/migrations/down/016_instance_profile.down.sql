-- Recusa quando o banco já foi preso a um perfil: a volta nunca apaga o vínculo que impede misturar ensaio e produção.
LOCK TABLE instance_profile IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM instance_profile) THEN
    RAISE EXCEPTION 'database profile is claimed; refusing to drop it';
  END IF;
END;
$$;
DROP TABLE IF EXISTS instance_profile;
DROP FUNCTION IF EXISTS instance_profile_immutable();
