"use server";

export default async function fetchJobStats(
  invoiceIds: string[],
  batchId: string,
) {
  try {
    const { createClient } = await import("@/lib/supabase/server");
    const { revalidatePath } = await import("next/cache");

    const supabase = await createClient();

    if (invoiceIds.length === 0) {
      return {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
      };
    }

    const { data: jobs, error } = await supabase
      .from("jobs")
      .select("status")
      .in("invoice_id", invoiceIds);

    if (error) {
      console.error("Error fetching jobs:", error);
      return {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
      };
    }

    const stats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };

    if (jobs) {
      jobs.forEach((job) => {
        if (job.status === "pending") stats.pending++;
        else if (job.status === "processing") stats.processing++;
        else if (job.status === "completed") stats.completed++;
        else if (job.status === "failed") stats.failed++;
      });
    }

    // Revalidate the current path when job stats are fetched
    revalidatePath(`/`);

    return stats;
  } catch (error) {
    console.error("Error in fetchJobStats server action:", error);
    return {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };
  }
}
