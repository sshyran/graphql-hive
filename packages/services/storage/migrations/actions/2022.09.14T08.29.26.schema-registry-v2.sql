CREATE TYPE commit_action AS ENUM ('ADD', 'MODIFY', 'DELETE', 'N/A');
CREATE TYPE schema_change_criticality_level AS ENUM ('SAFE', 'DANGEROUS', 'BREAKING');

ALTER TABLE public.commits
  ADD COLUMN service_url text,
  RENAME COLUMN service TO service_name,
  RENAME COLUMN content TO sdl,
  ADD COLUMN action commit_action;

ALTER TABLE public.versions
  RENAME COLUMN valid TO is_composable;

ALTER TABLE public.projects
  ADD COLUMN legacy_registry_model boolean NOT NULL DEFAULT FALSE;

-- migrate the state

-- Set `projects.legacy_registry_model` to `FALSE` for all projects
UPDATE public.projects SET legacy_registry_model = TRUE WHERE type = 'FEDERATION' OR type = 'STITCHING';

-- [ ] move `version_commit.url` to `commits.service_url`
-- [ ] check if `commit.id` belongs to a single `version.id`
-- UPDATE public.projects SET legacy_registry_model = TRUE WHERE type = 'FEDERATION' OR type = 'STITCHING';

-- [ ] set `N/A` for single/custom projects
UPDATE public.commits SET action = 'N/A' WHERE project_id IN (SELECT id WHERE WHERE type = 'SINGLE' OR type = 'CUSTOM');

-- [ ] set `ADD` for stitching/federation projects

-- [ ] set `MODIFY` for stitching/federation projects


ALTER TABLE public.version_commit
  DROP COLUMN url;

ALTER TABLE public.commits ALTER COLUMN action SET NOT NULL;
