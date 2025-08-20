export type EventHandler<T = unknown> = (payload: T) => void;

export class EventBus {
  private handlers: Record<string, EventHandler[]> = {};

  on<T = unknown>(event: string, handler: EventHandler<T>): void {
    (this.handlers[event] ||= []).push(handler as EventHandler);
  }

  emit<T = unknown>(event: string, payload: T): void {
    (this.handlers[event] || []).forEach(h => h(payload));
  }
}
