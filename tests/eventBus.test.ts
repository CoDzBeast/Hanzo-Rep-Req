import { EventBus } from '../src/eventBus';

describe('EventBus', () => {
  it('emits events to listeners', () => {
    const bus = new EventBus();
    const payloads: number[] = [];
    bus.on<number>('test', p => payloads.push(p));
    bus.emit('test', 1);
    bus.emit('test', 2);
    expect(payloads).toEqual([1, 2]);
  });
});
