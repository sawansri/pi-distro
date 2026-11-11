/**
 * The shell-command scanner shared by plan mode and the destructive-operation
 * guard.
 *
 * Both need the same thing before they can judge anything: the command split
 * into the stages a shell would actually run, with quoting understood, because
 * `rm -rf x` is dangerous and `echo "rm -rf x"` is not, and `a; b` is two
 * commands, not one.
 *
 * This is deliberately a *model*, not a shell: anything it cannot parse (a
 * backslash outside single quotes, `$'...'`, command or process substitution)
 * is reported as unparseable so callers can fail closed. It is not a security
 * boundary on its own — see the guard for why that matters.
 */

/**
 * The command with the inside of every quoted string blanked out (quotes and
 * positions kept), so operators inside quotes are not mistaken for syntax.
 * Undefined when the command uses something this scanner does not model.
 */
export function maskQuotes(command: string): string | undefined {
  let masked = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      masked += c === "'" ? c : " ";
      if (c === "'") quote = undefined;
      continue;
    }
    if (c === "\\" || c === "`" || (c === "$" && (command[i + 1] === "(" || (!quote && command[i + 1] === "'")))) return undefined;
    if (quote === '"') {
      masked += c === '"' ? c : " ";
      if (c === '"') quote = undefined;
      continue;
    }
    if ((c === "<" || c === ">") && command[i + 1] === "(") return undefined;
    if (c === "'" || c === '"') quote = c;
    masked += c;
  }
  return quote ? undefined : masked;
}

/** Splits a command into words as the shell does, removing quotes: `-"de"lete` is `-delete`. */
export const words = (command: string): string[] =>
  (command.match(/(?:'[^']*'|"[^"]*"|[^\s'"])+/g) ?? []).map((word) => word.replace(/'([^']*)'|"([^"]*)"/g, "$1$2"));

/** A redirection that writes nowhere, so it can be struck out before looking for `>`. */
const harmlessRedirects = (text: string) => text.replace(/\d*>&\d+|\d*>\s*\/dev\/null|&>\s*\/dev\/null/g, (m) => " ".repeat(m.length));

export interface Stage {
  /** The stage exactly as written, quotes included. */
  text: string;
  /** The same stage with the inside of quoted strings blanked out. */
  masked: string;
  /** Words with quotes removed: `["rm", "-rf", "/tmp/x"]`. */
  words: string[];
  /**
   * Environment assignments before the command name, e.g. `FOO=bar rm`.
   * `FOO=bar` is a different command from `rm`, and a reader like
   * `GIT_EXTERNAL_DIFF=… git diff` runs a program.
   */
  env: string[];
  /** The command name, or undefined for an empty stage. */
  name?: string;
  /** Arguments after the command name. */
  args: string[];
}

/**
 * Splits a command into the stages a shell would run, or undefined when it
 * cannot be modelled. Compound commands are split on `&&`, `||`, `;`, `|`,
 * `|&`, `&` and newlines, in the masked text but sliced from the original, so a
 * quoted operator does not split and a stage keeps its real quoting.
 */
export function stages(command: string): Stage[] | undefined {
  const quoted = maskQuotes(command);
  if (quoted === undefined) return undefined;
  const masked = harmlessRedirects(quoted);
  const original = harmlessRedirects(command);
  const out: Stage[] = [];
  let from = 0;
  const push = (end: number) => {
    const text = original.slice(from, end);
    const start = from;
    from = end;
    const mask = masked.slice(start, end);
    const all = words(text);
    const env: string[] = [];
    let i = 0;
    while (i < all.length && /^\w+=/.test(all[i])) env.push(all[i++]);
    out.push({ text: text.trim(), masked: mask, words: all, env, name: all[i], args: all.slice(i + 1) });
  };
  for (const separator of masked.matchAll(/&&|\|\||[;|&\n]/g)) {
    push(separator.index!);
    from = separator.index! + separator[0].length;
  }
  push(command.length);
  return out.filter((stage) => stage.text !== "");
}

/**
 * Whether a masked command redirects into a file.
 *
 * Any `>` that survives blanking the harmless forms is a write, including
 * `1>b`: the fd number before it does not make the target less real.
 */
export const writesFile = (masked: string): boolean => />/.test(harmlessRedirects(masked));
