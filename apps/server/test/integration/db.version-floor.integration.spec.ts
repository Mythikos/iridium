/**
 * `db.version-floor.integration` (12-milestones.md section 4.6, 10-testing-and-quality.md "Ops",
 * 11-operations-and-deployment.md OPS-62).
 *
 * Two required deployment targets are a promise about which engines are tested, and a promise nobody
 * checks is a preference. This file boots the database layer against servers that really are the
 * refused versions -- MySQL 8.0.46, the last release of a line that reached end of life on
 * 2026-04-30, and an innovation release -- and asserts the refusal: `config.mysql_unsupported`, exit
 * `2`, and the end-of-life date in the message, because "unsupported" without a date is a message an
 * operator argues with.
 *
 * The row also names the `/readyz` half: `IRIDIUM_ALLOW_UNTESTED_MYSQL=true` must downgrade the
 * refusal to a boot warning **plus a permanent `/readyz` `mysql_version: warn`**. The half this file
 * can own is asserted here -- the layer resolves, the returned version keeps its real verdict so the
 * check has something to report, and a `WARN` naming the override is logged. The `/readyz` assertion
 * belongs with the `ops` plugin that registers that check and is added to this file when it lands.
 *
 * The classification itself is also asserted without a container, over every boundary the two lines
 * have: a construct of this kind is cheap to get subtly wrong at a patch boundary, and a table test
 * is the only way to cover 8.4.10 against 8.4.11.
 *
 * Every case here connects with the **migrator** URL, and that is not a convenience. On a database
 * that has not been migrated yet, `iridium_app` holds `USAGE ON *.*` and nothing else -- its
 * per-table rights arrive with migration `0034_grants` -- so MySQL refuses the connection itself
 * ("Access denied ... to database 'iridium'") before any version check could run. The first
 * connection an Iridium process makes to a fresh deployment is therefore the migrator's, which is
 * exactly where this refusal has to bite, and none of these servers is ever migrated: the point is
 * that the process stops at the version, before it touches the schema.
 */
import { afterAll, describe, expect, it } from 'vitest';

import {
  createDatabaseLayer,
  describeMysqlVersion,
  MysqlUnsupportedError,
  MYSQL_80_END_OF_LIFE,
  parseMysqlVersion,
  type DbLogger,
} from '../../src/db/index.ts';
import {
  DEFAULT_MYSQL_IMAGE,
  REFERENCE_MYSQL_IMAGE,
  selectedMysqlImage,
  startIridiumMysql,
  type IridiumMysql,
} from '../db-mysql-container.ts';

/**
 * One container per image, started on first use and shared by every case that needs that image.
 * Memoised rather than started in `beforeAll` because the root Vitest configuration shuffles test
 * order (`sequence.shuffle`), so no case may depend on another having run first.
 */
const containers = new Map<string, Promise<IridiumMysql>>();

function mysqlFor(image: string): Promise<IridiumMysql> {
  const existing = containers.get(image);
  if (existing !== undefined) return existing;
  const starting = startIridiumMysql({ image });
  containers.set(image, starting);
  return starting;
}

/** The end-of-life 8.0 line, named by its last release. */
const END_OF_LIFE_IMAGE = process.env['IRIDIUM_MYSQL_EOL_IMAGE'] ?? 'mysql:8.0.46';

/** A current innovation release: supported only until the next one appears, so never a target. */
const INNOVATION_IMAGE = process.env['IRIDIUM_MYSQL_INNOVATION_IMAGE'] ?? 'mysql:26.7';

interface LogLine {
  readonly level: 'info' | 'warn';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

/** Narrows a rejection to the refusal, with a message that says what arrived instead. */
function asMysqlUnsupported(error: unknown): MysqlUnsupportedError {
  if (error instanceof MysqlUnsupportedError) return error;
  const detail = error instanceof Error ? error.message : 'a value that is not an Error';
  throw new Error(`expected the db layer to refuse with MysqlUnsupportedError, received ${detail}`);
}

/** The classification of one `SELECT VERSION()` string. */
function verdictOf(raw: string): string {
  return parseMysqlVersion(raw).verdict;
}

function recordingLogger(): { logger: DbLogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    logger: {
      info: (fields, message) => lines.push({ level: 'info', fields, message }),
      warn: (fields, message) => lines.push({ level: 'warn', fields, message }),
    },
  };
}

describe('db.version-floor.integration [area:ops]', () => {
  afterAll(async () => {
    const running = await Promise.all(
      [...containers.values()].map(async (starting) => starting.catch(() => null)),
    );
    await Promise.all(running.map(async (mysql) => mysql?.stop()));
    containers.clear();
  }, 300_000);

  it('classifies every boundary of the two required lines', () => {
    expect(verdictOf('8.4.11')).toBe('supported');
    expect(verdictOf('8.4.12')).toBe('supported');
    expect(verdictOf('9.7.2')).toBe('supported');
    expect(verdictOf('9.7.3-oraclelinux9')).toBe('supported');

    expect(verdictOf('8.4.10')).toBe('below_line_floor');
    expect(verdictOf('9.7.1')).toBe('below_line_floor');

    expect(verdictOf('8.0.46')).toBe('end_of_life');
    expect(verdictOf('5.7.44')).toBe('end_of_life');

    expect(verdictOf('9.0.1')).toBe('innovation_release');
    expect(verdictOf('9.6.0')).toBe('innovation_release');
    expect(verdictOf('26.7.0')).toBe('innovation_release');

    expect(verdictOf('not-a-version')).toBe('unparsable');
  });

  it('names the end-of-life date for a refused 8.0 and the support model for an innovation release', () => {
    const eol = describeMysqlVersion(parseMysqlVersion('8.0.46'));
    expect(eol).toContain(MYSQL_80_END_OF_LIFE);
    expect(eol).toContain('8.0.46');
    expect(eol).toContain('8.4.11');
    expect(eol).toContain('9.7.2');

    const innovation = describeMysqlVersion(parseMysqlVersion('26.7.0'));
    expect(innovation).toContain('innovation release');
    expect(innovation).toContain('three months');
  });

  it(`boots clean against the selected required image (${selectedMysqlImage()})`, async () => {
    const mysql = await mysqlFor(selectedMysqlImage());
    const { logger, lines } = recordingLogger();
    const layer = await createDatabaseLayer({ url: mysql.migratorUrl(), logger });
    try {
      expect(layer.serverVersion.verdict).toBe('supported');
      expect([DEFAULT_MYSQL_IMAGE, REFERENCE_MYSQL_IMAGE]).toContain(mysql.image);
      expect(lines.filter((l) => l.level === 'warn')).toEqual([]);
    } finally {
      await layer.destroy();
    }
  }, 600_000);

  it('refuses MySQL 8.0 with config.mysql_unsupported, exit 2 and the end-of-life date', async () => {
    const mysql = await mysqlFor(END_OF_LIFE_IMAGE);
    const error = await createDatabaseLayer({ url: mysql.migratorUrl() }).then(
      async (layer) => {
        await layer.destroy();
        return null;
      },
      (reason: unknown) => reason,
    );

    const refusal = asMysqlUnsupported(error);
    expect(refusal.code).toBe('config.mysql_unsupported');
    expect(refusal.exitCode).toBe(2);
    expect(refusal.version.verdict).toBe('end_of_life');
    expect(refusal.version.raw).toMatch(/^8\.0\./);
    expect(refusal.message).toContain(MYSQL_80_END_OF_LIFE);
  }, 600_000);

  it('refuses an innovation release with config.mysql_unsupported and exit 2', async () => {
    const mysql = await mysqlFor(INNOVATION_IMAGE);
    const error = await createDatabaseLayer({ url: mysql.migratorUrl() }).then(
      async (layer) => {
        await layer.destroy();
        return null;
      },
      (reason: unknown) => reason,
    );

    const refusal = asMysqlUnsupported(error);
    expect(refusal.code).toBe('config.mysql_unsupported');
    expect(refusal.exitCode).toBe(2);
    expect(refusal.version.verdict).toBe('innovation_release');
    expect(refusal.message).toContain('innovation release');
  }, 600_000);

  it('downgrades the refusal to a permanent warning under IRIDIUM_ALLOW_UNTESTED_MYSQL', async () => {
    // The same end-of-life server the refusal case uses, so the override is proven against a server
    // that really is refused rather than against a stubbed version string.
    const mysql = await mysqlFor(END_OF_LIFE_IMAGE);
    const { logger, lines } = recordingLogger();
    const layer = await createDatabaseLayer({
      url: mysql.migratorUrl(),
      allowUntestedMysql: true,
      logger,
    });
    try {
      // The verdict is kept, not rewritten: it is what the /readyz `mysql_version` check reports as
      // a permanent `warn`, naming the version, rather than a silent success.
      expect(layer.serverVersion.verdict).toBe('end_of_life');
      expect(layer.serverVersion.raw).toMatch(/^8\.0\./);

      const warnings = lines.filter((l) => l.level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.fields['code']).toBe('config.mysql_unsupported');
      expect(warnings[0]?.fields['override']).toBe('IRIDIUM_ALLOW_UNTESTED_MYSQL');
      expect(warnings[0]?.fields['mysqlVersion']).toBe(layer.serverVersion.raw);
      expect(warnings[0]?.message).toContain('unsupported');
    } finally {
      await layer.destroy();
    }
  }, 600_000);
});
