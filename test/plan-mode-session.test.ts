import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import planMode from "../extensions/plan-mode.ts";

/** Loads the extension against a fake pi and returns its handlers. */
function load() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, { handler: (args: string, ctx: any) => any }> = {};
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const pi = {
    on: (name: string, fn: any) => (handlers[name] = fn),
    registerCommand: (name: string, options: any) => (commands[name] = options),
    registerShortcut: () => {},
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  planMode(pi as any);
  return { handlers, commands, entries };
}

const ctx = (branch: unknown[] = []) => ({
  isIdle: () => true,
  hasUI: true,
  ui: { setStatus: () => {}, notify: () => {} },
  sessionManager: { getBranch: () => branch },
});

const blocksWrite = (handlers: Record<string, (...args: any[]) => any>) =>
  handlers.tool_call({ toolName: "write", input: { path: "a", content: "b" } })?.block === true;

afterEach(() => {
  delete process.env.PI_DISTRO_PLAN_MODE;
  delete process.env.PI_SUBAGENT_DEPTH;
});

test("a new session in the same process doesn't inherit the old session's plan mode", async () => {
  const first = load();
  first.handlers.session_start({}, ctx());
  await first.commands.plan.handler("", ctx());
  assert.equal(blocksWrite(first.handlers), true);
  first.handlers.session_shutdown?.({}, ctx());

  // /new reloads the extension in the same process.
  const second = load();
  second.handlers.session_start({}, ctx());
  assert.equal(blocksWrite(second.handlers), false);
});

test("a subagent started while planning is read-only", () => {
  process.env.PI_DISTRO_PLAN_MODE = "1";
  process.env.PI_SUBAGENT_DEPTH = "1";
  const child = load();
  child.handlers.session_start({}, ctx());
  assert.equal(blocksWrite(child.handlers), true);
});
