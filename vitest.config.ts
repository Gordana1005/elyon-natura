import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Edge-function tests may import only the functions' dependency-free
    // modules — Node cannot resolve deno.land/esm.sh imports or Deno globals.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "supabase/functions/**/*.test.ts"],
    // Tests never talk to a real project: any module that transitively imports
    // src/integrations/supabase/client.ts gets a placeholder URL/key, so the
    // suite passes without a developer's .env (CI sets these only for the build
    // step — overviewModel.test.ts failed on every push from 7c462cf to d91b0a9)
    // and an accidental network call can never reach the live database.
    env: {
      VITE_SUPABASE_URL: "https://placeholder.supabase.co",
      VITE_SUPABASE_PROJECT_ID: "placeholder",
      VITE_SUPABASE_PUBLISHABLE_KEY: "placeholder",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
