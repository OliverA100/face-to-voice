import { describe, expect, it } from "vitest";

import { agentEnd } from "../session";

describe("why the agent ended the chat", () => {
  it("passes on the reasons the agent gives, \"error\" included, and reads anything else as a dropped connection", () => {
    for (const reason of ["time_up", "idle", "voice_error", "error", "left"]) expect(agentEnd(reason)).toBe(reason);
    expect(agentEnd("something new")).toBe("disconnected");
  });
});
