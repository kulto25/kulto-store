import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // En algunas instalaciones de Windows el watcher nativo de archivos
      // falla con "UNKNOWN"/"errno -4094" por antivirus, backups en segundo
      // plano, etc. Usar polling evita ese error.
      usePolling: true,
    },
  },
});
