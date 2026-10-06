import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { RunAnalytics } from "@/lib/engine";
import { formatDateTime } from "@/lib/utils";

const PIE_COLORS = ["hsl(var(--success))", "hsl(var(--destructive))"];

const chartConfig = {
  count: { label: "Count", color: "hsl(var(--primary))" },
  good: { label: "Good Products", color: "hsl(var(--success))" },
  bad: { label: "Bad Products", color: "hsl(var(--destructive))" },
} satisfies ChartConfig;

interface Props {
  analytics: Partial<RunAnalytics>;
  goodClasses: string[];
  startedAt?: string | null;
  endedAt?: string | null;
}

/** Run analytics — same cards, charts and breakdown as the web app's "Run Analytics" dialog. */
export function AnalyticsView({ analytics, goodClasses, startedAt, endedAt }: Props) {
  const total = analytics.totalProducts ?? 0;
  const good = analytics.goodProducts ?? 0;
  const bad = analytics.badProducts ?? 0;

  const defectRows = useMemo(() => {
    const goodSet = new Set(goodClasses);
    return Object.entries(analytics.classCounts ?? {})
      .filter(([cls]) => !goodSet.has(cls))
      .map(([className, count]) => ({ className, count, share: bad > 0 ? (count / bad) * 100 : 0 }))
      .sort((a, b) => b.count - a.count);
  }, [analytics.classCounts, goodClasses, bad]);

  const pieData = [
    { key: "good", label: "Good Products", count: good },
    { key: "bad", label: "Bad Products", count: bad },
  ];
  const defectRate = total > 0 ? (bad / total) * 100 : 0;
  const top = defectRows[0];

  return (
    <div className="space-y-4">
      <div className="grid gap-2 rounded-md border p-3 text-xs text-muted-foreground md:grid-cols-2">
        <p>
          Run started: <span className="font-medium text-foreground">{formatDateTime(startedAt)}</span>
        </p>
        <p>
          Run ended: <span className="font-medium text-foreground">{endedAt ? formatDateTime(endedAt) : "Running"}</span>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="Total Products" value={total} />
        <Stat label="Good Products" value={good} className="text-emerald-500" />
        <Stat label="Bad Products" value={bad} className="text-red-500" />
        <Stat label="Defect Rate" value={`${defectRate.toFixed(1)}%`} className="text-amber-500" />
        <Stat label="Top Defect" value={top?.className ?? "None"} truncate />
      </div>

      {total === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No products counted yet. Products are counted when they pass fully inside the centre guide.
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border p-3">
              <p className="mb-2 text-xs text-muted-foreground">Good vs Bad</p>
              <ChartContainer config={chartConfig} className="h-[260px] w-full">
                <PieChart>
                  <Pie data={pieData} dataKey="count" nameKey="label" innerRadius={50} outerRadius={90} isAnimationActive={false}>
                    {pieData.map((entry, i) => (
                      <Cell key={entry.key} fill={PIE_COLORS[i]} />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                </PieChart>
              </ChartContainer>
            </div>
            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Defect Class Counts</p>
                <p className="text-xs text-muted-foreground">
                  {defectRows.length} class{defectRows.length === 1 ? "" : "es"}
                </p>
              </div>
              {defectRows.length > 0 ? (
                <ChartContainer config={chartConfig} className="h-[260px] w-full">
                  <BarChart data={defectRows}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="className" tickLine={false} axisLine={false} interval={0} angle={-20} textAnchor="end" height={52} />
                    <YAxis allowDecimals={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]} fill="var(--color-count)" isAnimationActive={false} />
                  </BarChart>
                </ChartContainer>
              ) : (
                <div className="flex h-[260px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                  No defect classes detected in this run.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-md border p-3">
            <p className="text-sm font-medium">Defect Breakdown</p>
            <p className="mb-3 text-xs text-muted-foreground">Share is calculated against bad products in this run.</p>
            {defectRows.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Defect Class</th>
                    <th className="py-2 pr-4 font-medium">Count</th>
                    <th className="py-2 font-medium">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {defectRows.map((row) => (
                    <tr key={row.className} className="border-b last:border-b-0">
                      <td className="py-2 pr-4 font-medium">{row.className}</td>
                      <td className="tabular py-2 pr-4">{row.count}</td>
                      <td className="tabular py-2">{row.share.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No defect classes available to summarize yet.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, className, truncate }: { label: string; value: string | number; className?: string; truncate?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`tabular text-xl font-semibold ${truncate ? "truncate" : ""} ${className ?? ""}`} title={String(value)}>
        {value}
      </p>
    </div>
  );
}
