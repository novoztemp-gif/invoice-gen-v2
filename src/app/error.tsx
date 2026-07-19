"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-2xl font-semibold text-slate-800">
        Something went wrong!
      </h2>
      <p className="max-w-md text-sm text-slate-500">
        {error?.message ?? "An unexpected error occurred. Please try again."}
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
