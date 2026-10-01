import { Hono } from 'hono';
import { databaseMiddleware, type AppVariables, type Env } from './db';
import authRoutes from './auth-routes';
import catalogRoutes from './catalog-routes';
import salesRoutes from './sales-routes';
import managementRoutes from './management-routes';
import { requireSameOrigin } from './security';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use('*', async (context, next) => {
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('X-Frame-Options', 'DENY');
  context.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  context.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  await next();
});

// This route is intentionally before database middleware
app.get('/api/health', (context) =>
  context.json({
    status: 'ok',
    service: 'rotich-pos-api',
  }),
);

app.use('/api/*', requireSameOrigin);
app.use('/api/*', async (context, next) => {
  if (new URL(context.req.url).pathname === '/api/health') {
    await next();
    return;
  }

  await databaseMiddleware(context, next);
});
app.get('/health', (context) =>
  context.json({
    status: 'ok',
    service: 'rotich-pos-api',
  }),
);
app.route('/api', authRoutes);
app.route('/api', catalogRoutes);
app.route('/api', salesRoutes);
app.route('/api', managementRoutes);

app.all('/api/*', (context) =>
  context.json({ error: 'API route not found.' }, 404)
);

app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw));

export default app;