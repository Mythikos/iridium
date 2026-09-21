/** Confine the privileged fixture transport to the generated role-grant artifact's grammar. */
const GRANT_LINE =
  /^GRANT [A-Z_, `()a-z0-9]+ ON (?:\*\.\*|`iridium`\.\*|`iridium`\.`[a-z0-9_]+`) TO 'iridium_(?:app|migrator|backup)'@'%'(?: WITH GRANT OPTION)?;$/u;

/** Validate without rewriting any byte that will be passed to the shipped mysql client. */
export function assertDbaGrantScript(script: string): void {
  const statements = script
    .split(/\r?\n/u)
    .filter((line) => line !== '' && !line.startsWith('-- '));
  if (statements.length === 0 || statements.some((line) => !GRANT_LINE.test(line))) {
    throw new Error('Expected the unmodified generated Iridium DBA grant artifact.');
  }
}
