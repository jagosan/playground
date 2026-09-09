// Lunar Frontier Main Entry Point
import express from 'express';
import WebSocket from 'ws';
import sqlite3 from 'sqlite3';

const app = express();
const PORT = 8092;

// Initialize the database
const db = new sqlite3.Database('./lunarfrontier.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the lunar frontier database.');
  }
});

// Setup WebSocket server
const wss = new WebSocket.Server({ port: 8092 });

wss.on('connection', (ws) => {
  console.log('New client connected to lunar frontier server.');

  ws.on('message', (message) => {
    console.log('Received:', message.toString());
  });

  ws.send('Connected to lunar frontier server.');
});

// Route to get current frontier status
app.get('/', (req, res) => {
  res.send('Lunar Frontier Server is running.');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Lunar Frontier server is running on port ${PORT}`);
});