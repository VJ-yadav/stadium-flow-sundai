import { defineConfig, loadEnv } from 'vite';

// In dev, serve api/*.js on the Vite server itself (same as Vercel in production), so
// `npm run dev` is all anyone needs. Server-only variables (LOCALMEM_*) come from .env.local
// into process.env here; Vite never sends non-VITE_ variables to the browser.
function apiRoutes() {
  return {
    name: 'stadium-flow-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const m = req.url && /^\/api\/([a-z-]+)(?:[?/]|$)/.exec(req.url);
        if (!m) return next();
        try {
          const mod = await server.ssrLoadModule(`/api/${m[1]}.js`);
          await mod.default(req, res);
        } catch (e) {
          if (e?.code === 'ERR_LOAD_URL' || /Failed to load url/.test(e?.message)) return next();
          console.error(`/api/${m[1]} failed:`, e?.name || 'Error');
          if (!res.headersSent) { res.statusCode = 500; res.end('{"ok":false,"error":"server error"}'); }
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), 'LOCALMEM_'));
  return { plugins: [apiRoutes()] };
});
