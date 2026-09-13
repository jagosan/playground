/**
 * Lunar Frontier — prospect-node traversal controller (Spec 12/13,
 * TASK-PLAY-054 touch-up).
 *
 * The original skeleton imported `../database/TraversalNode`, a module that
 * never existed, and its `findNodeById` was a stub that always returned null.
 * This rewrite keeps the original public surface (`traverseTo`, `goBack`,
 * `getCurrentNode`) while making the controller actually functional and,
 * crucially, import-safe: no phantom modules, no Babylon, no Node — pure
 * graph bookkeeping over whatever node list the caller provides.
 *
 * Nodes are the frontier's functional places (`LunarNode`s from the world
 * snapshot: refineries, docks, outposts, shaft heads, caverns, junctions),
 * linked by tunnel / surface / rail edges. `ClientApp` uses it for the
 * "next waypoint" HUD line and for future auto-pilot work.
 */

/** Physical location, metres (x, y lateral, z up — codebase convention). */
export interface TraversalPosition {
  x: number;
  y: number;
  z: number;
}

/** What a node *is* (mirrors `LunarWorldGenerator`'s NodeKind vocabulary). */
export type TraversalNodeKind =
  | 'refinery'
  | 'dock'
  | 'outpost'
  | 'shaft_head'
  | 'cavern'
  | 'junction';

/** A routable place on the lunar frontier. */
export interface TraversalNode {
  id: string;
  kind: TraversalNodeKind | string;
  name: string;
  position: TraversalPosition;
  /** Ids this node can be reached from / travelled to directly. */
  links: string[];
}

export interface NearestNodeResult extends TraversalNode {
  /** Straight-line metres from the query point to the node. */
  distance: number;
}

/** Structural view of a `WorldSnapshot` — enough to build the graph from. */
export interface TraversalGraphSource {
  nodes: Array<{
    id: string;
    kind: string;
    name: string;
    position: { x: number; y: number; z: number };
  }>;
  tunnels?: Array<{ fromId: string; toId: string }>;
  /** `RailRoute.nodeIds` — an ordered terminal-to-terminal chain. */
  railRoutes?: Array<{ nodeIds?: string[] }>;
}

export interface TraversalControllerOptions {
  /** Start here when no explicit node is given. */
  startAt?: { x: number; y: number; z?: number };
}

function distance3(a: TraversalPosition, b: TraversalPosition): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

export class TraversalController {
  private currentNode: TraversalNode;
  private readonly history: TraversalNode[];
  private readonly index: Map<string, TraversalNode>;

  constructor(startNode: TraversalNode, graph: TraversalNode[] = [startNode]) {
    if (startNode === null || startNode === undefined) {
      throw new Error('TraversalController: a start node is required');
    }
    this.index = new Map();
    for (const node of graph) this.index.set(node.id, node);
    // The start node always resolves, even when absent from the graph list.
    if (!this.index.has(startNode.id)) this.index.set(startNode.id, startNode);
    this.currentNode = startNode;
    this.history = [startNode];
  }

  /**
   * Build a controller from a `LunarWorldGenerator` snapshot: every node
   * becomes a graph vertex, every tunnel segment and rail route an undirected
   * edge. The start node is whichever generated node sits closest to
   * `options.startAt` (or the first node at all).
   */
  static fromSnapshot(
    snapshot: TraversalGraphSource,
    options: TraversalControllerOptions = {},
  ): TraversalController {
    const nodes: TraversalNode[] = snapshot.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      name: node.name,
      position: { x: node.position.x, y: node.position.y, z: node.position.z },
      links: [],
    }));
    const index = new Map<string, TraversalNode>(nodes.map((n) => [n.id, n]));

    const link = (a: string | undefined, b: string | undefined): void => {
      if (a === undefined || b === undefined) return;
      const na = index.get(a);
      const nb = index.get(b);
      if (na === undefined || nb === undefined || a === b) return;
      if (!na.links.includes(b)) na.links.push(b);
      if (!nb.links.includes(a)) nb.links.push(a);
    };

    for (const segment of snapshot.tunnels ?? []) link(segment.fromId, segment.toId);
    for (const route of snapshot.railRoutes ?? []) {
      const chain = route.nodeIds ?? [];
      for (let i = 1; i < chain.length; i++) link(chain[i - 1], chain[i]);
    }

    let start = nodes[0];
    if (start === undefined) {
      // Degenerate world (no nodes): synthesise an anchor so the controller
      // is always constructible and the HUD always has something to show.
      const origin = options.startAt ?? { x: 0, y: 0, z: 0 };
      start = {
        id: 'origin',
        kind: 'junction',
        name: 'Datum Plain',
        position: { x: origin.x, y: origin.y, z: origin.z ?? 0 },
        links: [],
      };
      index.set(start.id, start);
    } else if (options.startAt !== undefined) {
      const nearest = this.nearestIn(nodes, {
        x: options.startAt.x,
        y: options.startAt.y,
        z: options.startAt.z ?? 0,
      });
      if (nearest !== undefined) start = nearest;
    }
    return new TraversalController(start, [...index.values()]);
  }

  // -- navigation ------------------------------------------------------------------

  /** Jump the waypoint to `nodeId` (pushes travel history). */
  public traverseTo(nodeId: string): boolean {
    const node = this.findNodeById(nodeId);
    if (node === null) return false;
    this.currentNode = node;
    this.history.push(node);
    return true;
  }

  /** Rewind to the previous waypoint. */
  public goBack(): boolean {
    if (this.history.length > 1) {
      this.history.pop();
      this.currentNode = this.history[this.history.length - 1];
      return true;
    }
    return false;
  }

  public getCurrentNode(): TraversalNode {
    return this.currentNode;
  }

  /** Travel log, oldest first. */
  public getHistory(): TraversalNode[] {
    return [...this.history];
  }

  /** Every registered node id. */
  public nodeIds(): string[] {
    return [...this.index.keys()];
  }

  public nodeCount(): number {
    return this.index.size;
  }

  /** Closest registered node to a point (HUD waypoint line). */
  public nearestNode(point: {
    x: number;
    y: number;
    z?: number;
  }): NearestNodeResult | undefined {
    return TraversalController.nearestIn([...this.index.values()], {
      x: point.x,
      y: point.y,
      z: point.z ?? 0,
    });
  }

  /**
   * Breadth-first route over the link graph (unweighted hops). Returns the
   * node ids from the current waypoint to `destinationId` inclusive, or null
   * when the destination is unreachable / unknown.
   */
  public routeTo(destinationId: string): string[] | null {
    const destination = this.findNodeById(destinationId);
    if (destination === null) return null;
    const startId = this.currentNode.id;
    if (startId === destination.id) return [startId];

    const previous = new Map<string, string>();
    const queue: string[] = [startId];
    const seen = new Set<string>([startId]);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (id === destination.id) {
        const path: string[] = [id];
        let cursor = id;
        while (previous.has(cursor)) {
          cursor = previous.get(cursor) as string;
          path.unshift(cursor);
        }
        return path;
      }
      for (const next of this.index.get(id)?.links ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          previous.set(next, id);
          queue.push(next);
        }
      }
    }
    return null;
  }

  private findNodeById(nodeId: string): TraversalNode | null {
    if (typeof nodeId !== 'string') return null;
    return this.index.get(nodeId) ?? null;
  }

  private static nearestIn(
    nodes: TraversalNode[],
    point: TraversalPosition,
  ): NearestNodeResult | undefined {
    let best: TraversalNode | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const node of nodes) {
      const d = distance3(node.position, point);
      if (d < bestDistance) {
        bestDistance = d;
        best = node;
      }
    }
    return best === undefined ? undefined : { ...best, distance: bestDistance };
  }
}

export default TraversalController;
