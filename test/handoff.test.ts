import assert from "node:assert/strict";
import { test } from "node:test";
import { noteFrom } from "../extensions/handoff.ts";

const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string, stopReason = "stop") => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});

test("takes the reply to the handoff request, not to a message typed meanwhile", () => {
  const entries = [user("Write a handoff note"), assistant("Let me check."), assistant("THE NOTE"), user("What's the date?"), assistant("Nov 7")];
  assert.equal(noteFrom(entries), "THE NOTE");
});

test("an aborted or failed reply gives no note", () => {
  assert.equal(noteFrom([user("Write a handoff note"), assistant("partial", "aborted")]), "");
});
