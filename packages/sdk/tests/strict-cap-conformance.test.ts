import fixtures from "./fixtures/strict-cap-v1.json";
import { matchStrictCaps, type StrictCapEntry } from "../src/enforcement";

describe("strict cap protocol v4 conformance", () => {
  it("keeps the strict cap fixture on protocol version 4", () => {
    expect(fixtures.protocolVersion).toBe(4);
  });

  it.each(fixtures.cases)("$name", (fixture) => {
    const caps = fixture.caps as StrictCapEntry[];
    const original = JSON.stringify(caps);
    expect(matchStrictCaps(fixture.request, caps)).toEqual(fixture.expected);
    expect(JSON.stringify(caps)).toBe(original);
  });
});
