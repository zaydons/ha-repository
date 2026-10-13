// In-memory result store: one StatusResult and one WidgetResult per tile.
// Written by the scheduler (WS2), read by the state API.
import type { StateSnapshot, StatusResult, WidgetResult } from "./types.ts";

export class Store {
  private status = new Map<string, StatusResult>();
  private widgets = new Map<string, WidgetResult>();
  private refreshing = false;

  setStatus(tileId: string, result: StatusResult): void {
    this.status.set(tileId, result);
  }

  getStatus(tileId: string): StatusResult | undefined {
    return this.status.get(tileId);
  }

  setWidget(tileId: string, result: WidgetResult): void {
    this.widgets.set(tileId, result);
  }

  getWidget(tileId: string): WidgetResult | undefined {
    return this.widgets.get(tileId);
  }

  /** Drop results for tiles that no longer exist (or whose check/widget changed). */
  retain(tileIds: ReadonlySet<string>): void {
    for (const id of this.status.keys()) if (!tileIds.has(id)) this.status.delete(id);
    for (const id of this.widgets.keys()) if (!tileIds.has(id)) this.widgets.delete(id);
  }

  deleteTile(tileId: string): void {
    this.status.delete(tileId);
    this.widgets.delete(tileId);
  }

  setRefreshing(value: boolean): void {
    this.refreshing = value;
  }

  isRefreshing(): boolean {
    return this.refreshing;
  }

  /** A detached copy; rev is filled in by the API layer. */
  snapshot(now: Date = new Date()): Omit<StateSnapshot, "rev"> {
    return {
      now: now.toISOString(),
      refreshing: this.refreshing,
      status: structuredClone(Object.fromEntries(this.status)),
      widgets: structuredClone(Object.fromEntries(this.widgets)),
    };
  }
}
