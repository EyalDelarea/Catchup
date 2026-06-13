import { describe, expect, it } from "vitest";
import {
  addJob, createJobStore, findJob, markAllRead, markRead, markScopeRead,
  readyNewestFirst, settleJob, unreadCount, workingForScope,
} from "./ask-jobs.js";

const ready = (store, id, over = {}) =>
  settleJob(store, id, { status: "ready", answer: "a", citations: [], read: false, ...over });

describe("ask-jobs store", () => {
  it("adds a working job born read (never inflates the badge)", () => {
    const s = createJobStore();
    const j = addJob(s, { id: "ask1", q: "מה דחוף?", scope: null, ts: 1 });
    expect(j).toMatchObject({ id: "ask1", scope: null, status: "working", read: true });
    expect(unreadCount(s)).toBe(0);
  });

  it("normalizes undefined scope to null and matches workingForScope", () => {
    const s = createJobStore();
    addJob(s, { id: "ask1", q: "x", scope: undefined, ts: 1 });
    expect(workingForScope(s, null)).toBe(true);
    expect(workingForScope(s, "דנה כהן")).toBe(false);
  });

  it("settleJob → ready sets answer/citations/read and counts as unread when read:false", () => {
    const s = createJobStore();
    addJob(s, { id: "ask1", q: "x", scope: null, ts: 1 });
    ready(s, "ask1", { answer: "תשובה", citations: [{ n: 1 }] });
    const j = findJob(s, "ask1");
    expect(j).toMatchObject({ status: "ready", answer: "תשובה", read: false });
    expect(j.citations).toHaveLength(1);
    expect(unreadCount(s)).toBe(1);
  });

  it("unreadCount ignores working and error jobs, counts across scopes", () => {
    const s = createJobStore();
    addJob(s, { id: "a", q: "x", scope: "דנה כהן", ts: 1 });
    addJob(s, { id: "b", q: "y", scope: null, ts: 2 });
    addJob(s, { id: "c", q: "z", scope: null, ts: 3 });
    ready(s, "a"); ready(s, "b");
    settleJob(s, "c", { status: "error", read: false });
    expect(unreadCount(s)).toBe(2); // a + b; c is error, none still working
  });

  it("readyNewestFirst returns ready jobs reverse-chronological", () => {
    const s = createJobStore();
    addJob(s, { id: "a", q: "1", scope: null, ts: 1 });
    addJob(s, { id: "b", q: "2", scope: null, ts: 2 });
    addJob(s, { id: "c", q: "3", scope: null, ts: 3 }); // still working
    ready(s, "a"); ready(s, "b");
    expect(readyNewestFirst(s).map((j) => j.id)).toEqual(["b", "a"]);
  });

  it("markRead / markScopeRead / markAllRead clear unread the right way", () => {
    const s = createJobStore();
    addJob(s, { id: "a", q: "1", scope: "דנה כהן", ts: 1 });
    addJob(s, { id: "b", q: "2", scope: null, ts: 2 });
    ready(s, "a"); ready(s, "b");
    markRead(s, "a");
    expect(unreadCount(s)).toBe(1);
    markScopeRead(s, null);
    expect(unreadCount(s)).toBe(0);
    settleJob(s, "a", { read: false });
    markAllRead(s);
    expect(unreadCount(s)).toBe(0);
  });

  it("settleJob/findJob return null for an unknown id", () => {
    const s = createJobStore();
    expect(settleJob(s, "nope", { status: "ready" })).toBeNull();
    expect(findJob(s, "nope")).toBeNull();
  });
});
