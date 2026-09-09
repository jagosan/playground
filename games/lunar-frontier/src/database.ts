// Database Schema for Lunar Frontier
import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./lunarfrontier.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the lunarfrontier database.');
  }
});

// Create tables if they don't exist
db.serialize(() => {
  // Players and inventories
  db.run(`CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    role TEXT,
    balance REAL,
    last_login TIMESTAMP
  )`);

  // Vehicles and mounts
  db.run(`CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER,
    type TEXT,
    name TEXT,
    location_x REAL,
    location_y REAL,
    health REAL,
    FOREIGN KEY (player_id) REFERENCES players (id)
  )`);

  // Tunnel nodes and ore veins
  db.run(`CREATE TABLE IF NOT EXISTS tunnel_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    location_x REAL,
    location_y REAL,
    ore_vein_type TEXT,
    ore_quantity REAL,
    status TEXT
  )`);

  // Rail network
  db.run(`CREATE TABLE IF NOT EXISTS rail_network (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_from INTEGER,
    node_to INTEGER,
    distance REAL,
    FOREIGN KEY (node_from) REFERENCES tunnel_nodes (id),
    FOREIGN KEY (node_to) REFERENCES tunnel_nodes (id)
  )`);

  // Market and faction standing
  db.run(`CREATE TABLE IF NOT EXISTS market (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name TEXT,
    price REAL,
    quantity REAL,
    faction TEXT,
    location TEXT
  )`);
});

export { db };