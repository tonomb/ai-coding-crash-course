import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getAnalyticsOverview } from "./analyticsService";

const NOW = new Date("2026-06-30T12:00:00.000Z");

function daysAgo(days: number) {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

let slugCounter = 0;
let emailCounter = 0;

function addUser(role = schema.UserRole.Student, name = "Someone") {
  return testDb
    .insert(schema.users)
    .values({ name, email: `user${++emailCounter}@example.com`, role })
    .returning()
    .get();
}

function addCourse(
  instructorId: number,
  title: string,
  status = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title,
      slug: `course-${++slugCounter}`,
      description: "d",
      salesCopy: "s",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function addModule(courseId: number, position: number) {
  return testDb
    .insert(schema.modules)
    .values({ courseId, title: `Module ${position}`, position })
    .returning()
    .get();
}

function addLesson(moduleId: number, title: string, position: number) {
  return testDb
    .insert(schema.lessons)
    .values({ moduleId, title, position })
    .returning()
    .get();
}

function enroll(
  userId: number,
  courseId: number,
  enrolledAt: string,
  completedAt: string | null = null
) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt, completedAt })
    .returning()
    .get();
}

function purchase(
  userId: number,
  courseId: number,
  amountPaid: number,
  createdAt: string
) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, country: "US", createdAt })
    .returning()
    .get();
}

function progress(
  userId: number,
  lessonId: number,
  status: schema.LessonProgressStatus
) {
  testDb
    .insert(schema.lessonProgress)
    .values({ userId, lessonId, status })
    .run();
}

function overview(
  range: "30d" | "90d" | "all" = "30d",
  sort = "sales",
  dir = "desc",
  instructorId = base.instructor.id
) {
  return getAnalyticsOverview(
    { kind: "instructor", id: instructorId },
    range,
    sort,
    dir,
    NOW
  );
}

describe("analyticsService.getAnalyticsOverview", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("money", () => {
    it("sums purchases in range and splits off the 20% platform fee", () => {
      purchase(base.user.id, base.course.id, 10000, daysAgo(1));
      purchase(addUser().id, base.course.id, 4999, daysAgo(2));

      const result = overview();

      expect(result.cards.totalSales).toBe(14999);
      expect(result.cards.platformCut).toBe(3000);
      expect(result.cards.earned).toBe(11999);
    });

    it("counts a team purchase once, and coupon redemptions add students but no revenue", () => {
      const buyer = addUser();
      const teamPurchase = purchase(buyer.id, base.course.id, 30000, daysAgo(3));
      const team = testDb.insert(schema.teams).values({}).returning().get();
      for (let i = 0; i < 3; i++) {
        const redeemer = addUser();
        testDb
          .insert(schema.coupons)
          .values({
            teamId: team.id,
            courseId: base.course.id,
            code: `code-${i}`,
            purchaseId: teamPurchase.id,
            redeemedByUserId: redeemer.id,
            redeemedAt: daysAgo(2),
          })
          .run();
        enroll(redeemer.id, base.course.id, daysAgo(2));
      }

      const result = overview();

      expect(result.cards.totalSales).toBe(30000);
      expect(result.cards.newStudents).toBe(3);
    });
  });

  describe("range windows", () => {
    beforeEach(() => {
      purchase(addUser().id, base.course.id, 1000, daysAgo(10));
      purchase(addUser().id, base.course.id, 2000, daysAgo(60));
      purchase(addUser().id, base.course.id, 4000, daysAgo(200));
      enroll(addUser().id, base.course.id, daysAgo(10));
      enroll(addUser().id, base.course.id, daysAgo(60));
      enroll(addUser().id, base.course.id, daysAgo(200));
    });

    it.each([
      { range: "30d" as const, sales: 1000, students: 1 },
      { range: "90d" as const, sales: 3000, students: 2 },
      { range: "all" as const, sales: 7000, students: 3 },
    ])("$range counts sales and enrollments by their own dates", ({ range, sales, students }) => {
      const result = overview(range);
      expect(result.cards.totalSales).toBe(sales);
      expect(result.cards.newStudents).toBe(students);
      expect(result.courses[0].students).toBe(students);
    });

    it("ignores anything dated after now", () => {
      purchase(addUser().id, base.course.id, 9999, daysAgo(-1));
      expect(overview("all").cards.totalSales).toBe(7000);
    });
  });

  describe("progress and completion", () => {
    it("averages progress over every cohort enrollment, weighted per enrollment", () => {
      // Course A: 2 lessons. Course B: 4 lessons.
      const moduleA = addModule(base.course.id, 1);
      const a1 = addLesson(moduleA.id, "A1", 1);
      addLesson(moduleA.id, "A2", 2);
      const courseB = addCourse(base.instructor.id, "B");
      const moduleB = addModule(courseB.id, 1);
      const bLessons = [1, 2, 3, 4].map((p) => addLesson(moduleB.id, `B${p}`, p));

      // A: one student at 50%. B: one at 100%, one at 0%.
      const s1 = addUser();
      enroll(s1.id, base.course.id, daysAgo(5));
      progress(s1.id, a1.id, schema.LessonProgressStatus.Completed);

      const s2 = addUser();
      enroll(s2.id, courseB.id, daysAgo(5), daysAgo(1));
      for (const lesson of bLessons) {
        progress(s2.id, lesson.id, schema.LessonProgressStatus.Completed);
      }

      const s3 = addUser();
      enroll(s3.id, courseB.id, daysAgo(5));
      progress(s3.id, bLessons[0].id, schema.LessonProgressStatus.InProgress);

      const result = overview();

      // (0.5 + 1 + 0) / 3 = 50%
      expect(result.cards.avgProgress).toBe(50);
      // 1 of 3 finished
      expect(result.cards.percentFinished).toBe(33);
      const byTitle = Object.fromEntries(result.courses.map((c) => [c.title, c]));
      expect(byTitle["Test Course"].avgProgress).toBe(50);
      expect(byTitle["B"].avgProgress).toBe(50);
    });

    it("counts a lesson once even if a student has duplicate progress rows for it", () => {
      const mod = addModule(base.course.id, 1);
      const l1 = addLesson(mod.id, "L1", 1);
      addLesson(mod.id, "L2", 2);
      const s = addUser();
      enroll(s.id, base.course.id, daysAgo(1));
      progress(s.id, l1.id, schema.LessonProgressStatus.Completed);
      progress(s.id, l1.id, schema.LessonProgressStatus.Completed);

      expect(overview().cards.avgProgress).toBe(50);
    });

    it("only describes students who enrolled in the range", () => {
      const mod = addModule(base.course.id, 1);
      const lesson = addLesson(mod.id, "L1", 1);
      const old = addUser();
      enroll(old.id, base.course.id, daysAgo(100), daysAgo(90));
      progress(old.id, lesson.id, schema.LessonProgressStatus.Completed);
      enroll(addUser().id, base.course.id, daysAgo(3));

      expect(overview("30d").cards).toMatchObject({
        newStudents: 1,
        avgProgress: 0,
        percentFinished: 0,
      });
      expect(overview("all").cards).toMatchObject({
        newStudents: 2,
        avgProgress: 50,
        percentFinished: 50,
      });
    });
  });

  describe("retention", () => {
    it("lists each lesson in module then lesson order with the % of the cohort that completed it", () => {
      // Insert out of order to prove ordering comes from positions.
      const mod2 = addModule(base.course.id, 2);
      const mod1 = addModule(base.course.id, 1);
      const m2l1 = addLesson(mod2.id, "M2 L1", 1);
      const m1l2 = addLesson(mod1.id, "M1 L2", 2);
      const m1l1 = addLesson(mod1.id, "M1 L1", 1);

      const students = [addUser(), addUser(), addUser(), addUser()];
      for (const s of students) enroll(s.id, base.course.id, daysAgo(2));
      // All 4 complete M1 L1, 2 complete M1 L2, 1 completes M2 L1.
      for (const s of students) progress(s.id, m1l1.id, schema.LessonProgressStatus.Completed);
      progress(students[0].id, m1l2.id, schema.LessonProgressStatus.Completed);
      progress(students[1].id, m1l2.id, schema.LessonProgressStatus.Completed);
      progress(students[2].id, m1l2.id, schema.LessonProgressStatus.InProgress);
      progress(students[0].id, m2l1.id, schema.LessonProgressStatus.Completed);

      // A student outside the cohort doesn't count.
      const old = addUser();
      enroll(old.id, base.course.id, daysAgo(100));
      progress(old.id, m2l1.id, schema.LessonProgressStatus.Completed);

      const [row] = overview().courses;

      expect(row.retention).toEqual([
        { lessonId: m1l1.id, title: "M1 L1", completedPercent: 100, inProgress: 0 },
        { lessonId: m1l2.id, title: "M1 L2", completedPercent: 50, inProgress: 1 },
        { lessonId: m2l1.id, title: "M2 L1", completedPercent: 25, inProgress: 0 },
      ]);
    });

    it("shows 0% for every lesson when the cohort is empty", () => {
      const mod = addModule(base.course.id, 1);
      const lesson = addLesson(mod.id, "L1", 1);

      expect(overview().courses[0].retention).toEqual([
        { lessonId: lesson.id, title: "L1", completedPercent: 0, inProgress: 0 },
      ]);
    });
  });

  describe("drafts", () => {
    it("leaves drafts out of every number but reports how many there are", () => {
      const draft = addCourse(base.instructor.id, "Draft", schema.CourseStatus.Draft);
      purchase(addUser().id, draft.id, 5000, daysAgo(1));
      enroll(addUser().id, draft.id, daysAgo(1));
      const archived = addCourse(base.instructor.id, "Old", schema.CourseStatus.Archived);
      purchase(addUser().id, archived.id, 700, daysAgo(1));

      const result = overview();

      expect(result.draftCount).toBe(1);
      expect(result.cards.totalSales).toBe(700);
      expect(result.cards.newStudents).toBe(0);
      expect(result.courses.map((c) => c.title).sort()).toEqual(["Old", "Test Course"]);
    });
  });

  describe("page kind and hints", () => {
    it("is empty-no-courses for an instructor with no courses at all", () => {
      const fresh = addUser(schema.UserRole.Instructor);
      const result = overview("30d", "sales", "desc", fresh.id);
      expect(result.kind).toBe("empty-no-courses");
      expect(result.draftCount).toBe(0);
    });

    it("is empty-drafts-only when every course is a draft", () => {
      const fresh = addUser(schema.UserRole.Instructor);
      addCourse(fresh.id, "D1", schema.CourseStatus.Draft);
      addCourse(fresh.id, "D2", schema.CourseStatus.Draft);
      const result = overview("30d", "sales", "desc", fresh.id);
      expect(result.kind).toBe("empty-drafts-only");
      expect(result.draftCount).toBe(2);
    });

    it("flags noStudentsYet when courses are published but nobody has ever enrolled", () => {
      const result = overview("all");
      expect(result.kind).toBe("data");
      expect(result.hints).toEqual({ noStudentsYet: true, noActivityInRange: false });
    });

    it("never flags noStudentsYet on the platform view, which just shows zeros", () => {
      const result = getAnalyticsOverview({ kind: "platform" }, "all", "sales", "desc", NOW);
      expect(result.kind).toBe("data");
      expect(result.hints.noStudentsYet).toBe(false);
    });

    it("flags noActivityInRange when the range is empty but all time is not", () => {
      enroll(addUser().id, base.course.id, daysAgo(100));

      expect(overview("30d").hints).toEqual({ noStudentsYet: false, noActivityInRange: true });
      expect(overview("all").hints).toEqual({ noStudentsYet: false, noActivityInRange: false });
    });

    it("does not flag noActivityInRange when there were sales in range", () => {
      enroll(addUser().id, base.course.id, daysAgo(100));
      purchase(addUser().id, base.course.id, 500, daysAgo(1));
      expect(overview("30d").hints.noActivityInRange).toBe(false);
    });
  });

  describe("sorting", () => {
    beforeEach(() => {
      // Distinct value per column so each sort gives a different order.
      //            sales  students  progress
      // Test Course 3000     1         0%
      // Alpha       1000     3        33%
      // Zulu        2000     2       100%
      const alpha = addCourse(base.instructor.id, "Alpha");
      const zulu = addCourse(base.instructor.id, "Zulu");
      purchase(addUser().id, base.course.id, 3000, daysAgo(1));
      purchase(addUser().id, alpha.id, 1000, daysAgo(1));
      purchase(addUser().id, zulu.id, 2000, daysAgo(1));

      addLesson(addModule(base.course.id, 1).id, "T1", 1);
      const alphaLesson = addLesson(addModule(alpha.id, 1).id, "A1", 1);
      const zuluLesson = addLesson(addModule(zulu.id, 1).id, "Z1", 1);

      enroll(addUser().id, base.course.id, daysAgo(1));
      const alphaStudents = [addUser(), addUser(), addUser()];
      for (const s of alphaStudents) enroll(s.id, alpha.id, daysAgo(1));
      progress(alphaStudents[0].id, alphaLesson.id, schema.LessonProgressStatus.Completed);
      for (const s of [addUser(), addUser()]) {
        enroll(s.id, zulu.id, daysAgo(1));
        progress(s.id, zuluLesson.id, schema.LessonProgressStatus.Completed);
      }
    });

    const titles = (sort: string, dir: string) =>
      overview("30d", sort, dir).courses.map((c) => c.title);

    it.each([
      { sort: "sales", desc: ["Test Course", "Zulu", "Alpha"] },
      { sort: "earned", desc: ["Test Course", "Zulu", "Alpha"] },
      { sort: "students", desc: ["Alpha", "Zulu", "Test Course"] },
      { sort: "progress", desc: ["Zulu", "Alpha", "Test Course"] },
      { sort: "title", desc: ["Zulu", "Test Course", "Alpha"] },
    ])("sorts by $sort in both directions", ({ sort, desc }) => {
      expect(titles(sort, "desc")).toEqual(desc);
      expect(titles(sort, "asc")).toEqual([...desc].reverse());
    });

    it("falls back to sales descending for an unknown sort or direction", () => {
      const result = overview("30d", "amount_paid; drop table users", "sideways");
      expect(result.sort).toBe("sales");
      expect(result.dir).toBe("desc");
      expect(result.courses.map((c) => c.title)).toEqual(["Test Course", "Zulu", "Alpha"]);
    });
  });

  describe("enrollment series", () => {
    beforeEach(() => {
      enroll(addUser().id, base.course.id, daysAgo(0));
      enroll(addUser().id, base.course.id, daysAgo(1));
      enroll(addUser().id, base.course.id, daysAgo(1));
      enroll(addUser().id, base.course.id, daysAgo(7));
      enroll(addUser().id, base.course.id, daysAgo(200));
    });

    it("uses one bucket per day for 30d, zero-filled", () => {
      const { series } = overview("30d");
      expect(series).toHaveLength(30);
      expect(series[0]).toEqual({ date: "2026-06-01", enrollments: 0 });
      expect(series.at(-1)).toEqual({ date: "2026-06-30", enrollments: 1 });
      expect(series.at(-2)).toEqual({ date: "2026-06-29", enrollments: 2 });
      expect(series.find((b) => b.date === "2026-06-23")).toEqual({ date: "2026-06-23", enrollments: 1 });
    });

    it("uses one bucket per week (starting Monday) for 90d", () => {
      const { series } = overview("90d");
      // 2026-06-30 is a Tuesday; the window starts Thursday 2026-04-02.
      expect(series[0].date).toBe("2026-03-30");
      expect(series.at(-1)).toEqual({ date: "2026-06-29", enrollments: 3 });
      expect(series.at(-2)).toEqual({ date: "2026-06-22", enrollments: 1 });
      expect(series).toHaveLength(14);
    });

    it("uses weekly buckets from the first enrollment for all time", () => {
      const { series } = overview("all");
      // The oldest enrollment is Friday 2025-12-12.
      expect(series[0]).toEqual({ date: "2025-12-08", enrollments: 1 });
      expect(series.at(-1)!.date).toBe("2026-06-29");
      expect(series.reduce((sum, b) => sum + b.enrollments, 0)).toBe(5);
    });

    it("is empty for all time when nobody has enrolled", () => {
      testDb = createTestDb();
      base = seedBaseData(testDb);
      expect(overview("all").series).toEqual([]);
    });
  });

  describe("scope isolation", () => {
    it("never includes another instructor's courses, sales or students", () => {
      const other = addUser(schema.UserRole.Instructor, "Other");
      const otherCourse = addCourse(other.id, "Other's course");
      purchase(addUser().id, otherCourse.id, 9000, daysAgo(1));
      enroll(addUser().id, otherCourse.id, daysAgo(1));
      purchase(addUser().id, base.course.id, 100, daysAgo(1));

      const mine = overview();
      expect(mine.courses.map((c) => c.title)).toEqual(["Test Course"]);
      expect(mine.cards.totalSales).toBe(100);
      expect(mine.cards.newStudents).toBe(0);
      expect(mine.series.reduce((sum, b) => sum + b.enrollments, 0)).toBe(0);

      const theirs = overview("30d", "sales", "desc", other.id);
      expect(theirs.cards.totalSales).toBe(9000);
      expect(theirs.cards.newStudents).toBe(1);
    });

    it("platform scope spans every instructor", () => {
      const other = addUser(schema.UserRole.Instructor, "Other");
      const otherCourse = addCourse(other.id, "Other's course");
      purchase(addUser().id, otherCourse.id, 9000, daysAgo(1));
      purchase(addUser().id, base.course.id, 100, daysAgo(1));

      const result = getAnalyticsOverview({ kind: "platform" }, "30d", "sales", "desc", NOW);
      expect(result.cards.totalSales).toBe(9100);
    });
  });
});
