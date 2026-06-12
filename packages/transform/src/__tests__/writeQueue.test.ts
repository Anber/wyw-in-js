import { EventEmitter } from 'events';

import { createWriteQueue, writeToStream } from '../eval/writeQueue';

class MockWritable extends EventEmitter {
  public readonly writes: string[] = [];

  private readonly returnValues: boolean[] = [];

  private readonly callbacks: Array<
    ((error?: Error | null) => void) | undefined
  > = [];

  public pushWriteResult(returnValue: boolean) {
    this.returnValues.push(returnValue);
  }

  public completeWrite(index: number, error?: Error) {
    this.callbacks[index]?.(error ?? null);
  }

  public write(chunk: string, callback?: (error?: Error | null) => void) {
    this.writes.push(chunk);
    this.callbacks.push(callback);
    return this.returnValues.shift() ?? true;
  }
}

describe('write queue', () => {
  it('waits for drain after a backpressured write', async () => {
    const stream = new MockWritable();
    stream.pushWriteResult(false);

    let settled = false;
    const task = writeToStream(stream, 'payload', 'test stream').then(() => {
      settled = true;
    });

    expect(stream.writes).toEqual(['payload']);

    stream.completeWrite(0);
    await Promise.resolve();
    expect(settled).toBe(false);

    stream.emit('drain');
    await task;

    expect(settled).toBe(true);
  });

  it('serializes queued writes across backpressure boundaries', async () => {
    const stream = new MockWritable();
    stream.pushWriteResult(false);
    stream.pushWriteResult(true);

    const queue = createWriteQueue(stream, 'test stream');
    const first = queue.write('first');
    const second = queue.write('second');

    await Promise.resolve();
    expect(stream.writes).toEqual(['first']);

    stream.completeWrite(0);
    await Promise.resolve();
    expect(stream.writes).toEqual(['first']);

    stream.emit('drain');
    await first;
    await Promise.resolve();
    expect(stream.writes).toEqual(['first', 'second']);

    stream.completeWrite(1);
    await Promise.all([second, queue.onIdle()]);
  });
});
