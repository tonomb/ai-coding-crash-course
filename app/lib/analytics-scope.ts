import { UserRole } from "~/db/schema";

// ─── Analytics Scope ───
// Decides whose numbers a viewer may see on the analytics pages. Pure, so the
// rule is testable without a request; the loader turns "forbidden" into a 403.
// analyticsService only ever receives the resolved scope, never a viewer.

export type AnalyticsScope =
  | { kind: "platform" }
  | { kind: "instructor"; id: number };

export function resolveAnalyticsScope(
  viewer: { id: number; role: UserRole },
  requestedInstructorId: number | null
): AnalyticsScope | "forbidden" {
  if (viewer.role === UserRole.Admin) {
    return requestedInstructorId === null
      ? { kind: "platform" }
      : { kind: "instructor", id: requestedInstructorId };
  }

  // Instructors only ever see themselves — a requested id is ignored.
  if (viewer.role === UserRole.Instructor) {
    return { kind: "instructor", id: viewer.id };
  }

  return "forbidden";
}
