import { createPool, sql, DatabasePool } from 'slonik';
import { readFileSync } from 'fs';
import { join } from 'path';

const migrationScript = readFileSync(
  join(__dirname, '../../migrations/actions/2022.09.14T08.29.26.schema-registry-v2.sql'),
  'utf-8'
);

function migration(runner: (pool: DatabasePool) => Promise<() => Promise<void>>): () => Promise<void> {
  return async () => {
    const pool = await createPool('postgres://postgres:postgres@localhost:5432/poc');

    await pool.transaction(async t => {
      // clean up
      await t.query(sql`
        DROP TABLE IF EXIStS public.version_commit;
        DROP TABLE IF EXISTS public.versions;
        DROP TABLE IF EXISTS public.commits;
        DROP TABLE IF EXISTS public.targets;
        DROP TABLE IF EXISTS public.projects;
        DROP TYPE IF EXISTS commit_action;
        DROP TYPE IF EXISTS schema_change_criticality_level;
      `);

      // tables from `main` branch
      await t.query(sql`
        -- a slice of the original table
        CREATE TABLE public.projects (
          id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
          name text NOT NULL,
          type text NOT NULL,
          created_at timestamp with time zone NOT NULL DEFAULT NOW()
        );

        -- a slice of the original table
        CREATE TABLE public.targets (
          id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
          name text NOT NULL,
          created_at timestamp with time zone NOT NULL DEFAULT NOW(),
          project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE
        );

        CREATE TABLE public.commits (
          id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
          author text NOT NULL,
          created_at timestamp with time zone NOT NULL DEFAULT NOW(),
          service text,
          content text,
          commit text NOT NULL,
          target_id uuid NOT NULL REFERENCES public.targets(id) ON DELETE CASCADE,
          project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE
        );

        CREATE TABLE public.versions (
          id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
          created_at timestamp with time zone NOT NULL DEFAULT NOW(),
          valid boolean NOT NULL,
          target_id uuid NOT NULL REFERENCES public.targets(id) ON DELETE CASCADE,
          commit_id uuid NOT NULL REFERENCES public.commits(id) ON DELETE CASCADE
        );

        CREATE TABLE public.version_commit (
          version_id uuid NOT NULL REFERENCES public.versions(id) ON DELETE CASCADE,
          commit_id uuid NOT NULL REFERENCES public.commits(id) ON DELETE CASCADE,
          url text,
          PRIMARY KEY(version_id, commit_id)
        );
      `);
    });

    const after = await runner(pool);

    await pool.query({
      sql: migrationScript,
      type: 'SLONIK_TOKEN_SQL',
      values: [],
    });

    await after();
  };
}

test(
  'no obsolete columns',
  migration(async pool => {
    return async () => {
      // NO public.commits.service
      await expect(pool.query(sql`SELECT service FROM public.commits`)).rejects.toThrow(/"service" does not exist/);
      // NO public.commits.content
      await expect(pool.query(sql`SELECT content FROM public.commits`)).rejects.toThrow(/"content" does not exist/);
      // NO public.versions.valid
      await expect(pool.query(sql`SELECT valid FROM public.versions`)).rejects.toThrow(/"valid" does not exist/);
      // NO version_commit.url
      await expect(pool.query(sql`SELECT url FROM public.version_commit`)).rejects.toThrow(/"url" does not exist/);
    };
  })
);

test(
  'single projects',
  migration(async t => {
    // single
    const project = await t.one(
      sql`
        INSERT INTO public.projects
          (name, type)
        VALUES
          ('single-project', 'SINGLE')
        RETURNING *`
    );
    const target = await t.one(
      sql`
        INSERT INTO public.targets
          (name, project_id)
        VALUES
          ('single-target', ${project.id})
        RETURNING *
      `
    );

    const firstCommit = await t.one(
      sql`
        INSERT INTO public.commits
          (author, content, commit, target_id, project_id)
        VALUES
          ('single-author', 'single-sdl', 'single-init', ${target.id}, ${project.id})
        RETURNING *
      `
    );

    const firstVersion = await t.one(
      sql`
        INSERT INTO public.versions
          (valid, target_id, commit_id)
        VALUES
          (false, ${target.id}, ${firstCommit.id})
        RETURNING *
      `
    );
    await t.query(
      sql`
        INSERT INTO public.version_commit
          (version_id, commit_id)
        VALUES
          (${firstVersion.id}, ${firstCommit.id})
      `
    );

    const secondCommit = await t.one(
      sql`
        INSERT INTO public.commits
          (author, content, commit, target_id, project_id)
        VALUES
          ('single-author', 'single-sdl', 'single-second', ${target.id}, ${project.id})
        RETURNING *
      `
    );

    const secondVersion = await t.one(
      sql`
        INSERT INTO public.versions
          (valid, target_id, commit_id)
        VALUES
          (true, ${target.id}, ${secondCommit.id})
        RETURNING *
      `
    );

    await t.query(
      sql`
        INSERT INTO public.version_commit
          (version_id, commit_id)
        VALUES
          (${secondVersion.id}, ${secondCommit.id})
      `
    );

    return async () => {
      // Expect all commits to has N/A action
      await expect(
        t.many(
          sql`
            SELECT action
            FROM public.commits
            WHERE project_id = ${project.id}
          `
        )
      ).resolves.toEqual([
        {
          action: 'N/A',
        },
        {
          action: 'N/A',
        },
      ]);

      // Expect only the second version to be composable (just like it was before migration)
      await expect(
        t.many(
          sql`
            SELECT is_composable FROM public.versions WHERE target_id = ${target.id}
          `
        )
      ).resolves.toEqual([
        {
          is_composable: false,
        },
        {
          is_composable: true,
        },
      ]);

      // All commits should not have service_name and service_url set (just like before the migration)
      await expect(
        t.one(
          sql`
            SELECT count(*) as total
            FROM public.commits
            WHERE 
              target_id = ${target.id}
              AND service_name is null 
              AND service_url is null
          `
        )
      ).resolves.toEqual({
        total: 2,
      });
    };
  })
);

test(
  'custom projects',
  migration(async t => {
    const project = await t.one(
      sql`
        INSERT INTO public.projects
          (name, type)
        VALUES
          ('custom-project', 'CUSTOM')
        RETURNING *`
    );
    const target = await t.one(
      sql`
        INSERT INTO public.targets
          (name, project_id)
        VALUES
          ('custom-target', ${project.id})
        RETURNING *
      `
    );

    const firstCommit = await t.one(
      sql`
        INSERT INTO public.commits
          (author, content, commit, target_id, project_id)
        VALUES
          ('custom-author', 'custom-sdl', 'custom-init', ${target.id}, ${project.id})
        RETURNING *
      `
    );

    const firstVersion = await t.one(
      sql`
        INSERT INTO public.versions
          (valid, target_id, commit_id)
        VALUES
          (false, ${target.id}, ${firstCommit.id})
        RETURNING *
      `
    );
    await t.query(
      sql`
        INSERT INTO public.version_commit
          (version_id, commit_id)
        VALUES
          (${firstVersion.id}, ${firstCommit.id})
      `
    );

    const secondCommit = await t.one(
      sql`
        INSERT INTO public.commits
          (author, content, commit, target_id, project_id)
        VALUES
          ('custom-author', 'custom-sdl', 'custom-second', ${target.id}, ${project.id})
        RETURNING *
      `
    );

    const secondVersion = await t.one(
      sql`
        INSERT INTO public.versions
          (valid, target_id, commit_id)
        VALUES
          (true, ${target.id}, ${secondCommit.id})
        RETURNING *
      `
    );

    await t.query(
      sql`
        INSERT INTO public.version_commit
          (version_id, commit_id)
        VALUES
          (${secondVersion.id}, ${secondCommit.id})
      `
    );

    return async () => {
      // Expect all commits to has N/A action
      await expect(
        t.many(
          sql`
            SELECT action
            FROM public.commits
            WHERE project_id = ${project.id}
          `
        )
      ).resolves.toEqual([
        {
          action: 'N/A',
        },
        {
          action: 'N/A',
        },
      ]);

      // Expect only the second version to be composable (just like it was before migration)
      await expect(
        t.many(
          sql`
            SELECT is_composable FROM public.versions WHERE target_id = ${target.id}
          `
        )
      ).resolves.toEqual([
        {
          is_composable: false,
        },
        {
          is_composable: true,
        },
      ]);

      // All commits should not have service_name and service_url set (just like before the migration)
      await expect(
        t.one(
          sql`
            SELECT count(*) as total
            FROM public.commits
            WHERE 
              target_id = ${target.id}
              AND service_name is null 
              AND service_url is null
          `
        )
      ).resolves.toEqual({
        total: 2,
      });
    };
  })
);

test(
  'federation projects',
  migration(async t => {
    const project = await t.one(
      sql`
        INSERT INTO public.projects
          (name, type)
        VALUES
          ('fed-project', 'FEDERATION')
        RETURNING *
      `
    );
    const target = await t.one(sql`
      INSERT INTO public.targets
        (name, project_id)
      VALUES
        ('fed-target', ${project.id})
      RETURNING *
    `);

    const otherTarget = await t.one(sql`
      INSERT INTO public.targets
        (name, project_id)
      VALUES
        ('fed-target-second', ${project.id})
      RETURNING *
    `);

    const firstCommit = await t.one(sql`
      INSERT INTO public.commits
        (author, content, commit, service, target_id, project_id, created_at)
      VALUES
        ('fed-author', 'fed-sdl-reviews-first', 'fed-init', 'reviews', ${target.id}, ${project.id}, NOW() + INTERVAL '1 DAY')
      RETURNING *
    `);

    const firstVersion = await t.one(sql`
      INSERT INTO public.versions
        (valid, target_id, commit_id, created_at)
      VALUES
        (false, ${target.id}, ${firstCommit.id}, NOW() + INTERVAL '1 DAY')
      RETURNING *
    `);

    await t.query(sql`
      INSERT INTO public.version_commit
        (version_id, commit_id, url)
      VALUES
        (${firstVersion.id}, ${firstCommit.id}, 'fed-reviews-url-init')
    `);

    const firstCommitOfOtherTarget = await t.one(sql`
      INSERT INTO public.commits
        (author, content, commit, service, target_id, project_id, created_at)
      VALUES
        ('fed-author', 'fed-second-sdl-reviews-first', 'fed-init', 'reviews',  ${otherTarget.id}, ${project.id}, NOW() + INTERVAL '1 DAY')
      RETURNING *
    `);

    const firstVersionOfOtherTarget = await t.one(sql`
      INSERT INTO public.versions
        (valid, target_id, commit_id, created_at)
      VALUES
        (false, ${otherTarget.id}, ${firstCommitOfOtherTarget.id}, NOW() + INTERVAL '1 DAY')
      RETURNING *
    `);

    await t.query(sql`
      INSERT INTO public.version_commit
        (version_id, commit_id, url)
      VALUES
        (${firstVersionOfOtherTarget.id}, ${firstCommitOfOtherTarget.id}, 'fed-second-reviews-url-init')
    `);

    const secondCommit = await t.one(sql`
      INSERT INTO public.commits
        (author, content, commit, service, target_id, project_id, created_at)
      VALUES
      ('fed-author', 'fed-sdl-reviews-second', 'fed-second', 'reviews', ${target.id}, ${project.id}, NOW() + INTERVAL '2 DAY')
      RETURNING *
    `);

    const secondVersion = await t.one(sql`
      INSERT INTO public.versions
        (valid, target_id, commit_id, created_at)
      VALUES
        (true, ${target.id}, ${secondCommit.id}, NOW() + INTERVAL '2 DAY')
      RETURNING *
    `);

    await t.query(sql`
      INSERT INTO public.version_commit
        (version_id, commit_id, url)
      VALUES
        (${secondVersion.id}, ${secondCommit.id}, 'fed-reviews-url-second')
    `);

    const thirdCommit = await t.one(sql`
      INSERT INTO public.commits
        (author, content, commit, service, target_id, project_id, created_at)
      VALUES
        ('fed-author', 'fed-sdl-products-first', 'fed-third', 'products', ${target.id}, ${project.id}, NOW() + INTERVAL '3 DAY')
      RETURNING *
    `);

    const thirdVersion = await t.one(sql`
      INSERT INTO public.versions
        (valid, target_id, commit_id, created_at)
      VALUES
        (true, ${target.id}, ${thirdCommit.id}, NOW() + INTERVAL '3 DAY')
      RETURNING *
    `);

    await t.query(sql`
      INSERT INTO public.version_commit (version_id, commit_id, url)
      VALUES
        (${thirdVersion.id}, ${thirdCommit.id}, 'fed-products-url-init'),
        (${thirdVersion.id}, ${secondCommit.id}, 'fed-reviews-url-second')
    `);

    return async () => {
      // Expect only the commits from the first target in the same order as before migration
      // and with the same service_name and service_url, composability and with correct actions
      await expect(
        t.many(
          sql`
            SELECT c.action, c.service_url, c.service_name, v.is_composable, c.sdl
            FROM public.versions v
            LEFT JOIN public.commits c ON c.id = v.commit_id
            WHERE c.target_id = ${target.id} ORDER BY v.created_at ASC
          `
        )
      ).resolves.toEqual([
        {
          action: 'ADD',
          service_url: 'fed-reviews-url-init',
          service_name: 'reviews',
          is_composable: false,
          sdl: 'fed-sdl-reviews-first',
        },
        {
          action: 'MODIFY',
          service_url: 'fed-reviews-url-second',
          service_name: 'reviews',
          is_composable: true,
          sdl: 'fed-sdl-reviews-second',
        },
        {
          action: 'ADD',
          service_url: 'fed-products-url-init',
          service_name: 'products',
          is_composable: true,
          sdl: 'fed-sdl-products-first',
        },
      ]);

      // Expect the other target to has its own commits in the same order as before migration
      await expect(
        t.many(
          sql`
            SELECT c.action, c.service_url, c.service_name, v.is_composable, c.sdl
            FROM public.versions v
            LEFT JOIN public.commits c ON c.id = v.commit_id
            WHERE c.target_id = ${otherTarget.id} ORDER BY v.created_at ASC
          `
        )
      ).resolves.toEqual([
        {
          action: 'ADD',
          service_url: 'fed-second-reviews-url-init',
          service_name: 'reviews',
          is_composable: false,
          sdl: 'fed-second-sdl-reviews-first',
        },
      ]);
    };
  })
);

test(
  'stitching projects',
  migration(async t => {
    const project = await t.one(
      sql`
        INSERT INTO public.projects
          (name, type)
        VALUES
          ('st-project', 'STITCHING')
        RETURNING *
      `
    );
    const target = await t.one(sql`
      INSERT INTO public.targets
        (name, project_id)
      VALUES
        ('st-target', ${project.id})
      RETURNING *
    `);

    const otherTarget = await t.one(sql`
      INSERT INTO public.targets
        (name, project_id)
      VALUES
        ('st-target-second', ${project.id})
      RETURNING *
    `);

    const firstCommit = await t.one(sql`
      INSERT INTO public.commits
        (author, content, commit, service, target_id, project_id, created_at)
      VALUES
        ('st-author', 'st-sdl-reviews-first', 'st-init', 'reviews', ${target.id}, ${project.id}, NOW() + INTERVAL '1 DAY')
      RETURNING *
    `);

    const firstVersion = await t.one(sql`
      INSERT INTO public.versions
        (valid, target_id, commit_id, created_at)
      VALUES
        (false, ${target.id}, ${firstCommit.id}, NOW() + INTERVAL '1 DAY')
      RETURNING *
    `);

    await t.query(sql`
      INSERT INTO public.version_commit
        (version_id, commit_id, url)
      VALUES
        (${firstVersion.id}, ${firstCommit.id}, 'st-reviews-url-init')
    `);

    const firstCommitOfOtherTarget = await t.one(sql`
      INSERT INTO public.commits
        (author, content, commit, service, target_id, project_id, created_at)
      VALUES
        ('st-author', 'st-second-sdl-reviews-first', 'st-init', 'reviews',  ${otherTarget.id}, ${project.id}, NOW() + INTERVAL '1 DAY')
      RETURNING *
    `);

    const firstVersionOfOtherTarget = await t.one(sql`
      INSERT INTO public.versions
        (valid, target_id, commit_id, created_at)
      VALUES
        (false, ${otherTarget.id}, ${firstCommitOfOtherTarget.id}, NOW() + INTERVAL '1 DAY')
      RETURNING *
    `);

    await t.query(sql`
      INSERT INTO public.version_commit
        (version_id, commit_id, url)
      VALUES
        (${firstVersionOfOtherTarget.id}, ${firstCommitOfOtherTarget.id}, 'st-second-reviews-url-init')
    `);

    const secondCommit = await t.one(sql`
      INSERT INTO public.commits
        (author, content, commit, service, target_id, project_id, created_at)
      VALUES
      ('st-author', 'st-sdl-reviews-second', 'st-second', 'reviews', ${target.id}, ${project.id}, NOW() + INTERVAL '2 DAY')
      RETURNING *
    `);

    const secondVersion = await t.one(sql`
      INSERT INTO public.versions
        (valid, target_id, commit_id, created_at)
      VALUES
        (true, ${target.id}, ${secondCommit.id}, NOW() + INTERVAL '2 DAY')
      RETURNING *
    `);

    await t.query(sql`
      INSERT INTO public.version_commit
        (version_id, commit_id, url)
      VALUES
        (${secondVersion.id}, ${secondCommit.id}, 'st-reviews-url-second')
    `);

    const thirdCommit = await t.one(sql`
      INSERT INTO public.commits
        (author, content, commit, service, target_id, project_id, created_at)
      VALUES
        ('st-author', 'st-sdl-products-first', 'st-third', 'products', ${target.id}, ${project.id}, NOW() + INTERVAL '3 DAY')
      RETURNING *
    `);

    const thirdVersion = await t.one(sql`
      INSERT INTO public.versions
        (valid, target_id, commit_id, created_at)
      VALUES
        (true, ${target.id}, ${thirdCommit.id}, NOW() + INTERVAL '3 DAY')
      RETURNING *
    `);

    await t.query(sql`
      INSERT INTO public.version_commit (version_id, commit_id, url)
      VALUES
        (${thirdVersion.id}, ${thirdCommit.id}, 'st-products-url-init'),
        (${thirdVersion.id}, ${secondCommit.id}, 'st-reviews-url-second')
    `);

    return async () => {
      // Expect only the commits from the first target in the same order as before migration
      // and with the same service_name and service_url, composability and with correct actions
      await expect(
        t.many(
          sql`
            SELECT c.action, c.service_url, c.service_name, v.is_composable, c.sdl
            FROM public.versions v
            LEFT JOIN public.commits c ON c.id = v.commit_id
            WHERE c.target_id = ${target.id} ORDER BY v.created_at ASC
          `
        )
      ).resolves.toEqual([
        {
          action: 'ADD',
          service_url: 'st-reviews-url-init',
          service_name: 'reviews',
          is_composable: false,
          sdl: 'st-sdl-reviews-first',
        },
        {
          action: 'MODIFY',
          service_url: 'st-reviews-url-second',
          service_name: 'reviews',
          is_composable: true,
          sdl: 'st-sdl-reviews-second',
        },
        {
          action: 'ADD',
          service_url: 'st-products-url-init',
          service_name: 'products',
          is_composable: true,
          sdl: 'st-sdl-products-first',
        },
      ]);

      // Expect the other target to has its own commits in the same order as before migration
      await expect(
        t.many(
          sql`
            SELECT c.action, c.service_url, c.service_name, v.is_composable, c.sdl
            FROM public.versions v
            LEFT JOIN public.commits c ON c.id = v.commit_id
            WHERE c.target_id = ${otherTarget.id} ORDER BY v.created_at ASC
          `
        )
      ).resolves.toEqual([
        {
          action: 'ADD',
          service_url: 'st-second-reviews-url-init',
          service_name: 'reviews',
          is_composable: false,
          sdl: 'st-second-sdl-reviews-first',
        },
      ]);
    };
  })
);
