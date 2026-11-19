import {
  Link,
  data,
  isRouteErrorResponse,
  useLoaderData,
  useSearchParams,
} from "react-router";
import { z } from "zod";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  FileText,
  Plus,
} from "lucide-react";
import type { Route } from "./+types/instructor.analytics";
import { requireUserId } from "~/lib/access.server";
import { resolveAnalyticsScope } from "~/lib/analytics-scope";
import { getUserById } from "~/services/userService";
import { getAnalyticsOverview } from "~/services/analyticsService";
import {
  ANALYTICS_RANGES,
  type AnalyticsRange,
  type CourseSortColumn,
} from "~/lib/analytics-options";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { cn, formatPrice } from "~/lib/utils";

// ─── Analytics Overview ───
// All view state lives in the URL: `range`, `instructor` (admins only),
// `sort` and `dir`. There is no client state, so every view is bookmarkable.
// `sort`/`dir` are passed through as strings — analyticsService owns the
// column whitelist and falls back to sales/desc on anything else.

const paramsSchema = z.object({
  range: z.enum(ANALYTICS_RANGES).catch("30d"),
  instructor: z.coerce.number().int().positive().optional().catch(undefined),
});

const RANGE_LABELS: Record<AnalyticsRange, string> = {
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
};

export function meta() {
  return [{ title: "Analytics — Cadence" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const viewer = getUserById(userId);
  if (!viewer) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const url = new URL(request.url);
  const params = paramsSchema.parse({
    range: url.searchParams.get("range") ?? undefined,
    instructor: url.searchParams.get("instructor") ?? undefined,
  });

  const scope = resolveAnalyticsScope(viewer, params.instructor ?? null);
  if (scope === "forbidden") {
    throw data("Only instructors and admins can view analytics.", {
      status: 403,
    });
  }

  const overview = getAnalyticsOverview(
    scope,
    params.range,
    url.searchParams.get("sort") ?? "",
    url.searchParams.get("dir") ?? "",
    new Date()
  );

  let earnedLabel = "You earned";
  if (scope.kind === "platform") {
    earnedLabel = "Platform cut";
  } else if (scope.id !== viewer.id) {
    earnedLabel = `${getUserById(scope.id)?.name ?? "Instructor"} earned`;
  }

  return {
    ...overview,
    range: params.range,
    isPlatform: scope.kind === "platform",
    earnedLabel,
  };
}

// ─── URL helpers ───

/** The current search string with some params replaced, for a <Link>. */
function useHrefWith() {
  const [searchParams] = useSearchParams();
  return (updates: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) next.set(key, value);
    return `?${next.toString()}`;
  };
}

function formatMoney(cents: number) {
  return cents === 0 ? "$0.00" : formatPrice(cents);
}

// ─── Page ───

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <Skeleton className="mb-8 h-9 w-48" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="mt-6 h-72" />
    </div>
  );
}

export default function AnalyticsOverview({ loaderData }: Route.ComponentProps) {
  const { kind, draftCount, hints, range } = loaderData;
  const hrefWith = useHrefWith();

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Analytics</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="mt-1 text-muted-foreground">
            Sales, students and how far they get
          </p>
        </div>
        {kind === "data" && <RangeToggle range={range} />}
      </div>

      {kind === "empty-no-courses" && <NoCoursesPanel />}
      {kind === "empty-drafts-only" && <DraftsOnlyPanel draftCount={draftCount} />}
      {kind === "data" && (
        <>
          {hints.noStudentsYet && (
            <Hint>
              No students yet. Share your course link to get your first
              enrollments.
            </Hint>
          )}
          {hints.noActivityInRange && (
            <Hint>
              No activity in the last {RANGE_LABELS[range]} —{" "}
              <Link to={hrefWith({ range: "all" })} className="font-medium underline">
                View all time
              </Link>
            </Hint>
          )}
          <SummaryCards />
          <EnrollmentChart />
          <CourseTable />
        </>
      )}
    </div>
  );
}

function RangeToggle({ range }: { range: AnalyticsRange }) {
  const hrefWith = useHrefWith();
  return (
    <div className="inline-flex rounded-md border border-border p-1">
      {ANALYTICS_RANGES.map((value) => (
        <Link
          key={value}
          to={hrefWith({ range: value })}
          className={cn(
            "rounded px-3 py-1.5 text-sm font-medium transition-colors",
            value === range
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {value === "all" ? "All time" : value}
        </Link>
      ))}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-md border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
      <BarChart3 className="mb-4 size-12 text-muted-foreground/50" />
      {children}
    </div>
  );
}

function NoCoursesPanel() {
  return (
    <EmptyPanel>
      <h2 className="text-lg font-medium">Your analytics will live here</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Once you publish a course you'll see sales, earnings, new students and
        how far they get through each lesson.
      </p>
      <Link to="/instructor/new" className="mt-4">
        <Button>
          <Plus className="mr-2 size-4" />
          Create a course
        </Button>
      </Link>
    </EmptyPanel>
  );
}

function DraftsOnlyPanel({ draftCount }: { draftCount: number }) {
  return (
    <EmptyPanel>
      <h2 className="text-lg font-medium">
        You have {draftCount} {draftCount === 1 ? "draft" : "drafts"}
      </h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Publish a course and its sales and student progress will show up here.
      </p>
      <Link to="/instructor" className="mt-4">
        <Button variant="outline">
          <FileText className="mr-2 size-4" />
          Go to my courses
        </Button>
      </Link>
    </EmptyPanel>
  );
}

function StatCard({
  title,
  value,
  secondary,
}: {
  title: string;
  value: string;
  secondary?: string;
}) {
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {secondary && (
          <p className="mt-1 text-xs text-muted-foreground">{secondary}</p>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryCards() {
  const { cards, isPlatform, earnedLabel } = useLoaderData<typeof loader>();
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard title="Total sales" value={formatMoney(cards.totalSales)} />
      <StatCard
        title={earnedLabel}
        value={formatMoney(isPlatform ? cards.platformCut : cards.earned)}
      />
      <StatCard title="New students" value={String(cards.newStudents)} />
      <StatCard
        title="Avg progress"
        value={`${cards.avgProgress}%`}
        secondary={`${cards.percentFinished}% finished`}
      />
    </div>
  );
}

function EnrollmentChart() {
  const { series, range } = useLoaderData<typeof loader>();
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Enrollments over time</CardTitle>
        <p className="text-sm text-muted-foreground">
          {range === "30d" ? "Per day" : "Per week"}
        </p>
      </CardHeader>
      <CardContent>
        {series.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No enrollments yet.
          </p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatBucketDate}
                  tick={{ fontSize: 12 }}
                  minTickGap={16}
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={32} />
                <Tooltip
                  // recharts defaults to a white box and a light-grey cursor,
                  // which are unreadable in dark mode — follow the theme.
                  cursor={{ fill: "var(--color-muted)" }}
                  contentStyle={{
                    background: "var(--color-popover)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "var(--color-popover-foreground)" }}
                  itemStyle={{ color: "var(--color-popover-foreground)" }}
                  labelFormatter={(label) =>
                    range === "30d"
                      ? formatBucketDate(String(label))
                      : `Week of ${formatBucketDate(String(label))}`
                  }
                />
                <Bar
                  dataKey="enrollments"
                  name="Enrollments"
                  fill="var(--color-primary)"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatBucketDate(isoDate: string) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function SortHeader({
  column,
  label,
  align = "right",
}: {
  column: CourseSortColumn;
  label: string;
  align?: "left" | "right";
}) {
  const { sort, dir } = useLoaderData<typeof loader>();
  const hrefWith = useHrefWith();
  const active = sort === column;
  // Clicking the active column flips it; a new column starts descending
  // (ascending for the title, where A→Z is the natural first look).
  const nextDir = active
    ? dir === "desc"
      ? "asc"
      : "desc"
    : column === "title"
      ? "asc"
      : "desc";

  return (
    <th
      className={cn(
        "px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground",
        align === "right" ? "text-right" : "text-left"
      )}
    >
      <Link
        to={hrefWith({ sort: column, dir: nextDir })}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active && "text-foreground"
        )}
      >
        {label}
        {active &&
          (dir === "desc" ? (
            <ArrowDown className="size-3" />
          ) : (
            <ArrowUp className="size-3" />
          ))}
      </Link>
    </th>
  );
}

function CourseTable() {
  const { courses, isPlatform } = useLoaderData<typeof loader>();
  return (
    <Card className="mt-6 gap-0 py-0">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-border">
            <tr>
              <SortHeader column="title" label="Course" align="left" />
              <SortHeader column="students" label="Students" />
              <SortHeader column="sales" label="Total sales" />
              <SortHeader
                column="earned"
                label={isPlatform ? "Platform cut" : "Earned"}
              />
              <SortHeader column="progress" label="Retention" />
            </tr>
          </thead>
          <tbody>
            {courses.map((course) => (
              <tr
                key={course.id}
                className="border-b border-border last:border-0 hover:bg-muted/50"
              >
                <td className="px-4 py-3">
                  <Link
                    to={`/instructor/analytics/${course.id}`}
                    className="font-medium hover:text-primary"
                  >
                    {course.title}
                  </Link>
                  {course.status === "archived" && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      Archived
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {course.students}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatMoney(course.totalSales)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatMoney(isPlatform ? course.platformCut : course.earned)}
                </td>
                <td className="px-4 py-3">
                  <RetentionSummary
                    retention={course.retention}
                    avgProgress={course.avgProgress}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** One tiny bar per lesson, in course order, with the course's avg progress. */
function RetentionSummary({
  retention,
  avgProgress,
}: {
  retention: { lessonId: number; title: string; completedPercent: number }[];
  avgProgress: number;
}) {
  return (
    <div className="flex items-center justify-end gap-3">
      {retention.length === 0 ? (
        <span className="text-xs text-muted-foreground">No lessons</span>
      ) : (
        <div className="flex h-6 items-end gap-px" aria-hidden>
          {retention.map((lesson) => (
            <div
              key={lesson.lessonId}
              title={`${lesson.title}: ${lesson.completedPercent}%`}
              className="w-1.5 rounded-t-sm bg-primary/70"
              style={{ height: `${Math.max(lesson.completedPercent, 4)}%` }}
            />
          ))}
        </div>
      )}
      <span className="w-10 text-right text-sm tabular-nums">
        {avgProgress}%
      </span>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
    } else if (error.status === 403) {
      title = "Access denied";
    } else {
      title = `Error ${error.status}`;
    }
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
