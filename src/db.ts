import { Client } from 'pg';
import type { MiddlewareHandler } from 'hono';

export type Env = {
  HYPERDRIVE: Hyperdrive;
  ASSETS: Fetcher;
};

export type AppVariables = {
  db: Client;
  user: {
    id: string;
    name: string;
    username: string;
    role: 'ADMIN' | 'CASHIER';
  };
};

export const databaseMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (context, next) => {
  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  });

  try {
    await client.connect();

    context.set('db', client);

    await next();
  } catch (error) {
    console.error('Database error:', error);

    return context.json(
      { error: 'Database unavailable. Check the Neon connection.' },
      503
    );
  } finally {
    await client.end();
  }
};