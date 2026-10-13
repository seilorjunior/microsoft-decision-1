import { AppError } from './decision.js';

export function createInferenceQueue(intervalMs, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, limit = 2 } = {}) {
  const pending = [];
  let active = false;
  let nextStart = 0;
  let timer;
  let stopped = false;
  function pump() {
    if (active || stopped || !pending.length) return;
    clearTimer(timer);
    const wait = Math.max(0, nextStart - now());
    if (wait) {
      timer = setTimer(pump, wait);
      return;
    }
    const entry = pending.shift();
    active = true;
    nextStart = now() + intervalMs;
    entry.started = true;
    Promise.resolve().then(() => {
      entry.signal?.throwIfAborted();
      return entry.work(entry.signal);
    }).then(entry.resolve, entry.reject).finally(() => {
      entry.signal?.removeEventListener('abort', entry.cancel);
      active = false;
      pump();
    });
  }
  return {
    status() {
      return { active, pending: pending.length, nextStartInMs: Math.max(0, nextStart - now()), intervalMs, limit };
    },
    defer(milliseconds) {
      nextStart = Math.max(nextStart, now() + milliseconds);
    },
    run(work, signal) {
      if (stopped) return Promise.reject(new AppError('Server is shutting down.', 503));
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (pending.length >= limit) return Promise.reject(new AppError('Inference queue is full. Try again later.', 429));
      return new Promise((resolve, reject) => {
        const entry = { work, signal, resolve, reject, started: false };
        entry.cancel = () => {
          if (entry.started) return;
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          signal?.removeEventListener('abort', entry.cancel);
          reject(signal.reason);
          pump();
        };
        signal?.addEventListener('abort', entry.cancel, { once: true });
        pending.push(entry);
        pump();
      });
    },
    stop() {
      stopped = true;
      clearTimer(timer);
      for (const entry of pending.splice(0)) {
        entry.signal?.removeEventListener('abort', entry.cancel);
        entry.reject(new AppError('Server is shutting down.', 503));
      }
    },
  };
}
