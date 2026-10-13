-- Migration 017: Change round timing from 30 seconds to 15 seconds for all games.
-- Updates the 5 get_current_round functions to create 15-second rounds.

DO $$
DECLARE
  func_def text;
  func_names text[] := array[
    'get_current_round',
    'cf_get_current_round',
    'dt_get_current_round',
    'ab_get_current_round',
    'roulette_get_current_round'
  ];
  fname text;
BEGIN
  FOREACH fname IN ARRAY func_names LOOP
    SELECT pg_get_functiondef(p.oid) INTO func_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = fname AND n.nspname = 'public';
    
    IF func_def IS NOT NULL THEN
      func_def := replace(func_def, '30 seconds', '15 seconds');
      EXECUTE func_def;
      RAISE NOTICE 'Updated % to 15 seconds', fname;
    ELSE
      RAISE WARNING 'Function % not found', fname;
    END IF;
  END LOOP;
END $$;
