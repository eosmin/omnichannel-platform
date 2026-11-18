import { definerViolations } from './definer-search-path'

const check = (sql: string): string[] => definerViolations([{ name: 'm', sql }])

describe('definerViolations', () => {
  it('refuses a SECURITY DEFINER function with no search_path of its own', () => {
    const problems = check(
      `CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;`
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('no SET search_path')
  })

  it('refuses a search_path without pg_temp, and one where pg_temp is not the last', () => {
    expect(
      check(
        `CREATE FUNCTION f(a text) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT 1 FROM media $$;`
      )[0]
    ).toContain('pg_temp must be the last')
    expect(
      check(
        `CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_temp, public AS $$ SELECT 1 $$;`
      )[0]
    ).toContain('pg_temp must be the last')
  })

  it('accepts public, pg_temp and pg_catalog, pg_temp (every table with its schema)', () => {
    expect(
      check(`CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$ BEGIN UPDATE finance_settings SET x = 1; END $$;`)
    ).toEqual([])
    expect(
      check(`CREATE FUNCTION g() RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s' AS $$
BEGIN
  WITH gone AS (DELETE FROM public.audit_logs WHERE id = 'x' RETURNING id)
  SELECT count(*) FROM gone;
  INSERT INTO public.audit_logs (id) VALUES ('y');
  RETURN 1;
END $$;`)
    ).toEqual([])
  })

  it('refuses a body with an unqualified table when public is not in the search_path', () => {
    const problems =
      check(`CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN DELETE FROM audit_logs WHERE true; INSERT INTO media (id) VALUES ('a'); RETURN 1; END $$;`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('audit_logs, media')
  })

  it('ignores a function that is not SECURITY DEFINER, a mention in a comment and OR REPLACE', () => {
    expect(check(`CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`)).toEqual([])
    expect(
      check(
        `-- a SECURITY DEFINER function without search_path\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`
      )
    ).toEqual([])
    expect(
      check(
        `CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;`
      )
    ).toHaveLength(1)
  })

  it('refuses a function made SECURITY DEFINER afterwards', () => {
    const problems = check(
      `CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nALTER FUNCTION f() SECURITY DEFINER;`
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('after it was created')
  })

  it('reads SET search_path TO, and a body in quotes, and refuses what it cannot read', () => {
    expect(
      check(
        `CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path TO pg_catalog, pg_temp AS 'SELECT 1';`
      )
    ).toEqual([])
    expect(
      check(
        `CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public AS 'SELECT 1';`
      )[0]
    ).toContain('pg_temp must be the last')
    // A CREATE FUNCTION inside a string of a DO block is read like any other, and refused for the same reason
    expect(
      check(
        `DO $$ BEGIN EXECUTE 'CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $x$ SELECT 1 $x$'; END $$;`
      )[0]
    ).toContain('no SET search_path')
    // And a SECURITY DEFINER that no header accounts for is refused because the check cannot tell whether it is safe
    const unread = check(`DO $$ BEGIN EXECUTE format('%s', 'x SECURITY DEFINER'); END $$;`)
    expect(unread).toHaveLength(1)
    expect(unread[0]).toContain('could not read')
  })

  it('judges each function of a file on its own', () => {
    const problems =
      check(`CREATE FUNCTION a() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT 1 $$;
CREATE FUNCTION b() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT 1 $$;`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(' b ')
  })
})
