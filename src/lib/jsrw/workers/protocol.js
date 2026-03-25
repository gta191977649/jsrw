export const WORKER_CHANNEL = Object.freeze({
  ASSET: 'asset',
  STREAMING: 'streaming',
  RENDER: 'render',
});

export const WORKER_MESSAGE_KIND = Object.freeze({
  REQUEST: 'request',
  RESPONSE: 'response',
  EVENT: 'event',
});

let nextWorkerRequestId = 1;

export function createWorkerRequestId() {
  const requestId = nextWorkerRequestId;
  nextWorkerRequestId += 1;
  return `${Date.now()}-${requestId}`;
}

export function createWorkerRequestMessage(channel, type, payload = null) {
  return {
    kind: WORKER_MESSAGE_KIND.REQUEST,
    channel,
    type,
    id: createWorkerRequestId(),
    payload,
  };
}

export function createWorkerResponseMessage(channel, type, id, payload = null, error = null) {
  return {
    kind: WORKER_MESSAGE_KIND.RESPONSE,
    channel,
    type,
    id,
    payload,
    error,
  };
}

export function serializeWorkerError(error) {
  if (!error) return null;
  return {
    message: String(error?.message || error),
    name: String(error?.name || 'Error'),
    stack: typeof error?.stack === 'string' ? error.stack : '',
  };
}

export function deserializeWorkerError(error) {
  if (!error) return null;
  const restored = new Error(String(error.message || 'Worker request failed'));
  restored.name = String(error.name || 'Error');
  if (error.stack) restored.stack = String(error.stack);
  return restored;
}
