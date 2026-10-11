import * as React from "react";
import type { DailyStatItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * 每日入库/删除流量图（分组柱状图）。
 * 配色取自已验证的分类色板 slot1/slot2，浅色/深色双模式均通过六项检查；
 * 两系列固定“新增=蓝 / 删除=橙”，不随数值或排序重绘。
 */

const SERIES = [
  { key: "created_count", label: "新增", light: "#2a78d6", dark: "#3987e5" },
  { key: "deleted_count", label: "删除", light: "#eb6834", dark: "#d95926" },
] as const;

function useIsDark() {
  const [dark, setDark] = React.useState(() => document.documentElement.classList.contains("dark"));
  React.useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** 刻度取整：0 / 5 / 10 … */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return Math.ceil(value / magnitude) * magnitude;
}

interface DailyFlowChartProps {
  items: DailyStatItem[];
  className?: string;
}

export function DailyFlowChart({ items, className }: DailyFlowChartProps) {
  const dark = useIsDark();
  const [hover, setHover] = React.useState<number | null>(null);
  const [showTable, setShowTable] = React.useState(false);

  const colors = SERIES.map((series) => (dark ? series.dark : series.light));
  const gridColor = dark ? "#2c3a4d" : "#e1e0d9";

  const maxValue = niceMax(Math.max(1, ...items.flatMap((item) => [item.created_count, item.deleted_count])));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(maxValue * ratio));

  if (!items.length) {
    return (
      <div className={cn("flex h-56 items-center justify-center text-sm text-muted-foreground", className)}>
        暂无每日流量数据
      </div>
    );
  }

  // 布局：内边距 + 绘图区；柱组均分宽度
  const width = 720;
  const height = 240;
  const padding = { top: 12, right: 12, bottom: 30, left: 40 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const band = plotWidth / items.length;
  const barWidth = Math.min(10, Math.max(3, band / 2.6));
  const gap = 2; // 表面间隙：相邻柱之间用背景色分隔

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* 图例：两系列必须存在，颜色块 + 文字用文本色 */}
        <div className="flex items-center gap-4">
          {SERIES.map((series, index) => (
            <div key={series.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className="inline-block size-2.5 rounded-[2px]"
                style={{ backgroundColor: colors[index] }}
                aria-hidden
              />
              {series.label}
            </div>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((value) => !value)}>
          {showTable ? "图表" : "表格"}
        </Button>
      </div>

      {showTable ? (
        <div className="max-h-64 overflow-y-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>日期</TableHead>
                <TableHead className="text-right">新增</TableHead>
                <TableHead className="text-right">删除</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.day}>
                  <TableCell className="tabular-nums">{item.day}</TableCell>
                  <TableCell className="text-right tabular-nums">{item.created_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{item.deleted_count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full"
            role="img"
            aria-label="每日对象新增与删除数量"
          >
            {/* 网格线：发丝线、实线、退后一步的灰 */}
            {ticks.map((tick) => {
              const y = padding.top + plotHeight - (tick / maxValue) * plotHeight;
              return (
                <g key={tick}>
                  <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke={gridColor} strokeWidth={1} />
                  <text x={padding.left - 6} y={y + 3} textAnchor="end" fontSize={10} fill={dark ? "#898781" : "#898781"}>
                    {tick}
                  </text>
                </g>
              );
            })}
            {/* 基线 */}
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={padding.top + plotHeight}
              y2={padding.top + plotHeight}
              stroke={dark ? "#383835" : "#c3c2b7"}
              strokeWidth={1}
            />

            {items.map((item, index) => {
              const values = [item.created_count, item.deleted_count];
              const groupX = padding.left + index * band;
              const totalBarsWidth = barWidth * 2 + gap;
              const startX = groupX + (band - totalBarsWidth) / 2;
              return (
                <g key={item.day}>
                  {values.map((value, seriesIndex) => {
                    const barHeight = (value / maxValue) * plotHeight;
                    const x = startX + seriesIndex * (barWidth + gap);
                    const y = padding.top + plotHeight - barHeight;
                    // 4px 圆角数据端（柱顶），基线端保持方角
                    const radius = Math.min(4, barWidth / 2, barHeight);
                    const path =
                      barHeight <= 0
                        ? ""
                        : `M ${x} ${padding.top + plotHeight} L ${x} ${y + radius} Q ${x} ${y} ${x + radius} ${y} L ${x + barWidth - radius} ${y} Q ${x + barWidth} ${y} ${x + barWidth} ${y + radius} L ${x + barWidth} ${padding.top + plotHeight} Z`;
                    return (
                      <g key={seriesIndex}>
                        {path ? <path d={path} fill={colors[seriesIndex]} /> : null}
                        {/* 命中区域放大到整条 band，便于悬浮 */}
                        <rect
                          x={groupX}
                          y={padding.top}
                          width={band}
                          height={plotHeight}
                          fill="transparent"
                          onMouseEnter={() => setHover(index)}
                          onMouseLeave={() => setHover((current) => (current === index ? null : current))}
                        />
                      </g>
                    );
                  })}
                  {/* 横轴标签：稀疏显示避免碰撞 */}
                  {items.length <= 14 || index % Math.ceil(items.length / 10) === 0 ? (
                    <text
                      x={groupX + band / 2}
                      y={height - 10}
                      textAnchor="middle"
                      fontSize={10}
                      fill={dark ? "#898781" : "#898781"}
                    >
                      {item.day.slice(5)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>

          {/* 悬浮提示：按日显示两系列数值 */}
          {hover !== null && items[hover] ? (
            <div
              className="pointer-events-none absolute z-10 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
              style={{
                left: `calc(${((padding.left + hover * band + band / 2) / width) * 100}% )`,
                top: 8,
                transform: "translateX(-50%)",
              }}
            >
              <div className="mb-1 font-medium">{items[hover].day}</div>
              {SERIES.map((series, index) => (
                <div key={series.key} className="flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-[2px]" style={{ backgroundColor: colors[index] }} />
                  <span className="text-muted-foreground">{series.label}</span>
                  <span className="ml-auto pl-3 font-medium tabular-nums">
                    {series.key === "created_count" ? items[hover].created_count : items[hover].deleted_count}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        横轴：日期（MM-DD） · 纵轴：对象数 · 同日相邻柱以 2px 表面间隙分隔
      </p>
    </div>
  );
}
