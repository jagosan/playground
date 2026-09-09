// Lunar Frontier Server Implementation
import Fastify, { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { createServer } from 'http';

const server: FastifyInstance = Fastify();
const wsServer = createServer(server.server);

// Register WebSocket handlers
server.register(import('fastify-websocket'));

// Serve static assets
server.register(import('fastify-static'), {
  root: 'public',
});

// Add routes
server.get('/', (req, res) => {
  res.type('text/html').send('<h1>Lunar Frontier Server</h1>');
});

// Start the server
const PORT = 8092;

server.listen(PORT, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Lunar Frontier server is running on port ${PORT}`);
});