"use client";

import { Building2, FileText, Package, TrendingUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setError(error.message);
      } else {
        router.push("/");
        router.refresh();
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Left Side - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-slate-900 p-12 flex-col justify-between">
        <div>
          <div className="flex items-center gap-2 text-white mb-8">
            <FileText className="h-8 w-8" />
            <h1 className="text-2xl font-semibold">BOA for INVOICES</h1>
          </div>
          <p className="text-slate-300 text-lg mb-12 max-w-md">
            Back Office Application to Create and Manage Invoices.
          </p>

          <div className="space-y-6 max-w-md">
            <div className="flex items-start gap-4">
              <div className="bg-slate-800 p-3 rounded-lg">
                <FileText className="h-5 w-5 text-slate-300" />
              </div>
              <div>
                <h3 className="text-white font-medium mb-1">
                  Batch Processing
                </h3>
                <p className="text-sm text-slate-400">
                  Generate multiple invoices at once with intelligent splitting
                  and distribution
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="bg-slate-800 p-3 rounded-lg">
                <Building2 className="h-5 w-5 text-slate-300" />
              </div>
              <div>
                <h3 className="text-white font-medium mb-1">
                  Company Management
                </h3>
                <p className="text-sm text-slate-400">
                  Manage issuing companies and receiving customers with complete
                  business details
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="bg-slate-800 p-3 rounded-lg">
                <Package className="h-5 w-5 text-slate-300" />
              </div>
              <div>
                <h3 className="text-white font-medium mb-1">Product Catalog</h3>
                <p className="text-sm text-slate-400">
                  Configure products with HSN codes and flexible pricing ranges
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="bg-slate-800 p-3 rounded-lg">
                <TrendingUp className="h-5 w-5 text-slate-300" />
              </div>
              <div>
                <h3 className="text-white font-medium mb-1">
                  Smart Distribution
                </h3>
                <p className="text-sm text-slate-400">
                  Automatic amount distribution with organic randomization
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="text-sm text-slate-500">© 2025 Novoz Infinity</div>
      </div>

      {/* Right Side - Login Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8">
        <div className="w-full max-w-md">
          {/* Mobile Logo */}
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <FileText className="h-7 w-7 text-slate-900" />
            <h1 className="text-xl font-semibold text-slate-900">
              Invoice Generator
            </h1>
          </div>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="space-y-1 pb-6">
              <CardTitle className="text-2xl font-semibold text-slate-900">
                Sign In
              </CardTitle>
              <p className="text-sm text-slate-600">
                Enter your credentials to access your account
              </p>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-slate-700">
                    Email Address
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="name@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={loading}
                    className="h-11"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password" className="text-slate-700">
                    Password
                  </Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={loading}
                    className="h-11"
                  />
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
                    {error}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full h-11 text-base"
                  disabled={loading}
                >
                  {loading ? "Signing in..." : "Sign In"}
                </Button>
              </form>

              <div className="mt-6 text-center">
                <p className="text-xs text-slate-500">
                  Contact the admin for account access.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
