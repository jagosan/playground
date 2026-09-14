import { LunarServer, DEFAULT_PORT, DEFAULT_WS_PATH } from './LunarServer';

async function main() {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const host = process.env.HOST || '0.0.0.0';
  const dbPath = process.env.DB_PATH || './lunarfrontier.db';

  const server = new LunarServer({
    port,
    host,
    dbPath,
    logger: true,
  });

  const url = await server.start();
  console.log(`🚀 Lunar Frontier authoritative shard listening at ${url}`);
  console.log(`   WebSocket surface: ${url.replace('http', 'ws')}${DEFAULT_WS_PATH}`);
  console.log(`   Database: ${dbPath}`);

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down LunarServer cleanly...`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error starting LunarServer:', err);
  process.exit(1);
});
