import vinext from "vinext";
import { defineConfig } from "vite";
export default defineConfig({
  server:
    process.env.CODEX_SANDBOX === "seatbelt"
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
  plugins: [vinext()],
});
