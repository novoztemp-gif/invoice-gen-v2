"use client";

import { format } from "date-fns";
import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/client";

type Job = {
  id: string;
  invoice_id: string;
  status: string;
  worker_id: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, any> | null;
  payload: Record<string, any> | null;
};

export default function JobsMonitoring() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchJobs = async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Error fetching jobs:", error);
        alert("Failed to load jobs.");
        return;
      }

      setJobs(data || []);
    } catch (error) {
      console.error("Error:", error);
      alert("An error occurred while loading jobs.");
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchJobs();
    setRefreshing(false);
  };

  useEffect(() => {
    fetchJobs();
  }, []);

  const getStatusBadge = (status: string) => {
    const statusColors: Record<
      string,
      "default" | "secondary" | "destructive" | "outline"
    > = {
      pending: "secondary",
      processing: "secondary",
      completed: "default",
      failed: "destructive",
      success: "default",
    };

    return (
      <Badge variant={statusColors[status] || "outline"}>
        {status.toUpperCase()}
      </Badge>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-slate-900">Jobs Monitoring</h1>
        <Button onClick={handleRefresh} disabled={refreshing} variant="outline">
          {refreshing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Refreshing...
            </>
          ) : (
            <>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </>
          )}
        </Button>
      </div>

      {/* Jobs Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Jobs ({jobs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <p className="text-lg">No jobs found.</p>
              <p className="text-sm mt-2">
                Jobs will appear here when invoice processing is triggered.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job ID</TableHead>
                    <TableHead>Invoice ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Worker ID</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead>Updated At</TableHead>
                    <TableHead>Metadata</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell className="font-mono text-sm">
                        {job.id.substring(0, 8)}...
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {job.invoice_id.substring(0, 8)}...
                      </TableCell>
                      <TableCell>{getStatusBadge(job.status)}</TableCell>
                      <TableCell className="text-slate-500">
                        {job.worker_id ? (
                          <span className="font-mono text-sm">
                            {job.worker_id.substring(0, 8)}...
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {format(
                          new Date(job.created_at),
                          "dd/MM/yyyy HH:mm:ss",
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {format(
                          new Date(job.updated_at),
                          "dd/MM/yyyy HH:mm:ss",
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="text-xs">
                          {job.metadata ? (
                            <details className="cursor-pointer group">
                              <summary className="text-blue-600 hover:text-blue-800">
                                View Metadata
                              </summary>
                              <div className="mt-2 p-2 bg-slate-100 rounded text-slate-700 max-h-40 overflow-auto">
                                <pre className="text-xs whitespace-pre-wrap break-words">
                                  {JSON.stringify(job.metadata, null, 2)}
                                </pre>
                              </div>
                            </details>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Statistics */}
      {jobs.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            {
              label: "Total Jobs",
              value: jobs.length,
              color: "text-slate-600",
            },
            {
              label: "Pending",
              value: jobs.filter((j) => j.status === "pending").length,
              color: "text-yellow-600",
            },
            {
              label: "Completed",
              value: jobs.filter((j) => j.status === "completed").length,
              color: "text-green-600",
            },
            {
              label: "Failed",
              value: jobs.filter((j) => j.status === "failed").length,
              color: "text-red-600",
            },
          ].map((stat) => (
            <Card key={stat.label}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-slate-500">
                  {stat.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className={`text-2xl font-bold ${stat.color}`}>
                  {stat.value}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
