import { TraversalNode } from '../database/TraversalNode';

export class TraversalController {
  private currentNode: TraversalNode;
  private history: TraversalNode[];

  constructor(startNode: TraversalNode) {
    this.currentNode = startNode;
    this.history = [startNode];
  }

  public traverseTo(nodeId: string): boolean {
    const node = this.findNodeById(nodeId);
    if (node) {
      this.currentNode = node;
      this.history.push(node);
      return true;
    }
    return false;
  }

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

  private findNodeById(nodeId: string): TraversalNode | null {
    // Implementation would depend on how nodes are stored
    return null;
  }
}