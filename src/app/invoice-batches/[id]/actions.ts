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

    // `.in("invoice_id", ids)` builds a GET request with every ID in the
    // query string — for a batch with thousands of invoices this exceeds
    // typical proxy/CDN URL length limits (414 Request-URI Too Large).
    // Chunking keeps each request's URL small regardless of batch size.
    const CHUNK_SIZE = 200;
    const chunks: string[][] = [];
    for (let i = 0; i < invoiceIds.length; i += CHUNK_SIZE) {
      chunks.push(invoiceIds.slice(i, i + CHUNK_SIZE));
    }

    const results = await Promise.all(
      chunks.map((chunk) =>
        supabase.from("jobs").select("status").in("invoice_id", chunk),
      ),
    );

    const firstError = results.find((r) => r.error)?.error;
    if (firstError) {
      console.error("Error fetching jobs:", firstError);
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

    for (const { data: jobs } of results) {
      (jobs || []).forEach((job) => {
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
