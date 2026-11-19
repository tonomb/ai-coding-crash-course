import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  CourseStatus,
  courses,
  enrollments,
  LessonProgressStatus,
  lessonProgress,
  lessons,
  modules,
  purchases,
  users,
} from "~/db/schema";
import type { AnalyticsScope } from "~/lib/analytics-scope";

// ─── Analytics Service ───
// Read-only numbers for the analytics pages. Receives an already-resolved scope
// (see ~/lib/analytics-scope), never a viewer. `now` is a parameter so range
// windows and bucketing are deterministic.
//
// Metric definitions:
// - Money is in cents. Sales are purchases in the range, on their own date.
//   A team purchase is one purchase row; coupon redemptions only create
//   enrollments, so they add students but never revenue.
// - The cohort is the enrollments whose enrolledAt falls in the range. New
//   students, avg progress, % finished and retention all describe the cohort.
// - Draft courses are excluded from every number.

export const PLATFORM_FEE_RATE = 0.2;

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

const DEFAULT_SORT: CourseSortColumn = "sales";
const DEFAULT_DIR: SortDir = "desc";

const ANALYTICS_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<AnalyticsRange, number | null> = {
  "30d": 30,
  "90d": 90,
  all: null,
};

function splitSales(totalSales: number) {
  const platformCut = Math.round(totalSales * PLATFORM_FEE_RATE);
  return { platformCut, earned: totalSales - platformCut };
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

/**
 * Start of the range: midnight UTC, so "30d" is today plus the 29 days before
 * it — exactly the 30 daily chart buckets. Null for "all".
 */
function rangeStart(range: AnalyticsRange, now: Date) {
  const days = RANGE_DAYS[range];
  if (days === null) return null;
  return new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS);
}

/** `column` within [range start, now]. */
function inWindow(column: SQLiteColumn, range: AnalyticsRange, now: Date) {
  const start = rangeStart(range, now);
  const upper = lte(column, now.toISOString());
  if (start === null) return upper;
  return and(gte(column, start.toISOString()), upper);
}

function scopeFilter(scope: AnalyticsScope) {
  return scope.kind === "instructor"
    ? eq(courses.instructorId, scope.id)
    : undefined;
}

// ─── Course rows ───

function getCourseRows(
  scope: AnalyticsScope,
  range: AnalyticsRange,
  sort: CourseSortColumn,
  dir: SortDir,
  now: Date
) {
  const sales = db
    .select({
      courseId: purchases.courseId,
      total: sql<number>`sum(${purchases.amountPaid})`.as("sales_total"),
    })
    .from(purchases)
    .where(inWindow(purchases.createdAt, range, now))
    .groupBy(purchases.courseId)
    .as("sales");

  const lessonTotals = db
    .select({
      courseId: modules.courseId,
      total: sql<number>`count(${lessons.id})`.as("lesson_total"),
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .groupBy(modules.courseId)
    .as("lesson_totals");

  const completions = db
    .select({
      userId: lessonProgress.userId,
      courseId: modules.courseId,
      completed: sql<number>`count(*)`.as("completed_count"),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(lessonProgress.status, LessonProgressStatus.Completed))
    .groupBy(lessonProgress.userId, modules.courseId)
    .as("completions");

  // Per-enrollment progress, so a big course weighs more than a small one.
  const cohort = db
    .select({
      courseId: enrollments.courseId,
      students: sql<number>`count(*)`.as("cohort_students"),
      finished:
        sql<number>`sum(case when ${enrollments.completedAt} is not null then 1 else 0 end)`.as(
          "cohort_finished"
        ),
      progressSum: sql<number>`sum(case when ${lessonTotals.total} > 0
          then coalesce(${completions.completed}, 0) * 1.0 / ${lessonTotals.total}
          else 0 end)`.as("cohort_progress_sum"),
    })
    .from(enrollments)
    .leftJoin(lessonTotals, eq(lessonTotals.courseId, enrollments.courseId))
    .leftJoin(
      completions,
      and(
        eq(completions.courseId, enrollments.courseId),
        eq(completions.userId, enrollments.userId)
      )
    )
    .where(inWindow(enrollments.enrolledAt, range, now))
    .groupBy(enrollments.courseId)
    .as("cohort");

  const totalSales = sql<number>`coalesce(${sales.total}, 0)`;
  const students = sql<number>`coalesce(${cohort.students}, 0)`;
  const avgProgress = sql<number>`coalesce(${cohort.progressSum} * 1.0 / ${cohort.students}, 0)`;

  // Whitelist: raw param values never reach SQL. Earned is a fixed share of
  // sales, so it sorts the same way.
  const sortExpressions: Record<CourseSortColumn, SQL | SQLiteColumn> = {
    title: courses.title,
    students,
    sales: totalSales,
    earned: totalSales,
    progress: avgProgress,
  };
  const order = dir === "asc" ? asc : desc;

  return db
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      status: courses.status,
      instructorName: users.name,
      instructorEmail: users.email,
      totalSales,
      students,
      finished: sql<number>`coalesce(${cohort.finished}, 0)`,
      progressSum: sql<number>`coalesce(${cohort.progressSum}, 0)`,
      avgProgress,
    })
    .from(courses)
    .innerJoin(users, eq(users.id, courses.instructorId))
    .leftJoin(sales, eq(sales.courseId, courses.id))
    .leftJoin(cohort, eq(cohort.courseId, courses.id))
    .where(and(inArray(courses.status, ANALYTICS_STATUSES), scopeFilter(scope)))
    .orderBy(order(sortExpressions[sort]), asc(courses.id))
    .all();
}

// ─── Retention ───

/**
 * Per lesson, how many of the course's cohort completed it or are still on it.
 * Lessons come back in course order: module position, then lesson position.
 */
function getLessonRetention(
  courseIds: number[],
  range: AnalyticsRange,
  now: Date
) {
  if (courseIds.length === 0) return [];

  return db
    .select({
      courseId: modules.courseId,
      lessonId: lessons.id,
      title: lessons.title,
      completed: sql<number>`count(distinct case when ${lessonProgress.status} = ${LessonProgressStatus.Completed} then ${enrollments.id} end)`,
      inProgress: sql<number>`count(distinct case when ${lessonProgress.status} = ${LessonProgressStatus.InProgress} then ${enrollments.id} end)`,
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .leftJoin(
      enrollments,
      and(
        eq(enrollments.courseId, modules.courseId),
        inWindow(enrollments.enrolledAt, range, now)
      )
    )
    .leftJoin(
      lessonProgress,
      and(
        eq(lessonProgress.lessonId, lessons.id),
        eq(lessonProgress.userId, enrollments.userId)
      )
    )
    .where(inArray(modules.courseId, courseIds))
    .groupBy(lessons.id)
    .orderBy(asc(modules.position), asc(lessons.position), asc(lessons.id))
    .all();
}

// ─── Enrollment series ───

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** Monday (UTC) of the week containing `date`. */
function startOfUtcWeek(date: Date) {
  const day = startOfUtcDay(date);
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - daysSinceMonday * DAY_MS);
}

/**
 * Enrollments per bucket: daily for 30d, weekly (keyed by Monday) for 90d and
 * all. Every bucket from the range start (or, for "all", the first
 * enrollment) to now is present, zero-filled.
 */
function getEnrollmentSeries(
  scope: AnalyticsScope,
  range: AnalyticsRange,
  now: Date
) {
  const weekly = range !== "30d";
  // SQLite: step back 6 days, then forward to the next Monday — lands on the
  // Monday of the enrollment's own week.
  const bucket = weekly
    ? sql<string>`date(${enrollments.enrolledAt}, '-6 days', 'weekday 1')`
    : sql<string>`date(${enrollments.enrolledAt})`;

  const counts = db
    .select({ bucket, enrollments: sql<number>`count(*)` })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(
      and(
        inArray(courses.status, ANALYTICS_STATUSES),
        scopeFilter(scope),
        inWindow(enrollments.enrolledAt, range, now)
      )
    )
    .groupBy(bucket)
    .orderBy(asc(bucket))
    .all();

  const firstBucket = rangeStart(range, now)
    ?? (counts.length > 0 ? new Date(`${counts[0].bucket}T00:00:00.000Z`) : null);
  if (firstBucket === null) return [];

  const countByBucket = new Map(counts.map((c) => [c.bucket, c.enrollments]));
  const step = weekly ? 7 * DAY_MS : DAY_MS;
  const last = weekly ? startOfUtcWeek(now) : startOfUtcDay(now);
  const series: { date: string; enrollments: number }[] = [];
  for (
    let t = (weekly ? startOfUtcWeek(firstBucket) : firstBucket).getTime();
    t <= last.getTime();
    t += step
  ) {
    const date = isoDate(new Date(t));
    series.push({ date, enrollments: countByBucket.get(date) ?? 0 });
  }
  return series;
}

// ─── Page kind and hints ───

function countDrafts(scope: AnalyticsScope) {
  return db
    .select({ count: sql<number>`count(*)` })
    .from(courses)
    .where(and(eq(courses.status, CourseStatus.Draft), scopeFilter(scope)))
    .get()!.count;
}

/** Whether the scope has ever had an enrollment or a sale, on non-draft courses. */
function getAllTimeActivity(scope: AnalyticsScope) {
  const visibleCourses = and(
    inArray(courses.status, ANALYTICS_STATUSES),
    scopeFilter(scope)
  );
  const enrollmentCount = db
    .select({ count: sql<number>`count(*)` })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(visibleCourses)
    .get()!.count;
  const purchaseCount = db
    .select({ count: sql<number>`count(*)` })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(visibleCourses)
    .get()!.count;
  return { hasEnrollments: enrollmentCount > 0, hasPurchases: purchaseCount > 0 };
}

export type OverviewKind = "empty-no-courses" | "empty-drafts-only" | "data";

// ─── Overview ───

export function getAnalyticsOverview(
  scope: AnalyticsScope,
  range: AnalyticsRange,
  sort: string,
  dir: string,
  now: Date
) {
  const sortColumn = (COURSE_SORT_COLUMNS as readonly string[]).includes(sort)
    ? (sort as CourseSortColumn)
    : DEFAULT_SORT;
  const sortDir: SortDir = dir === "asc" || dir === "desc" ? dir : DEFAULT_DIR;

  const rows = getCourseRows(scope, range, sortColumn, sortDir, now);
  const draftCount = countDrafts(scope);

  // The empty panels are for instructors; a fresh platform just shows zeros.
  let kind: OverviewKind = "data";
  if (scope.kind === "instructor" && rows.length === 0) {
    kind = draftCount > 0 ? "empty-drafts-only" : "empty-no-courses";
  }

  const totalSales = rows.reduce((sum, row) => sum + row.totalSales, 0);
  const newStudents = rows.reduce((sum, row) => sum + row.students, 0);
  const finished = rows.reduce((sum, row) => sum + row.finished, 0);
  const progressSum = rows.reduce((sum, row) => sum + row.progressSum, 0);

  const retentionByCourse = new Map<
    number,
    ReturnType<typeof getLessonRetention>
  >();
  for (const lesson of getLessonRetention(
    rows.map((row) => row.id),
    range,
    now
  )) {
    const list = retentionByCourse.get(lesson.courseId) ?? [];
    list.push(lesson);
    retentionByCourse.set(lesson.courseId, list);
  }

  const allTime = getAllTimeActivity(scope);
  const hints = {
    noStudentsYet: rows.length > 0 && !allTime.hasEnrollments,
    noActivityInRange:
      range !== "all" &&
      totalSales === 0 &&
      newStudents === 0 &&
      (allTime.hasEnrollments || allTime.hasPurchases),
  };

  return {
    kind,
    draftCount,
    hints,
    sort: sortColumn,
    dir: sortDir,
    series: getEnrollmentSeries(scope, range, now),
    cards: {
      totalSales,
      ...splitSales(totalSales),
      newStudents,
      avgProgress: newStudents ? toPercent(progressSum / newStudents) : 0,
      percentFinished: newStudents ? toPercent(finished / newStudents) : 0,
    },
    courses: rows.map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.status,
      instructorName: row.instructorName,
      instructorEmail: row.instructorEmail,
      students: row.students,
      totalSales: row.totalSales,
      ...splitSales(row.totalSales),
      avgProgress: toPercent(row.avgProgress),
      retention: (retentionByCourse.get(row.id) ?? []).map((lesson) => ({
        lessonId: lesson.lessonId,
        title: lesson.title,
        completedPercent: row.students
          ? toPercent(lesson.completed / row.students)
          : 0,
        inProgress: lesson.inProgress,
      })),
    })),
  };
}

/** A 0–1 share as a whole-number percentage. */
function toPercent(share: number) {
  return Math.round(share * 100);
}
