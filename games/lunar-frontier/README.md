# Lunar Frontier

This is a multi-agent orchestration of a persistent economy and multiplayer simulation running in the browser with a Fastify backend, WebSocket server, and SQLite persistence.

## Overview

A persistent lunar economy and multiplayer simulation with:

1. **Babylon.js 3D engine** client
2. **Fastify + WebSocket** server
3. **SQLite** database
4. **EVA suit + buggy** vehicles and entities

## Architecture

```mermaid
graph TD
    subgraph Browser Client
        EVA_Suit_Controller
        Open_Buggy_Controller
        Tunnel_Renderer
    end

    subgraph Fastify WebSocket Server
        Server_Main
        WebSocket_Manager
        Simulation_20Hz
        Market_Engine
    end

    subgraph Persistence
        SQLite
    end

    EVA_Suit_Controller --> WebSocket_Manager
    Open_Buggy_Controller --> WebSocket_Manager
    Tunnel_Renderer --> WebSocket_Manager

    WebSocket_Manager --> Simulation_20Hz
    Simulation_20Hz --> Market_Engine
    Market_Economy --> SQLite
    Market_Engine --> Simulation_20Hz
    Simulation_20Hz --> SQLite

```

## Directories

### `/src`
- `entities/` - EVA suit controller, buggy, and vehicle
- `engine/` - 3D rendering engine (Babylon.js)
- `server/` - Fastify WebSocket server

### `/docs`
- Architecture
- Deployment
- API

### `/specs`
- Design specs
- ADRs