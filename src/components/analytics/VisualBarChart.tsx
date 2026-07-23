"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface DataPoint {
  label: string;
  value: number;
  value2?: number;
  color?: string;
  color2?: string;
}

interface VisualBarChartProps {
  title: string;
  subtitle?: string;
  data: DataPoint[];
  legend1?: string;
  legend2?: string;
  valuePrefix?: string;
  valueSuffix?: string;
  height?: number;
}

export function VisualBarChart({
  title,
  subtitle,
  data,
  legend1 = "Value",
  legend2,
  valuePrefix = "₹",
  valueSuffix = "",
  height = 180,
}: VisualBarChartProps) {
  const maxValue = React.useMemo(() => {
    if (!data || data.length === 0) return 1;
    return Math.max(
      ...data.map((d) => Math.max(d.value || 0, d.value2 || 0)),
      1,
    );
  }, [data]);

  const formatVal = (val: number) => {
    if (valuePrefix === "₹") {
      return `₹${val.toLocaleString("en-IN")}${valueSuffix}`;
    }
    return `${val.toLocaleString("en-IN")}${valueSuffix}`;
  };

  return (
    <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
      <CardHeader className="p-3.5 pb-2 flex flex-row items-center justify-between border-b border-slate-100">
        <div>
          <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
            {title}
          </CardTitle>
          {subtitle && (
            <p className="text-[11px] text-slate-500 font-normal mt-0.5">
              {subtitle}
            </p>
          )}
        </div>

        {legend2 && (
          <div className="flex items-center gap-3 text-[11px]">
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-xs bg-slate-700 inline-block" />
              <span className="text-slate-600 font-medium">{legend1}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-xs bg-slate-400 inline-block" />
              <span className="text-slate-600 font-medium">{legend2}</span>
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="p-3.5 pt-3">
        {data.length === 0 ? (
          <div
            className="flex items-center justify-center text-xs text-slate-400 font-medium"
            style={{ height }}
          >
            No data available
          </div>
        ) : (
          <div className="space-y-2.5" style={{ minHeight: height }}>
            {data.map((item, idx) => {
              const pct1 = Math.min(
                100,
                Math.round(((item.value || 0) / maxValue) * 100),
              );
              const pct2 =
                item.value2 !== undefined
                  ? Math.min(
                      100,
                      Math.round(((item.value2 || 0) / maxValue) * 100),
                    )
                  : 0;

              return (
                <div key={idx} className="space-y-0.5">
                  <div className="flex justify-between text-xs">
                    <span className="font-medium text-slate-700 truncate max-w-[180px]">
                      {item.label}
                    </span>
                    <div className="flex gap-2 font-mono text-[11px]">
                      <span className="text-slate-900 font-semibold">
                        {formatVal(item.value)}
                      </span>
                      {item.value2 !== undefined && (
                        <span className="text-slate-500">
                          / {formatVal(item.value2)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="w-full bg-slate-100 rounded-xs h-1.5 flex overflow-hidden">
                    <div
                      className={item.color || "bg-slate-700"}
                      style={{ width: `${pct1}%` }}
                    />
                    {item.value2 !== undefined && (
                      <div
                        className={item.color2 || "bg-slate-400"}
                        style={{ width: `${pct2}%` }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
