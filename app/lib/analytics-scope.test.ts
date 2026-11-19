import { describe, it, expect } from "vitest";
import { UserRole } from "~/db/schema";
import { resolveAnalyticsScope } from "./analytics-scope";

describe("resolveAnalyticsScope", () => {
  it.each([
    {
      case: "admin with no instructor requested sees the platform",
      viewer: { id: 1, role: UserRole.Admin },
      requested: null,
      expected: { kind: "platform" },
    },
    {
      case: "admin with an instructor requested sees that instructor",
      viewer: { id: 1, role: UserRole.Admin },
      requested: 7,
      expected: { kind: "instructor", id: 7 },
    },
    {
      case: "instructor with nothing requested sees themselves",
      viewer: { id: 5, role: UserRole.Instructor },
      requested: null,
      expected: { kind: "instructor", id: 5 },
    },
    {
      case: "instructor requesting another instructor still sees themselves",
      viewer: { id: 5, role: UserRole.Instructor },
      requested: 7,
      expected: { kind: "instructor", id: 5 },
    },
    {
      case: "student is forbidden",
      viewer: { id: 9, role: UserRole.Student },
      requested: null,
      expected: "forbidden",
    },
    {
      case: "student requesting an instructor is still forbidden",
      viewer: { id: 9, role: UserRole.Student },
      requested: 7,
      expected: "forbidden",
    },
  ])("$case", ({ viewer, requested, expected }) => {
    expect(resolveAnalyticsScope(viewer, requested)).toEqual(expected);
  });
});
