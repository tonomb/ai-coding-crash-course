// ─── Analytics Options ───
// The ranges and sort columns the analytics page offers. Kept out of
// analyticsService so the route's components can use them without pulling the
// service (and with it `~/db` and better-sqlite3) into the client bundle.

export const ANALYTICS_RANGES = ["30d", "90d", "all"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const COURSE_SORT_COLUMNS = [
  "title",
  "students",
  "sales",
  "earned",
  "progress",
] as const;
export type CourseSortColumn = (typeof COURSE_SORT_COLUMNS)[number];
export type SortDir = "asc" | "desc";
